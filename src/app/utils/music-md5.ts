// Ported from Monochrome (Apache-2.0), js/md5.js - adapted for Fiesta (rewritten as a typed UTF-8 MD5).
/** MD5 of a string (UTF-8), lowercase hex. Used for Libre.fm request signatures. */

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0) ?? 0;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function md5(input: string): string {
  const bytes = utf8(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 4294967296) >>> 0;
  for (let i = 0; i < 4; i++) bytes.push((lo >>> (8 * i)) & 255);
  for (let i = 0; i < 4; i++) bytes.push((hi >>> (8 * i)) & 255);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < bytes.length; off += 64) {
    const m: number[] = [];
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      m.push((bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24)) >>> 0);
    }
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + K[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      const s = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  let hex = '';
  for (const v of [a0, b0, c0, d0]) for (let i = 0; i < 4; i++) hex += ((v >>> (8 * i)) & 255).toString(16).padStart(2, '0');
  return hex;
}
