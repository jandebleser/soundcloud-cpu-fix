#!/usr/bin/env node
//
// measure-repro.cjs — run tools/repro-invisible-smil.html through every wrapper
// variant and print the renderer main-thread cost of each, as a table.
//
// This replaces eyeballing the DevTools FPS meter, which is the wrong instrument
// for this bug: the meter is a compositor overlay that itself keeps frames being
// produced, and it says nothing about main-thread style/layout work. What matters
// here is how many style -> layout -> paint -> composite cycles the renderer runs
// and how much raster (i.e. actual pixels) they produce.
//
// Launches an isolated debug Chrome (throwaway --user-data-dir, own debug port —
// your real profile is untouched) and drives it over the DevTools Protocol.
//
// Usage:
//   CHROME=/opt/google/chrome/chrome NODE_PATH=$(npm root -g) \
//     node tools/measure-repro.cjs [seconds]
//
// Requires the `ws` node module on NODE_PATH.
const { spawn } = require('child_process');
const http = require('http'); const os = require('os'); const path = require('path'); const fs = require('fs');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'google-chrome';
// The debug port is chosen by Chrome (--remote-debugging-port=0) and read back
// from the profile's own DevToolsActivePort file. A fixed port is a trap: if an
// earlier debug Chrome is still alive it keeps the port, and this script then
// silently drives THAT browser — wrong build, wrong tab, wrong numbers.
let PORT = 0;
const SECS = Number(process.argv[2] || process.env.SECS || 5);
// WINDOW_POSITION=x,y and WINDOW_SIZE=w,h place the browser window on a chosen
// monitor. The bug's cost is per-vsync, so which screen the window sits on
// changes the answer: a 240 Hz panel charges 4x what a 60 Hz one does.
//
// Both are in DIP, NOT pixels — Chrome multiplies them by the device scale
// factor — and the window manager will shove the window back on screen if the
// result overflows the desktop. Get either wrong and the window silently
// straddles two monitors, which is why the run reports where it actually
// landed instead of trusting the flag.
const WINDOW_POSITION = process.env.WINDOW_POSITION || '';
const WINDOW_SIZE = process.env.WINDOW_SIZE || '';
const windowArgs = [
  ...(WINDOW_POSITION ? [`--window-position=${WINDOW_POSITION}`] : []),
  ...(WINDOW_SIZE ? [`--window-size=${WINDOW_SIZE}`] : []),
];
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-measure-'));
const REPRO = 'file://' + path.join(__dirname, 'repro-invisible-smil.html');
// SPINNERS=200 scales the repro up. Worth doing on a 60 Hz display, where the
// default 10 spinners cost a quarter of what they cost on a 240 Hz panel.
const N = Number(process.env.SPINNERS || 0);
const url = (flag) => REPRO + flag + (N ? (flag ? '&' : '?') + 'n=' + N : '');

// label -> URL flag. Order matters: control last so the table reads top-down.
const VARIANTS = [
  ['visibility:hidden; opacity:0  (what soundcloud.com ships)', ''],
  ['visibility: hidden',                                        '?vishidden'],
  ['opacity: 0',                                                '?opacity0'],
  ['fully visible',                                             '?visible'],
  ['display: none',                                             '?dnone'],
  ['no SMIL at all (control)',                                  '?off'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) =>
  http.get(`http://localhost:${PORT}${p}`, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  let id = 0; const pending = new Map(); let events = []; let onComplete = null;
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method === 'Tracing.dataCollected') {
      if (msg.params && msg.params.value) events.push(...msg.params.value);
    } else if (msg.method === 'Tracing.tracingComplete') {
      if (onComplete) onComplete();
    }
  });
  return {
    ready: new Promise((r) => ws.on('open', r)),
    send: (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    take: () => { const e = events; events = []; return e; },
    onTraceComplete: (fn) => { onComplete = fn; },
    close: () => ws.close(),
  };
}

// Renderer main threads announce themselves in trace metadata. Several may exist
// (one per renderer process); ours is the one with events in it.
function rendererMainTid(events) {
  const named = new Set();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain') named.add(e.tid);
  }
  const work = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number' || !named.has(e.tid)) continue;
    work.set(e.tid, (work.get(e.tid) || 0) + e.dur);
  }
  if (work.size) return [...work.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // No named renderer main thread in the trace: fall back to the busiest thread,
  // but say so — the numbers may not mean what they look like.
  console.warn('  ! no CrRendererMain in trace; falling back to busiest thread');
  const any = new Map();
  for (const e of events) if (e.ph === 'X' && typeof e.dur === 'number') any.set(e.tid, (any.get(e.tid) || 0) + e.dur);
  return [...any.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const evaluate = (c, expression) => c.send('Runtime.evaluate',
  { returnByValue: true, awaitPromise: true, expression }).then((r) => r.result && r.result.value);

// INVALIDATIONS=1 also tallies what dirtied style/layout, attributed to a reason
// and a node. Costs trace volume, so it's off by default.
const INVALIDATIONS = !!process.env.INVALIDATIONS;

async function measure(c, secs) {
  const categories = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'];
  if (INVALIDATIONS) categories.push('disabled-by-default-devtools.timeline.invalidationTracking');
  await c.send('Tracing.start', { traceConfig: {
    recordMode: 'recordAsMuchAsPossible',
    includedCategories: categories,
  } });
  await sleep(secs * 1000);
  const done = new Promise((r) => c.onTraceComplete(r));
  await c.send('Tracing.end'); await done;
  const events = c.take();

  // Pick the renderer main thread BY NAME. Taking "the busiest thread" instead is
  // a trap: when the animation is visible, raster threads outwork the main thread,
  // the heuristic selects one of those, and every main-thread metric comes back 0.
  const tid = rendererMainTid(events);
  const of = (name) => events.filter((e) => e.tid === tid && e.name === name);
  const ms = (list) => list.reduce((s, e) => s + (e.dur || 0), 0) / 1000;

  const frames = of('PageAnimator::serviceScriptedAnimations');
  const layout = of('LocalFrameView::performLayout');
  const style = of('Document::recalcStyle');
  const composite = of('PaintArtifactCompositor::Update');
  // RasterTask runs off the main thread — count it across every thread.
  const raster = events.filter((e) => e.name === 'RasterTask');
  const busy = ms(layout) + ms(style) + ms(composite) + ms(of('FunctionCall')) + ms(of('TimerFire'));
  const tally = new Map();
  if (INVALIDATIONS) for (const e of events) {
    if (!/InvalidationTracking/.test(e.name)) continue;
    const d = (e.args && e.args.data) || {};
    const key = `${e.name} reason=${d.reason || '?'} node=${d.nodeName || d.nodeId || '?'}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return {
    frames: frames.length, style: style.length, layout: layout.length, composite: composite.length,
    raster: raster.length, cpu: busy / (secs * 10),
    invalidations: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

// Chrome writes the port it actually bound to as the first line of this file.
async function readDevToolsPort() {
  const file = path.join(PROFILE, 'DevToolsActivePort');
  for (let i = 0; i < 60; i++) {
    try {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    } catch { /* not written yet */ }
    await sleep(500);
  }
  throw new Error(`Chrome never wrote ${file} — did it fail to start?`);
}

// Leaving debug browsers running is what caused the stale-port bug in the first
// place, so tear ours down on every exit path.
let CHILD = null;
function shutdown() {
  if (!CHILD) return;
  try { process.kill(-CHILD.pid, 'SIGTERM'); } catch { /* already gone */ }
  CHILD = null;
}
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(1); });

(async () => {
  const child = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', ...windowArgs,
    '--no-first-run', '--no-default-browser-check', url(''),
  ], { stdio: 'ignore', detached: true });   // detached: own process group, so shutdown() can kill the tree
  CHILD = child;
  child.unref();

  PORT = await readDevToolsPort();
  for (let i = 0; i < 40; i++) { try { await get('/json/version'); break; } catch { await sleep(500); } }
  console.log('Chrome:  ', (await get('/json/version')).Browser);
  console.log('Repro:   ', url(''));
  console.log('Trace:   ', SECS, 's per variant, renderer main thread\n');

  let target;
  for (let i = 0; i < 40 && !target; i++) {
    target = (await get('/json')).find((t) => t.type === 'page' && t.url.includes('repro-invisible-smil'));
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('no repro page target');
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable'); await c.send('Runtime.enable');

  const where = await evaluate(c, `({
    dpr: devicePixelRatio,
    x: window.screenX, y: window.screenY,
    outer: window.outerWidth + 'x' + window.outerHeight,
    screen: screen.width + 'x' + screen.height,
  })`);
  console.log(`Window:   ${where.outer} DIP at (${where.x},${where.y}), dpr ${where.dpr}`);
  console.log(`Screen:   ${where.screen} DIP` +
              ` = ${where.screen.split('x').map((n) => n * where.dpr).join('x')} px\n`);

  const rows = [];
  for (const [label, flag] of VARIANTS) {
    await c.send('Page.navigate', { url: url(flag) });
    await sleep(1500); // let the page build its spinners and settle
    const r = await measure(c, SECS);
    rows.push([label, r]);
    console.log(`  measured: ${label}`);
    for (const [k, v] of r.invalidations) console.log(`      ${String(v).padStart(6)}x ${k}`);
  }

  const w = Math.max(...VARIANTS.map(([l]) => l.length));
  console.log(`\n| ${'wrapper'.padEnd(w)} | frames/s | style/s | layout/s | composite/s | raster/s | main thread |`);
  console.log(`| ${'-'.repeat(w)} | -------- | ------- | -------- | ----------- | -------- | ----------- |`);
  for (const [label, r] of rows) {
    const per = (n) => String(Math.round(n / SECS)).padStart(7);
    console.log(`| ${label.padEnd(w)} | ${per(r.frames).padStart(8)} | ${per(r.style)} | ${per(r.layout).padStart(8)} | ${per(r.composite).padStart(11)} | ${per(r.raster).padStart(8)} | ${(r.cpu.toFixed(0) + '% of a core').padStart(11)} |`);
  }
  console.log(`
Read it like this: the hidden variants run a full style -> layout -> composite
cycle at the display refresh rate while producing ZERO raster work — no pixel
they touch can ever be seen. 'display: none' and the no-SMIL control show what
correct handling looks like: no cycles at all.`);

  c.close();
  console.log(`\n(debug Chrome shut down; throwaway profile left at ${PROFILE})`);
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.stack); process.exit(1); });
