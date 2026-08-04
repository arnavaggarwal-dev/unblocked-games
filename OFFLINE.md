# Offline desktop build (`distrib` branch)

## Publishing

```powershell
.\push.bat "what changed"        # commit + push
.\push.bat "what changed" -Release   # ...and build installers for every OS
```

Validates the workflow YAML, commits, rebases onto the remote, pushes, and optionally tags a
release (auto-incrementing the version recorded in `version.log`).

Run it from **PowerShell or by double-clicking**. It does not work from Git Bash — MSYS
re-quotes arguments on the way into `cmd`, and splits this project's path at
`OneDrive - NUS`. From a bash shell, call the script directly instead:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/push.ps1 "what changed" -NoBuild
```



Builds the whole gallery into a Windows app that runs with **no internet at all** — every font,
library, and game bundled locally.

This branch is **purely additive**. It doesn't touch `index.html` or anything in `games/`, so
`main` keeps its CDN URLs and stays correct for GitHub Pages. `git merge main` should never
conflict.

## Build it

```
npm install
npm run vendor    # once, WITH internet — downloads ~154 MB into vendor/
npm run build     # produces the installer
```

Output: `src-tauri/target/release/bundle/nsis/*-setup.exe`
(`npm run dev` runs it without packaging.)

`vendor/` is committed, so after the first `npm run vendor` the build itself never needs a
connection. Re-running `vendor` is safe — it skips anything already downloaded.

Rust's build output is redirected to `~/.cargo-target/` by `scripts/tauri.mjs`, because this
project lives inside OneDrive and syncing multi-GB incremental artifacts is painful.

## How it works

`scripts/build-offline.mjs` copies the site into `build/dist/` and rewrites every network
reference there to point at `vendor/`. Two checks run at the end, and **both fail the build**:

- **offline check** — no `http(s)://` may survive in any built HTML (bar XML namespaces)
- **local reference check** — every rewritten `src`/`href` must resolve to a file on disk

Between them, a missed URL can't silently produce a build that works online and dies offline.

## What's vendored

| | |
|---|---|
| matter-js 0.19.0, three.js r128 | `vendor/js/` |
| MediaPipe `face_mesh`, `hands`, `camera_utils` | `vendor/js/mediapipe/` — whole packages, since `locateFile()` fetches `.wasm`/`.tflite` siblings at runtime |
| Cinzel, EB Garamond, Bangers, Kalam, Shantell Sans, Caveat, Patrick Hand | `vendor/fonts/` as woff2 + generated `fonts.css` |
| frylock, bombdefuser (Godot exports) | `vendor/games/` |
| flappybirb + Pygbag CPython-WASM runtime | `vendor/games/flappybirb/` |

## Things worth knowing

**frylock needs `SharedArrayBuffer`.** It's a threaded Godot export — on GitHub Pages it gets
cross-origin isolation via a `coi-serviceworker.js` shim. The app sets real `Cross-Origin-Opener-Policy`
and `Cross-Origin-Embedder-Policy` headers in `tauri.conf.json` instead, which both satisfies the
requirement and makes the shim no-op (it bails when `crossOriginIsolated` is already true).
bombdefuser is single-threaded and unaffected either way.

**flappybirb's runtime had to be reverse-engineered.** Its Pygbag CDN tree is a GitHub Pages build
artifact and exists in no git repo. `scripts/pygbag-files.json` documents how the file list was
derived and how to re-derive it if the game is ever rebuilt against a newer Pygbag.

**`browserfs.min.js` 404s.** flappybirb's shell requests it; it's missing from the upstream CDN
too, and the game runs fine without it. The offline copy reproduces the same harmless miss rather
than pretending to have the file — it's allowlisted by name in the local reference check.

**MediaPipe `face_mesh` was unpinned upstream.** `games/aim_trainer.html` requests it without a
version, so the live site follows whatever jsdelivr calls latest. Vendoring pins it to
`0.4.1633559619`; the offline build could drift from live if that package ever moves.

## If the camera or mic is dead

`aim_trainer` (microphone) and `kameblast` (camera) rely on `getUserMedia`. Tauri serves from
`http://tauri.localhost`, which is a secure context, so the call is allowed — but WebView2's
`PermissionRequested` event defaults to **deny**. If capture doesn't work, add `webview2-com` and
`windows` to `src-tauri/Cargo.toml` and hook that event in `main.rs` to auto-approve. See the note
in `Cargo.toml`.
