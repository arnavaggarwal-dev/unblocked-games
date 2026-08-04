#!/usr/bin/env node
// Thin wrapper around the Tauri CLI.
//
// Its only job is to move Rust's build output off the OneDrive-synced project path.
// `cargo` produces multiple GB of incremental artifacts in src-tauri/target, and letting
// OneDrive sync that is slow enough to be genuinely disruptive. CARGO_TARGET_DIR has to be
// an absolute path, so it can't live in .cargo/config.toml portably — hence this wrapper.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const isOneDrive = process.cwd().toLowerCase().includes('onedrive');

if (isOneDrive && !process.env.CARGO_TARGET_DIR) {
  // Prefer ~/.cargo-target (persistent, so incremental builds stay fast); fall back to temp.
  const base = path.join(homedir(), '.cargo-target') || tmpdir();
  const target = path.join(base, 'chaos-alldatime');
  mkdirSync(target, { recursive: true });
  process.env.CARGO_TARGET_DIR = target;
  console.log(`[tauri] project is inside OneDrive — redirecting Rust output to ${target}`);
}

// shell:true is required to launch npx.cmd on Windows under Node 18.20+/20.12+ (spawning a
// .cmd directly raises EINVAL). Safe here: the forwarded args are plain subcommands like
// "dev" and "build", never paths, so unquoted concatenation can't bite.
const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tauri', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' },
);

child.on('exit', (code) => process.exit(code ?? 1));
