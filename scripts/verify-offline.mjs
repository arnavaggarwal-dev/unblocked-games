#!/usr/bin/env node
// Proves build/dist/ actually runs without internet — without touching the machine's network.
//
// Serves the built site on localhost, then loads every page in headless Edge with DNS for
// *every* host except 127.0.0.1 blackholed. Any surviving internet dependency fails loudly
// instead of silently succeeding because the machine happened to be online.
//
//   npm run verify
//
// What this proves: no page requests anything off-box, nothing 404s, no page errors.
// What it does NOT prove: that games render or play. Headless has no real GPU, so WebGL and
// heavy WASM are out of scope here — that still needs a human clicking through the app.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'build', 'dist');
const PORT = 8731;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon', '.ogg': 'audio/ogg',
  '.data': 'application/octet-stream', '.pck': 'application/octet-stream',
  '.tflite': 'application/octet-stream', '.binarypb': 'application/octet-stream',
  '.apk': 'application/octet-stream', '.gz': 'application/gzip', '.py': 'text/plain',
};

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('Microsoft Edge not found — cannot run the headless offline check');
}

// Mirrors the COOP/COEP headers set in tauri.conf.json, so the check exercises the same
// cross-origin-isolation setup the real app runs under.
function startServer() {
  const served = [];
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(DIST, rel || 'index.html');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      served.push({ url: req.url, status: 404 });
      res.writeHead(404).end('not found');
      return;
    }
    served.push({ url: req.url, status: 200 });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve({ server, served })));
}

async function cdp(browser, sessionTargets) {
  const res = await fetch(`http://127.0.0.1:9333/json/list`);
  return res.json();
}

async function main() {
  if (!fs.existsSync(DIST)) throw new Error('build/dist missing — run `npm run build:site` first');

  const { server, served } = await startServer();
  const browser = findBrowser();
  const profile = path.join(ROOT, '.vendor-tmp', 'edge-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  // The core of the test: blackhole DNS for everything, allow only loopback. Any request that
  // would have gone to the internet now fails with a name-resolution error we can detect.
  const proc = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=9333',
    `--user-data-dir=${profile}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for the devtools endpoint.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { await fetch('http://127.0.0.1:9333/json/version'); ready = true; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!ready) throw new Error('Edge devtools endpoint never came up');

  const pages = ['index.html', ...fs.readdirSync(path.join(DIST, 'games'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => `games/${f}`)];
  // The three vendored games live in subdirectories.
  for (const g of ['frylock', 'bombdefuser', 'flappybirb']) {
    if (fs.existsSync(path.join(DIST, 'games', g, 'index.html'))) pages.push(`games/${g}/index.html`);
  }

  const results = [];

  for (const page of pages) {
    const targets = await cdp();
    const tab = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const failures = [];
    const errors = [];
    let id = 0;
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

    await new Promise((resolve) => (ws.onopen = resolve));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Network.loadingFailed') {
        failures.push(`${msg.params.errorText} ${msg.params.type}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(d.exception?.description ?? d.text);
      }
    };
    send('Network.enable');
    send('Runtime.enable');
    send('Page.enable');
    send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}` });

    await new Promise((r) => setTimeout(r, 6000));

    // Anything that tried to leave the box shows up as a DNS failure.
    const external = failures.filter((f) => /NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED/.test(f));
    results.push({ page, external, errors, failures });

    ws.close();
    await fetch(`http://127.0.0.1:9333/json/close/${tab.id}`);
  }

  proc.kill();
  server.close();

  // --- report ---
  let bad = 0;
  console.log('');
  for (const r of results) {
    const missing = served.filter((s) => s.status === 404);
    const problems = [];
    if (r.external.length) problems.push(`${r.external.length} external request(s)`);
    if (r.errors.length) problems.push(`${r.errors.length} page error(s)`);
    if (problems.length) {
      bad++;
      console.log(`  FAIL  ${r.page} — ${problems.join(', ')}`);
      for (const e of r.external.slice(0, 3)) console.log(`          net: ${e}`);
      for (const e of r.errors.slice(0, 3)) console.log(`          err: ${String(e).split('\n')[0]}`);
    } else {
      console.log(`  ok    ${r.page}`);
    }
  }

  const notFound = served.filter((s) => s.status === 404);
  if (notFound.length) {
    console.log(`\n  ${notFound.length} request(s) 404'd:`);
    for (const s of [...new Set(notFound.map((s) => s.url))].slice(0, 10)) console.log(`     ${s}`);
  }

  console.log('');
  if (bad > 0) {
    console.log(`OFFLINE VERIFICATION FAILED — ${bad}/${results.length} page(s) had problems.`);
    process.exit(1);
  }
  console.log(`Offline verification passed — ${results.length} pages, zero external requests.`);
  console.log('(Rendering and gameplay still need a human; headless has no GPU.)');
}

main().catch((err) => {
  console.error('[verify] FAILED:', err.message);
  process.exit(1);
});
