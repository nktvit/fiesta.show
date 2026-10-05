// Runs every music e2e script (music.mjs, music-f0.mjs, music-p1.mjs ... music-p13.mjs, music-z.mjs)
// one after another against ONE ng serve + API harness, then prints a summary.
//   node tools/e2e/music-all.mjs [baseUrl=http://localhost:4200] [--shots=dir] [--token-file=path]
//        [--only=f0,p1,...] [--skip=p4,...]
// Every argument except --only/--skip is passed through unchanged to each script.
// The scripts require('playwright-core' | 'playwright'): run with NODE_PATH pointing at
// an install (the repo has none), e.g.
//   NODE_PATH=~/.nvm/versions/node/v24.11.0/lib/node_modules/@playwright/cli/node_modules
// Exit code 1 when any script fails or prints a FAIL line.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const listArg = (name) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
};
const only = listArg('only');
const skip = listArg('skip') || [];
const pass = argv.filter((a) => !a.startsWith('--only=') && !a.startsWith('--skip='));
if (!pass.some((a) => a.startsWith('http'))) pass.unshift('http://localhost:4200');
// music-p8/p9 also call the API harness directly (default: the Z harness on 3999).
if (!pass.some((a) => a.startsWith('--api='))) pass.push('--api=http://localhost:3999');
// music-p12 checks the shipped state of the downloads switch (off) unless told otherwise.
const extra = (file) => (file === 'music-p12.mjs' && !pass.some((a) => a.startsWith('--expect=')) ? ['--expect=off'] : []);

const order = (f) => {
  if (f === 'music.mjs') return -2;
  const m = f.match(/^music-(f0|z|p(\d+))\.mjs$/);
  if (!m) return 1e9;
  return m[1] === 'f0' ? -1 : m[1] === 'z' ? 1e6 : Number(m[2]);
};
const idOf = (f) => (f === 'music.mjs' ? 'music' : f.replace(/^music-|\.mjs$/g, ''));
const scripts = readdirSync(here)
  .filter((f) => f === 'music.mjs' || /^music-(f0|z|p\d+)\.mjs$/.test(f))
  .sort((a, b) => order(a) - order(b))
  .filter((f) => (!only || only.includes(idOf(f))) && !skip.includes(idOf(f)));

function run(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let passN = 0;
    let failN = 0;
    const fails = [];
    const child = spawn(process.execPath, [join(here, file), ...pass, ...extra(file)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const onLine = (line) => {
      if (/^PASS\b/.test(line)) passN++;
      if (/^FAIL\b/.test(line)) { failN++; fails.push(line); }
      process.stdout.write(`[${idOf(file)}] ${line}\n`);
    };
    let buf = '';
    const feed = (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(onLine);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    // A hung script must not stall the whole suite.
    const timer = setTimeout(() => { fails.push('TIMEOUT after 10 min'); child.kill('SIGKILL'); }, 10 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      resolve({ file, code, passN, failN, fails, secs: Math.round((Date.now() - t0) / 1000) });
    });
  });
}

const results = [];
for (const f of scripts) {
  console.log(`\n=== ${f} ===`);
  results.push(await run(f));
}

console.log('\n=== Summary ===');
let bad = 0;
for (const r of results) {
  const ok = r.code === 0 && r.failN === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(16)} ${String(r.passN).padStart(3)} pass ${String(r.failN).padStart(3)} fail  exit ${r.code}  ${r.secs}s`);
  for (const l of r.fails) console.log(`        ${l}`);
}
console.log(`\n${results.length - bad}/${results.length} scripts passed`);
process.exit(bad ? 1 : 0);
