#!/usr/bin/env node
// Validates .github/workflows/*.yml before they reach GitHub.
//
// A broken workflow file doesn't fail loudly — GitHub just silently declines to run it, or
// surfaces the error somewhere you won't look. Catching it locally costs a second.
//
//   npm run check:workflows

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.github', 'workflows');

if (!fs.existsSync(DIR)) {
  console.log('[workflows] no .github/workflows directory — nothing to check');
  process.exit(0);
}

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/i.test(f));
const problems = [];

for (const name of files) {
  const file = path.join(DIR, name);
  const text = fs.readFileSync(file, 'utf8');

  // YAML forbids tabs for indentation, and the error a parser gives is often cryptic.
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*\t/.test(line)) problems.push(`${name}:${i + 1}  indented with a TAB (YAML forbids tabs)`);
  });

  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    const line = err.linePos?.[0]?.line;
    problems.push(`${name}${line ? ':' + line : ''}  ${err.message.split('\n')[0]}`);
    continue;
  }

  if (!doc || typeof doc !== 'object') {
    problems.push(`${name}  parsed to nothing — is the file empty?`);
    continue;
  }

  // `on:` is the one key YAML 1.1 parsers famously mangle into the boolean true.
  const hasTrigger = 'on' in doc || true in doc;
  if (!hasTrigger) problems.push(`${name}  missing the "on:" trigger block`);
  if (!doc.jobs) problems.push(`${name}  missing the "jobs:" block`);

  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    if (!job || typeof job !== 'object') {
      problems.push(`${name}  job "${jobName}" is empty`);
      continue;
    }
    if (!job['runs-on'] && !job.uses) {
      problems.push(`${name}  job "${jobName}" has no "runs-on"`);
    }
  }

  console.log(`[workflows] ok  ${name}  (${Object.keys(doc.jobs ?? {}).length} job(s))`);
}

if (problems.length > 0) {
  console.error('\n[workflows] INVALID:\n');
  for (const p of problems) console.error('  ' + p);
  console.error('');
  process.exit(1);
}

console.log(`[workflows] all ${files.length} workflow file(s) valid`);
