#!/usr/bin/env node
//
// diagnose-render-loop.cjs — find out what makes SoundCloud re-render every frame,
// and measure the shipped throttle against it.
//
// Launches an isolated debug Chrome (throwaway --user-data-dir, own debug port —
// your real profile is untouched), opens SoundCloud, and over the DevTools
// Protocol:
//
//   1. traces 6s with invalidation tracking on, so every style/layout
//      invalidation is attributed to a reason and a node;
//   2. inventories the SMIL animation elements in the page;
//   3. A/Bs the page against ../sc-throttle/throttle.js injected at document
//      start, reporting frames/s and main-thread cost for each.
//
// Usage:
//   CHROME=/opt/google/chrome/chrome NODE_PATH=$(npm root -g) \
//     node tools/diagnose-render-loop.cjs [url]
//
// Requires the `ws` node module on NODE_PATH.
const { spawn } = require('child_process');
const http = require('http'); const os = require('os'); const path = require('path'); const fs = require('fs');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'google-chrome';
const PORT = Number(process.env.PORT || 9337);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-diagnose-'));
const URL_TARGET = process.argv[2] || process.env.SC_URL || 'https://soundcloud.com/discover';
const THROTTLE = fs.readFileSync(path.join(__dirname, '..', 'sc-throttle', 'throttle.js'), 'utf8');

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

const evaluate = (c, expression) => c.send('Runtime.evaluate',
  { returnByValue: true, awaitPromise: true, expression }).then((r) => r.result && r.result.value);

async function trace(c, label, { invalidations = false, secs = 6 } = {}) {
  const categories = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'];
  if (invalidations) categories.push('disabled-by-default-devtools.timeline.invalidationTracking');
  await c.send('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: categories } });
  await sleep(secs * 1000);
  const done = new Promise((r) => c.onTraceComplete(r));
  await c.send('Tracing.end'); await done;
  const events = c.take();

  const byTid = new Map();
  for (const e of events) if (e.ph === 'X' && typeof e.dur === 'number') byTid.set(e.tid, (byTid.get(e.tid) || 0) + e.dur);
  const tid = [...byTid.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const of = (name) => events.filter((e) => e.tid === tid && e.name === name);
  const ms = (list) => list.reduce((s, e) => s + (e.dur || 0), 0) / 1000;

  const frames = of('PageAnimator::serviceScriptedAnimations');
  const layout = of('LocalFrameView::performLayout');
  const style = of('Document::recalcStyle');
  const composite = of('PaintArtifactCompositor::Update');
  const js = ms(of('FunctionCall')) + ms(of('TimerFire'));
  const busy = ms(layout) + ms(style) + ms(composite) + js;

  console.log(`\n--- ${label} (${secs}s) ---`);
  console.log(`  ${(frames.length / secs).toFixed(0).padStart(4)} frames/s`);
  console.log(`  layout    ${String(layout.length).padStart(5)}x ${ms(layout).toFixed(0).padStart(5)}ms`);
  console.log(`  style     ${String(style.length).padStart(5)}x ${ms(style).toFixed(0).padStart(5)}ms`);
  console.log(`  composite ${String(composite.length).padStart(5)}x ${ms(composite).toFixed(0).padStart(5)}ms`);
  console.log(`  js                 ${js.toFixed(0).padStart(5)}ms`);
  console.log(`  => main thread ~${(busy / (secs * 10)).toFixed(0)}% of a core`);

  if (invalidations) {
    const tally = new Map();
    for (const e of events) {
      if (!/InvalidationTracking/.test(e.name)) continue;
      const d = (e.args && e.args.data) || {};
      const key = `${e.name} reason=${d.reason || '?'} node=${d.nodeName || d.nodeId || '?'}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    console.log('  who dirties style/layout:');
    const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!rows.length) console.log('    (nothing — the page is idle)');
    for (const [k, v] of rows) console.log(`    ${String(v).padStart(6)}x ${k}`);
  }
  return busy / (secs * 10);
}

(async () => {
  const child = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    URL_TARGET,
  ], { stdio: 'ignore', detached: true });
  child.unref();

  for (let i = 0; i < 30; i++) { try { await get('/json/version'); break; } catch { await sleep(500); } }
  console.log('Chrome:', (await get('/json/version')).Browser);
  console.log('URL:   ', URL_TARGET);

  let target;
  for (let i = 0; i < 30 && !target; i++) {
    target = (await get('/json')).find((t) => t.type === 'page' && t.url.includes('soundcloud'));
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('no soundcloud page target');
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await sleep(9000); // let the SPA settle

  console.log('\n=== SMIL inventory ===');
  console.log(await evaluate(c, `(() => {
    const smil = [...document.querySelectorAll('animate,animateTransform,animateMotion,animateColor,set')];
    const tally = {};
    for (const a of smil) {
      const k = a.tagName + ' attributeName=' + (a.getAttribute('attributeName') || '?')
              + ' dur=' + (a.getAttribute('dur') || '?')
              + ' on=' + (a.parentElement ? a.parentElement.tagName : '?');
      tally[k] = (tally[k] || 0) + 1;
    }
    return { svgs: document.querySelectorAll('svg').length,
             smil: smil.length,
             kinds: Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + 'x ' + k) };
  })()`));

  const before = await trace(c, 'BASELINE', { invalidations: true });

  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: THROTTLE });
  await c.send('Page.reload', {});
  await sleep(11000);
  console.log('\nthrottle injected:', await evaluate(c, `document.documentElement.getAttribute('data-sc-throttle')`));
  const after = await trace(c, 'WITH sc-throttle', { invalidations: true });

  const t0 = await evaluate(c, `(() => { const s = [...document.querySelectorAll('svg')].find(x => x.querySelector('animateTransform')); return s ? s.getCurrentTime() : null; })()`);
  await sleep(1000);
  const t1 = await evaluate(c, `(() => { const s = [...document.querySelectorAll('svg')].find(x => x.querySelector('animateTransform')); return s ? s.getCurrentTime() : null; })()`);
  console.log(`\nSMIL timeline still advancing (should be ~1.0s per second): ${
    t0 === null || t1 === null ? 'n/a — no SMIL svg on screen' : (t1 - t0).toFixed(2) + 's'}`);

  console.log(`\nRESULT: main thread ${before.toFixed(0)}% -> ${after.toFixed(0)}% of a core`);
  c.close();
  console.log(`\n(debug profile at ${PROFILE} — safe to delete; close the debug Chrome window when done)`);
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.stack); process.exit(1); });
