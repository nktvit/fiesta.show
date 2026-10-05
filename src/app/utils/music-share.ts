import { MusicTrack } from '../services/music.service';

/**
 * Share-a-playlist links: /music/shared?d=<payload>. Owned by package P7.
 *
 * Payload = '<version>.' + base64url(body) where body is JSON {n: name,
 * d?: description, t: [track ids]}.
 *   v0: the JSON bytes as they are.
 *   v1: the JSON bytes deflate-raw compressed (CompressionStream; the builder
 *       falls back to v0 where that API is missing).
 * Both versions are always readable (v1 needs DecompressionStream).
 */

export const SHARE_MAX_IDS = 500;

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair));
  return new Uint8Array(await out.arrayBuffer());
}

/** Whether v1 links can be built and read in this browser. */
export function shareCompressionSupported(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

/** The payload string (the `d` value, not URL-encoded) for a playlist. */
export async function buildSharePayload(p: { name: string; description?: string; tracks: { id: number }[] }): Promise<string> {
  const body: { n: string; d?: string; t: number[] } = {
    n: p.name,
    t: p.tracks.map((t) => t.id).slice(0, SHARE_MAX_IDS),
  };
  if (p.description) body.d = p.description;
  const raw = new TextEncoder().encode(JSON.stringify(body));
  if (shareCompressionSupported()) {
    try {
      return '1.' + bytesToBase64Url(await pipe(raw, new CompressionStream('deflate-raw')));
    } catch {
      // fall through to v0
    }
  }
  return '0.' + bytesToBase64Url(raw);
}

/** Absolute URL to /music/shared?d=... for a playlist. */
export async function buildShareUrl(p: { name: string; description?: string; tracks: MusicTrack[] }): Promise<string> {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/music/shared?d=${encodeURIComponent(await buildSharePayload(p))}`;
}

/** The playlist in a share payload, or null when it isn't one we can read. */
export async function parseSharePayload(d: string): Promise<{ name: string; description?: string; ids: number[] } | null> {
  try {
    let bytes: Uint8Array;
    if (d.startsWith('0.')) {
      bytes = base64UrlToBytes(d.slice(2));
    } else if (d.startsWith('1.')) {
      if (!shareCompressionSupported()) return null;
      bytes = await pipe(base64UrlToBytes(d.slice(2)), new DecompressionStream('deflate-raw'));
    } else {
      return null;
    }
    const j = JSON.parse(new TextDecoder().decode(bytes)) as { n?: unknown; d?: unknown; t?: unknown };
    if (typeof j.n !== 'string' || !Array.isArray(j.t)) return null;
    const ids = j.t.filter((x): x is number => Number.isInteger(x) && (x as number) > 0).slice(0, SHARE_MAX_IDS);
    const out: { name: string; description?: string; ids: number[] } = { name: j.n.slice(0, 200), ids };
    if (typeof j.d === 'string') out.description = j.d.slice(0, 1000);
    return out;
  } catch {
    return null;
  }
}
