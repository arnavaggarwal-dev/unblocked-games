#!/usr/bin/env node
// Populates vendor/ with every asset the site currently pulls from the network.
//
// Run ONCE, with internet: `npm run vendor`
// Idempotent — anything already on disk is skipped, so re-running after a partial failure
// only fetches what's missing.
//
// The output is committed to the tauri-offline branch, so a fresh build never needs the network.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExternalUrls, isManuallyHandled } from './manual-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');
const TMP = path.join(ROOT, '.vendor-tmp');

// Google serves legacy TTF to unrecognised clients. A modern Chrome UA is what makes the
// css2 endpoint hand back woff2 with unicode-range descriptors.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';

const log = (...a) => console.log('[vendor]', ...a);
const warn = (...a) => console.warn('[vendor] !', ...a);

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function download(url, dest, { optional = false } = {}) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`skip (exists) ${path.relative(VENDOR, dest)}`);
    return true;
  }
  const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
  if (!res.ok) {
    if (optional) return false;
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buf);
  log(`got ${path.relative(VENDOR, dest)} (${mb(buf.length)})`);
  return true;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
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

// ---------------------------------------------------------------------------
// 1. JS libraries, straight from npm
// ---------------------------------------------------------------------------

// `files: null` means "copy the whole package" — required for the MediaPipe solutions, whose
// entry JS fetches sibling .wasm/.tflite/.binarypb/.data files at runtime via locateFile().
const NPM_LIBS = [
  { spec: 'matter-js@0.19.0', dest: 'js', files: { 'build/matter.min.js': 'matter.min.js' } },
  { spec: 'three@0.128.0', dest: 'js', files: { 'build/three.min.js': 'three.min.js' } },
  { spec: '@mediapipe/face_mesh@0.4.1633559619', dest: 'js/mediapipe/face_mesh', files: null },
  { spec: '@mediapipe/hands@0.4.1675469240', dest: 'js/mediapipe/hands', files: null },
  { spec: '@mediapipe/camera_utils@0.3.1675466862', dest: 'js/mediapipe/camera_utils', files: null },
];

function vendorNpmLibs() {
  log('--- npm libraries ---');
  ensureDir(TMP);

  for (const lib of NPM_LIBS) {
    const destDir = path.join(VENDOR, lib.dest);
    const marker = lib.files
      ? path.join(destDir, Object.values(lib.files)[0])
      : path.join(destDir, 'package.json');

    if (fs.existsSync(marker)) {
      log(`skip (exists) ${lib.spec}`);
      continue;
    }

    log(`npm pack ${lib.spec}`);
    // Node needs shell:true to launch npm.cmd on Windows, but shell:true passes argv through
    // unquoted — and this project path contains spaces. Dodge it by running npm *inside* TMP
    // and dropping --pack-destination, so no path is ever an argument.
    const tgzName = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', lib.spec, '--silent'],
      { encoding: 'utf8', cwd: TMP, shell: true },
    ).trim().split(/\r?\n/).pop();

    const unpacked = path.join(TMP, tgzName.replace(/\.tgz$/, ''));
    ensureDir(unpacked);
    // Extract with cwd set and a relative tarball path. Absolute Windows paths are not an
    // option here: whichever `tar` is first on PATH may be MSYS/GNU tar, which reads "C:\..."
    // as an rsync-style remote host and fails. Relative names work under bsdtar and GNU tar alike.
    execFileSync('tar', ['-xzf', path.join('..', tgzName)], { cwd: unpacked });

    const pkgRoot = path.join(unpacked, 'package');
    if (lib.files) {
      for (const [from, to] of Object.entries(lib.files)) {
        const src = path.join(pkgRoot, from);
        if (!fs.existsSync(src)) throw new Error(`${lib.spec}: expected ${from} in tarball`);
        ensureDir(destDir);
        fs.copyFileSync(src, path.join(destDir, to));
        log(`got ${lib.dest}/${to} (${mb(fs.statSync(src).size)})`);
      }
    } else {
      copyDir(pkgRoot, destDir);
      log(`got ${lib.dest}/ (whole package)`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Google Fonts -> local woff2 + a single stylesheet
// ---------------------------------------------------------------------------

// Every external URL referenced by the site's own HTML. Discovered rather than listed, so
// dropping a new game into games/ picks up its fonts and libraries with no code change here.
function scanSiteUrls() {
  const files = [
    path.join(ROOT, 'index.html'),
    ...fs
      .readdirSync(path.join(ROOT, 'games'))
      .filter((f) => f.endsWith('.html'))
      .map((f) => path.join(ROOT, 'games', f)),
  ].filter((f) => fs.existsSync(f));

  const urls = new Set();
  for (const file of files) {
    for (const url of findExternalUrls(fs.readFileSync(file, 'utf8'))) urls.add(url);
  }
  return urls;
}

async function vendorFonts(FONT_CSS_URLS) {
  log('--- google fonts ---');
  const outDir = path.join(VENDOR, 'fonts');
  const cssPath = path.join(outDir, 'fonts.css');
  ensureDir(outDir);

  const chunks = [
    '/* Generated by scripts/vendor.mjs — local mirror of the Google Fonts used by the games. */',
  ];

  for (const url of FONT_CSS_URLS) {
    let css = await fetchText(url);
    const woff2Urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(
      (m) => m[1],
    );

    if (woff2Urls.length === 0) {
      throw new Error(`no font files found in ${url} — did the User-Agent get rejected?`);
    }

    for (const fontUrl of new Set(woff2Urls)) {
      const name = path.basename(new URL(fontUrl).pathname);
      await download(fontUrl, path.join(outDir, name));
      // Relative to fonts.css, which sits alongside the woff2 files.
      css = css.split(fontUrl).join(`./${name}`);
    }

    chunks.push(`\n/* from ${url} */\n${css}`);
  }

  fs.writeFileSync(cssPath, chunks.join('\n'), 'utf8');
  log(`wrote fonts/fonts.css`);
}

// ---------------------------------------------------------------------------
// 2b. Anything else the HTML loads from the network — mirrored automatically
// ---------------------------------------------------------------------------
//
// This is what makes adding a game a one-step job: drop the .html in games/, and whatever
// plain <script>/<link> assets it pulls get mirrored here without touching this file.
//
// Limitation worth knowing: only URLs written literally in the HTML can be found this way.
// A library that builds asset URLs at runtime (the way MediaPipe's locateFile does) has to
// be added to MANUAL_URL_PREFIXES instead. `npm run verify` is what catches that case — it
// loads every page with DNS blackholed, so a runtime fetch to the network shows up as a
// failure rather than passing silently.

async function mirrorAutoAssets(urls, manifest) {
  log('--- auto-mirrored assets ---');
  manifest.auto ??= {};

  const todo = [...urls].filter((u) => !isManuallyHandled(u));
  if (todo.length === 0) {
    log('none (everything is handled by a dedicated rule)');
    return;
  }

  for (const url of todo) {
    const { host, pathname } = new URL(url);
    // Mirror the remote layout so relative references between mirrored files still line up.
    const rel = path.join('auto', host, pathname.replace(/^\/+/, '') || 'index.html');
    const ok = await download(url, path.join(VENDOR, rel), { optional: true });
    if (ok) {
      manifest.auto[url] = rel.split(path.sep).join('/');
    } else {
      warn(`could not fetch ${url} — the offline build will fail until this resolves`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Godot web exports (frylock, BOMBDEFUSERGODOT)
// ---------------------------------------------------------------------------

const GODOT_GAMES = [
  { name: 'frylock', base: 'https://arnavaggarwal-dev.github.io/frylock/' },
  { name: 'bombdefuser', base: 'https://arnavaggarwal-dev.github.io/BOMBDEFUSERGODOT/' },
];

// Godot's HTML shell names every artifact after the export "executable" name. Rather than
// assuming it's "index", read it out of the shell and probe each candidate — extra names are
// cheap (a 404 just gets skipped) and missing one would break the game offline.
function godotCandidates(html) {
  const exe = html.match(/"executable"\s*:\s*"([^"]+)"/)?.[1] ?? 'index';
  const suffixes = [
    '.js',
    '.wasm',
    '.side.wasm',
    '.pck',
    '.audio.worklet.js',
    '.audio.position.worklet.js',
    '.worker.js',
    '.png',
    '.icon.png',
    '.apple-touch-icon.png',
    '.service.worker.js',
    '.offline.html',
  ];
  const names = new Set(suffixes.map((s) => exe + s));

  // Anything else the shell references relatively (extra icons, manifests, splash images).
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"':#?]+)["']/g)) {
    const ref = m[1];
    if (!ref.startsWith('/') && !ref.startsWith('.')) names.add(ref);
  }
  return [...names];
}

async function vendorGodotGames(manifest) {
  log('--- godot exports ---');
  for (const game of GODOT_GAMES) {
    const outDir = path.join(VENDOR, 'games', game.name);
    ensureDir(outDir);

    const html = await fetchText(game.base);
    fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

    let got = 0;
    for (const name of godotCandidates(html)) {
      const ok = await download(game.base + name, path.join(outDir, name), { optional: true });
      if (ok) got++;
    }
    log(`${game.name}: ${got} files`);
    manifest.games[game.name] = { offline: true, entry: `games/${game.name}/index.html` };
  }
}

// ---------------------------------------------------------------------------
// 4. flappybirb (Pygbag / CPython-WASM)
// ---------------------------------------------------------------------------
//
// This one has no tidy file list: the page loads pygame-web.github.io/cdn/0.9.3/pythons.js,
// which then pulls a full CPython 3.12 WASM runtime. That CDN tree is a Pages build artifact
// and is not in any git repo, so the URL list has to be discovered by observation.
//
// scripts/pygbag-files.json is produced by that discovery step (a recorded network trace of one
// online play-through). If it's absent, flappybirb is simply marked online-only in the manifest
// and the gallery labels it accordingly — the other ten games are unaffected.

const FLAPPY_BASE = 'https://arnavaggarwal-dev.github.io/flappybirb/';
const PYGBAG_CDN = 'https://pygame-web.github.io/cdn/0.9.3/';

async function vendorFlappybirb(manifest) {
  log('--- flappybirb (pygbag) ---');
  const outDir = path.join(VENDOR, 'games', 'flappybirb');
  const traceFile = path.join(ROOT, 'scripts', 'pygbag-files.json');

  if (!fs.existsSync(traceFile)) {
    warn('scripts/pygbag-files.json missing — run the discovery step first.');
    warn('flappybirb will be marked online-only for now.');
    manifest.games.flappybirb = { offline: false, entry: FLAPPY_BASE };
    return;
  }

  ensureDir(outDir);
  const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));

  // The game's own payload, always needed.
  for (const name of ['index.html', 'flappy.bird.apk', 'flappy.bird.tar.gz', 'favicon.png']) {
    await download(FLAPPY_BASE + name, path.join(outDir, name), { optional: true });
  }

  // The runtime, mirrored under cdn/0.9.3/ so pythons.js resolves siblings relative to itself.
  let failed = 0;
  for (const rel of trace.cdnFiles ?? []) {
    const ok = await download(PYGBAG_CDN + rel, path.join(outDir, 'cdn', '0.9.3', rel), {
      optional: true,
    });
    if (!ok) failed++;
  }

  if (failed > 0) warn(`${failed} runtime file(s) missing — flappybirb may not boot offline`);
  manifest.games.flappybirb = {
    offline: failed === 0,
    entry: failed === 0 ? 'games/flappybirb/index.html' : FLAPPY_BASE,
  };
}

// ---------------------------------------------------------------------------

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

async function main() {
  ensureDir(VENDOR);
  const manifestPath = path.join(VENDOR, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { games: {} };
  manifest.games ??= {};

  const siteUrls = scanSiteUrls();
  const fontCssUrls = [...siteUrls].filter((u) =>
    u.startsWith('https://fonts.googleapis.com/css'),
  );
  log(`scanned site HTML: ${siteUrls.size} external URL(s), ${fontCssUrls.length} font stylesheet(s)`);

  vendorNpmLibs();
  await vendorFonts(fontCssUrls);
  await mirrorAutoAssets(siteUrls, manifest);
  await vendorGodotGames(manifest);
  await vendorFlappybirb(manifest);

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.rmSync(TMP, { recursive: true, force: true });

  log('--- done ---');
  log(`vendor/ is ${mb(dirSize(VENDOR))}`);
  for (const [name, info] of Object.entries(manifest.games)) {
    log(`  ${name}: ${info.offline ? 'offline' : 'ONLINE-ONLY'}`);
  }
}

main().catch((err) => {
  console.error('[vendor] FAILED:', err.message);
  process.exit(1);
});
