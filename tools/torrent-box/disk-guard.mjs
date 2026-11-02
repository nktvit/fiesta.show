// The Mac mini's boot disk is a small SSD; downloads must never land there.
// A path is accepted only if its volume is EXTERNAL and spinning (a HDD), per `diskutil info`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const run = promisify(execFile);

/** Parse the "Key:   value" lines of `diskutil info`. */
export function parseDiskutil(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** Pure decision, unit-tested: external and not solid state. */
export function isExternalHdd(info) {
  return info['Device Location'] === 'External' && info['Solid State'] === 'No';
}

/**
 * Throws unless `dir` lives on an external HDD. `allowAnyDisk` (dev/test only, never set on the
 * mini) skips the check so the service can be exercised on a laptop.
 */
export async function assertExternalHdd(dir, { allowAnyDisk = false } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const real = await fs.realpath(dir);
  if (allowAnyDisk) return real;
  if (!real.startsWith('/Volumes/')) throw new Error(`refusing ${real}: not under /Volumes (would be the boot disk)`);
  const { stdout } = await run('diskutil', ['info', real]);
  const info = parseDiskutil(stdout);
  if (!isExternalHdd(info)) {
    throw new Error(`refusing ${real}: volume "${info['Volume Name']}" is ${info['Device Location']}/solid-state=${info['Solid State']}, need an external HDD`);
  }
  return real;
}
