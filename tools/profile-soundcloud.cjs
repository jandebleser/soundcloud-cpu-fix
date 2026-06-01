#!/usr/bin/env node
//
// profile-soundcloud.cjs — diagnose SoundCloud's foreground CPU loop.
//
// Launches an isolated debug Chrome, opens soundcloud.com, and over the Chrome
// DevTools Protocol captures a 5s timeline trace, printing the Blink rendering
// lifecycle breakdown. Then it blocks ad/tracker scripts and re-traces, so you
// can see how much of the render churn they drive (the A/B test from the README).
//
// Requires: a Chrome/Chromium binary and the `ws` node module on NODE_PATH.
// Usage:   CHROME=/opt/google/chrome/chrome node tools/profile-soundcloud.cjs
//
// Nothing here touches your real Chrome profile — it uses a throwaway
// --user-data-dir and its own --remote-debugging-port.

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const CHROME = process.env.CHROME || 'google-chrome';
const PORT = Number(process.env.PORT || 9322);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-profile-'));
const URL_DISCOVER = 'https://soundcloud.com/discover';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res, rej) =>
  http.get(`http://localhost:${PORT}${p}`, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej));

function launchChrome() {
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check',
    URL_DISCOVER,
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: true });
  child.unref();
  return child;
}

async function waitForPort(tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { await get('/json/version'); return true; } catch { await sleep(500); }
  }
  throw new Error('debug port never came up');
}

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
    takeEvents: () => { const e = events; events = []; return e; },
    onTraceComplete: (fn) => { onComplete = fn; },
    close: () => ws.close(),
  };
}

const TRACKED = [
  'LocalFrameView::performLayout',
  'Document::recalcStyle',
  'PageAnimator::serviceScriptedAnimations',
  'PaintArtifactCompositor::Update',
  'FunctionCall',
];

async function trace(c, label) {
  await c.send('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible',
    includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] } });
  await sleep(5000);
  const done = new Promise((r) => c.onTraceComplete(r));
  await c.send('Tracing.end'); await done;
  const events = c.takeEvents();
  const byTid = new Map();
  for (const e of events) if (e.ph === 'X' && typeof e.dur === 'number') byTid.set(e.tid, (byTid.get(e.tid) || 0) + e.dur);
  const tid = [...byTid.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const cnt = new Map(), dur = new Map();
  for (const e of events) if (e.tid === tid && e.ph === 'X' && TRACKED.includes(e.name)) {
    cnt.set(e.name, (cnt.get(e.name) || 0) + 1);
    dur.set(e.name, (dur.get(e.name) || 0) + (e.dur || 0));
  }
  console.log(`\n--- ${label} (5s) ---`);
  for (const n of TRACKED) console.log(`${String(cnt.get(n) || 0).padStart(5)}x  ${((dur.get(n) || 0) / 1000).toFixed(0).padStart(5)}ms  ${n}`);
  console.log(`   rAF fps = ${((cnt.get('PageAnimator::serviceScriptedAnimations') || 0) / 5).toFixed(0)}`);
}

(async () => {
  launchChrome();
  await waitForPort();
  const ver = await get('/json/version');
  console.log('Chrome:', ver.Browser);
  let target;
  for (let i = 0; i < 20 && !target; i++) {
    target = (await get('/json')).find((t) => t.type === 'page' && t.url.includes('soundcloud'));
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('no soundcloud page target');
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');

  await trace(c, 'BASELINE (all scripts)');

  await c.send('Network.enable');
  await c.send('Network.setBlockedURLs', { urls: [
    '*cadmus*', '*aditude*', '*dwt.soundcloud*', '*doubleclick*',
    '*googlesyndication*', '*amazon-adsystem*', '*adnxs*', '*scorecardresearch*',
  ] });
  await c.send('Page.reload', {});
  await sleep(6000);
  await trace(c, 'AD/TRACKERS BLOCKED');

  c.close();
  console.log(`\n(debug profile at ${PROFILE} — safe to delete; kill the debug Chrome window when done)`);
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
