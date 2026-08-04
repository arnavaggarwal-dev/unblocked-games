#!/usr/bin/env node
// Assembles build/dist/ — the fully-offline copy of the site that Tauri bundles.
//
// Nothing in the repo root is modified. The site is copied into build/dist/, and every
// network reference is rewritten there to point at the local vendor/ tree. That's what keeps
// this branch a purely additive diff against main: main keeps its CDN URLs and stays correct
// for GitHub Pages.
//
// Run via `npm run build:site`, or automatically by Tauri's beforeBuildCommand.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');
const DIST = path.join(ROOT, 'build', 'dist');

const log = (...a) => console.log('[build]', ...a);

// Files copied verbatim from the repo root.
const SITE_FILES = ['index.html', 'favicon.ico'];
const SITE_DIRS = ['games'];

// ---------------------------------------------------------------------------
// Rewrite rules
// ---------------------------------------------------------------------------
//
// %VENDOR% expands per-file to the correct relative path to build/dist/vendor/, so the same
// rule works for index.html (vendor/) and games/*.html (../vendor/).
//
// Order matters: a rule whose pattern is a prefix of another must come *after* it, or it
// would consume the longer match first. The face_mesh/hands "bare directory" rules exist for
// the MediaPipe locateFile() callbacks, which build asset URLs at runtime — rewriting only the
// <script src> tags would leave those games loading .wasm and .tflite from the network.

const RULES = [
  // --- plain libraries ---
  {
    name: 'matter-js',
    find: 'https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js',
    replace: '%VENDOR%js/matter.min.js',
  },
  {
    name: 'three.js',
    find: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    replace: '%VENDOR%js/three.min.js',
  },

  // --- MediaPipe: specific entry files before their bare directories ---
  {
    name: 'mediapipe face_mesh entry',
    find: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js',
    replace: '%VENDOR%js/mediapipe/face_mesh/face_mesh.js',
  },
  {
    name: 'mediapipe face_mesh locateFile',
    find: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/',
    replace: '%VENDOR%js/mediapipe/face_mesh/',
  },
  {
    name: 'mediapipe hands entry',
    find: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/hands.js',
    replace: '%VENDOR%js/mediapipe/hands/hands.js',
  },
  {
    name: 'mediapipe hands locateFile',
    find: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/',
    replace: '%VENDOR%js/mediapipe/hands/',
  },
  {
    name: 'mediapipe camera_utils (pinned)',
    find: 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3/camera_utils.js',
    replace: '%VENDOR%js/mediapipe/camera_utils/camera_utils.js',
  },
  {
    name: 'mediapipe camera_utils (unpinned)',
    find: 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js',
    replace: '%VENDOR%js/mediapipe/camera_utils/camera_utils.js',
  },

  // --- Google Fonts ---
  // Drop the preconnect hints entirely; they point at hosts we no longer touch.
  {
    name: 'font preconnect hints',
    find: /<link\s+rel="preconnect"\s+href="https:\/\/fonts\.(?:googleapis|gstatic)\.com"[^>]*>\s*/g,
    replace: '',
  },
  // Handles both attribute orders (LastLink puts href first, dancing_burger puts rel first).
  {
    name: 'font stylesheet link',
    find: /<link[^>]*href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*"[^>]*>/g,
    replace: '<link rel="stylesheet" href="%VENDOR%fonts/fonts.css">',
  },
  {
    name: 'font @import',
    find: /@import\s+url\(['"]https:\/\/fonts\.googleapis\.com\/css2\?[^'"]*['"]\);/g,
    replace: "@import url('%VENDOR%fonts/fonts.css');",
  },

  // --- flappybirb's Pygbag loader ---
  // One base-URL swap covers the <script src>, the explicit `cdn:` config value, and the
  // iframe src.
  //
  // Root-absolute, NOT "./" — and that detail matters. vtx.js derives its xterm path as
  // `config.cdn + "../vt/"` and uses it for both a <link href> and an `await import()`.
  // A relative base resolves those against two different things (the document vs. vtx.js's
  // own module URL), so xterm.css and xterm.js end up at different paths and one 404s.
  // Upstream that's invisible because config.cdn is an absolute URL. An absolute path
  // restores that property. Safe because Tauri serves frontendDist at the server root.
  {
    name: 'pygbag cdn base',
    find: 'https://pygame-web.github.io/cdn/0.9.3/',
    replace: '/games/flappybirb/cdn/0.9.3/',
  },
];

// ---------------------------------------------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function walk(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

// Relative path from a dist file back to build/dist/vendor/, with a trailing slash.
function vendorPrefix(file) {
  const rel = path.relative(path.dirname(file), path.join(DIST, 'vendor'));
  return rel.split(path.sep).join('/') + '/';
}

function loadManifest() {
  const p = path.join(VENDOR, 'manifest.json');
  if (!fs.existsSync(p)) {
    throw new Error('vendor/manifest.json missing — run `npm run vendor` first');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------

function assemble() {
  fs.rmSync(path.join(ROOT, 'build'), { recursive: true, force: true });
  ensureDir(DIST);

  for (const f of SITE_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
  for (const d of SITE_DIRS) copyDir(path.join(ROOT, d), path.join(DIST, d));

  copyDir(path.join(VENDOR, 'js'), path.join(DIST, 'vendor', 'js'));
  copyDir(path.join(VENDOR, 'fonts'), path.join(DIST, 'vendor', 'fonts'));
  if (fs.existsSync(path.join(VENDOR, 'auto'))) {
    copyDir(path.join(VENDOR, 'auto'), path.join(DIST, 'vendor', 'auto'));
  }

  const manifest = loadManifest();
  for (const [name, info] of Object.entries(manifest.games)) {
    if (!info.offline) continue;
    copyDir(path.join(VENDOR, 'games', name), path.join(DIST, 'games', name));
  }
  log(`assembled build/dist`);
  return manifest;
}

function rewriteGameCards(manifest) {
  const indexPath = path.join(DIST, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const stillOnline = [];

  // Live URL -> vendored directory name, matching index.html's gallery cards.
  const CARDS = {
    'https://arnavaggarwal-dev.github.io/frylock/': 'frylock',
    'https://arnavaggarwal-dev.github.io/flappybirb/': 'flappybirb',
    'https://arnavaggarwal-dev.github.io/BOMBDEFUSERGODOT/': 'bombdefuser',
  };

  for (const [url, name] of Object.entries(CARDS)) {
    if (!html.includes(url)) {
      throw new Error(`index.html no longer contains the ${name} card URL (${url})`);
    }
    const info = manifest.games[name];
    if (info?.offline) {
      html = html.split(url).join(`games/${name}/index.html`);
      log(`card ${name} -> local`);
    } else {
      // Left pointing at the live site. Label it so the gallery is honest about needing
      // a connection rather than presenting a card that silently fails.
      stillOnline.push(url);
      html = html.replace(
        new RegExp(`(data-href="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)`),
        '$1<!-- needs internet -->',
      );
      log(`card ${name} -> ONLINE-ONLY (kept remote URL)`);
    }
  }

  fs.writeFileSync(indexPath, html, 'utf8');
  return stillOnline;
}

// Rules generated from whatever vendor.mjs auto-mirrored. These come from scanning the site
// rather than from the hand-written table above, so a new game's CDN assets get rewritten
// without anyone editing this file.
function autoRules(manifest) {
  return Object.entries(manifest.auto ?? {}).map(([url, rel]) => ({
    name: `auto: ${url.slice(0, 60)}${url.length > 60 ? '…' : ''}`,
    find: url,
    replace: `%VENDOR%${rel}`,
  }));
}

// pygbag's Python layer asks for its package index by absolute URL, assembled inside the
// CPython-WASM blob where no text rewrite can reach it. This shim maps that one host onto
// the local mirror at runtime.
//
// Injected into the built page rather than into the Tauri window, so `npm run verify`
// exercises the same code path the shipped app uses — a fix that only existed in the Rust
// layer would leave the check permanently red and unable to catch the next regression.
const PYGBAG_FETCH_SHIM = `<script>
(function () {
  var REMOTE = 'https://pygame-web.github.io/cdn/';
  var LOCAL = '/games/flappybirb/cdn/';
  function map(u) {
    return (typeof u === 'string' && u.indexOf(REMOTE) === 0) ? LOCAL + u.slice(REMOTE.length) : u;
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (input && typeof input === 'object' && input.url) {
      return origFetch.call(this, new Request(map(input.url), input), init);
    }
    return origFetch.call(this, map(input), init);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = map(url);
    return origOpen.apply(this, arguments);
  };
})();
</script>`;

function injectPygbagShim() {
  const file = path.join(DIST, 'games', 'flappybirb', 'index.html');
  if (!fs.existsSync(file)) return;

  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('pygame-web.github.io/cdn/')) {
    // Must run before the pygbag loader, which is the first <script> in the document.
    const at = html.indexOf('<script');
    if (at === -1) throw new Error('flappybirb index.html has no <script> to inject before');
    html = html.slice(0, at) + PYGBAG_FETCH_SHIM + html.slice(at);
    fs.writeFileSync(file, html, 'utf8');
    log('injected pygbag fetch shim');
  }
}

function applyRules(manifest) {
  // Hand-written rules first: several match a prefix of a URL that an auto-rule would also
  // match, and the specific handling has to win.
  const allRules = [...RULES, ...autoRules(manifest)];
  const files = walk(DIST, (p) => /\.(html|css)$/i.test(p) && !p.includes(`${path.sep}vendor${path.sep}`));
  const counts = new Map();

  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    const prefix = vendorPrefix(file);

    for (const rule of allRules) {
      const replacement = rule.replace.split('%VENDOR%').join(prefix);
      let hits = 0;

      if (typeof rule.find === 'string') {
        const parts = text.split(rule.find);
        hits = parts.length - 1;
        if (hits > 0) text = parts.join(replacement);
      } else {
        text = text.replace(rule.find, () => {
          hits++;
          return replacement;
        });
      }

      if (hits > 0) counts.set(rule.name, (counts.get(rule.name) ?? 0) + hits);
    }

    fs.writeFileSync(file, text, 'utf8');
  }

  for (const rule of allRules) {
    const n = counts.get(rule.name) ?? 0;
    log(`  rule "${rule.name}": ${n} replacement${n === 1 ? '' : 's'}`);
  }
}

// The safety net. Everything above is a best effort; this is what actually proves the build
// is offline. A silently-missed URL would produce a game that half-works with the network on
// and breaks only once disconnected — exactly the failure this whole branch exists to avoid.
function guard(allowedOnline) {
  // XML namespace identifiers. They appear in xmlns attributes and are never fetched.
  const ALLOWED = [
    /^https?:\/\/www\.w3\.org\//,
    // The pygbag shim above holds this host as a string to *match against* so it can
    // redirect it to the local mirror. It is compared, never fetched — the whole reason
    // it exists is to stop that host from being contacted.
    // Anchored to the exact origin+path, so a real asset URL under that host would still
    // be caught — only the bare prefix the shim compares against is tolerated.
    /^https:\/\/pygame-web\.github\.io\/cdn\/$/,
  ];

  // Third-party bundles under vendor/js are excluded — minified library source is full of URLs
  // in comments, licence headers and error strings, none of which are fetched. vendor/fonts.css
  // is ours, though, so it gets checked (with comments stripped, since vendor.mjs records the
  // originating Google Fonts URL there as provenance).
  const files = [
    ...walk(DIST, (p) => /\.(html|css)$/i.test(p) && !p.includes(`${path.sep}vendor${path.sep}`)),
    path.join(DIST, 'vendor', 'fonts', 'fonts.css'),
  ].filter((p) => fs.existsSync(p));
  const offenders = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    // Blank out comment bodies but keep their newlines, so reported line numbers stay accurate.
    const scanned = file.endsWith('.css')
      ? raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      : raw;
    const lines = scanned.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
        const url = m[0];
        if (ALLOWED.some((re) => re.test(url))) continue;
        if (allowedOnline.some((u) => url.startsWith(u))) continue;
        offenders.push(`${path.relative(DIST, file)}:${i + 1}  ${url}`);
      }
    });
  }

  if (offenders.length > 0) {
    console.error('\n[build] OFFLINE CHECK FAILED — external URLs survived in build/dist:\n');
    for (const o of offenders) console.error('  ' + o);
    console.error('\nAdd a rule to RULES in scripts/build-offline.mjs for each of these.\n');
    process.exit(1);
  }

  log(`offline check passed — ${files.length} files, no external URLs`);
  if (allowedOnline.length > 0) {
    log(`(${allowedOnline.length} card(s) deliberately left online — see warnings above)`);
  }
}

// Second half of the safety net: a rewrite rule pointing at a path that doesn't exist would
// sail past guard() — no external URL, just a 404 at runtime. Resolve every local reference
// and confirm the file is actually there.
function checkLocalRefs() {
  // Referenced by flappybirb's upstream shell but absent from the Pygbag CDN — it 404s on the
  // live site too (the "response" is GitHub's 404 page). The game runs fine without it, so the
  // offline copy reproduces the same harmless miss rather than pretending to have the file.
  const KNOWN_MISSING = [
    /browserfs\.min\.js$/,
    // pygbag's download-handler iframe (cdn/lib/index.html) links to /archives/lib/ on
    // pygame-web.github.io — a page on their site, not an asset this app uses. The iframe is
    // only involved in exporting save files to disk, which offline play never reaches.
    /^\/archives\//,
  ];

  const files = walk(DIST, (p) => /\.html$/i.test(p));
  const missing = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const refs = new Set();

    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) refs.add(m[1]);
    // The MediaPipe locateFile prefixes and the pygbag cdn base are bare strings, not attributes.
    for (const m of text.matchAll(/["'`](\.{1,2}\/[^"'`\s${}]+\/)["'`]/g)) refs.add(m[1]);

    for (const ref of refs) {
      if (/^(https?:|data:|blob:|mailto:|javascript:|#)/i.test(ref)) continue;
      if (KNOWN_MISSING.some((re) => re.test(ref))) continue;
      const clean = ref.split(/[?#]/)[0];
      // Root-absolute refs (the pygbag cdn base) resolve against the served root, not the
      // containing directory — same as the browser does.
      const target = clean.startsWith('/')
        ? path.join(DIST, clean)
        : path.resolve(path.dirname(file), clean);
      if (!fs.existsSync(target)) missing.push(`${path.relative(DIST, file)}  ->  ${ref}`);
    }
  }

  if (missing.length > 0) {
    console.error('\n[build] LOCAL REFERENCE CHECK FAILED — rewritten paths that do not exist:\n');
    for (const m of missing) console.error('  ' + m);
    console.error('');
    process.exit(1);
  }
  log(`local reference check passed — every src/href resolves on disk`);
}

const manifest = assemble();
const stillOnline = rewriteGameCards(manifest);
// Before applyRules: the shim is located by searching for the un-rewritten pygbag host.
injectPygbagShim();
applyRules(manifest);
guard(stillOnline);
checkLocalRefs();
