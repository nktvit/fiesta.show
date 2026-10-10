import { MusicManifest } from '../services/music.service';
import { SEG_MAX_BATCH, batchUrl } from './music-seg-batch';

/**
 * Fetches a track's audio through the manifest and seg proxy: a "segments"
 * manifest is the init segment plus every numbered media segment (8 per request, 2 requests at a time),
 * a "file" manifest is one URL. Progress counts segments. Owned by package P12.
 */

export const SEGMENT_CONCURRENCY = 2;

export interface FetchedAudio {
  kind: 'segments' | 'file';
  codec: string;
  mime: string;
  /** Init segment (segments) or empty (file). */
  init: Uint8Array;
  /** Media segments in order, or the whole file as the only item. */
  parts: Uint8Array[];
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'arrayBuffer'>>;

async function getBytes(f: FetchLike, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const r = await f(url, { signal });
  if (!r.ok) throw new Error(`audio ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Retries a flaky segment twice (not when aborted). */
async function getWithRetry(f: FetchLike, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await getBytes(f, url, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e;
    }
  }
  throw last;
}

export async function fetchAudio(
  m: MusicManifest,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void; fetchFn?: FetchLike } = {},
): Promise<FetchedAudio> {
  const f: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const { signal, onProgress } = opts;
  if (m.kind === 'file') {
    if (!m.url) throw new Error('manifest has no url');
    const bytes = await getWithRetry(f, m.url, signal);
    onProgress?.(1);
    return { kind: 'file', codec: m.codec || '', mime: m.mime || '', init: new Uint8Array(0), parts: [bytes] };
  }
  if (!m.init || !m.media) throw new Error('manifest has no segments');
  const count = Math.max(1, m.durations?.length ?? 1);
  const total = count + 1;
  let done = 0;
  const tick = () => onProgress?.(++done / total);
  const init = await getWithRetry(f, m.init, signal);
  tick();
  // One request per batch of up to SEG_MAX_BATCH segments; a part is a batch's concatenated
  // fragments (the remuxer and the MP4 writer both take concatenated fragments).
  const batches = Math.ceil(count / SEG_MAX_BATCH);
  const parts: Uint8Array[] = new Array<Uint8Array>(batches);
  let next = 0;
  const worker = async () => {
    while (next < batches) {
      const b = next++;
      const first = b * SEG_MAX_BATCH + 1;
      const c = Math.min(SEG_MAX_BATCH, count - first + 1);
      parts[b] = await getWithRetry(f, batchUrl(m.media!, first, c), signal);
      for (let k = 0; k < c; k++) tick();
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, batches) }, worker));
  return { kind: 'segments', codec: m.codec || '', mime: m.mime || '', init, parts };
}

/** What the audio will be saved as. FLAC codec -> .flac (remuxed or native); everything else -> .m4a. */
export function audioKind(codec: string, mime = ''): 'flac' | 'm4a' {
  return /flac/i.test(codec) || /flac/i.test(mime) ? 'flac' : 'm4a';
}
