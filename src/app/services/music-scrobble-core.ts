import { MusicTrack } from './music.service';

/** Pure scrobbling logic: thresholds, played-time clock, queue, payload builders. */

/** Never scrobble a track shorter than this (Last.fm rule). */
export const SCROBBLE_MIN_DURATION = 30;
/** A track scrobbles after at most this many played seconds. */
export const SCROBBLE_MAX_THRESHOLD = 240;
export const SCROBBLE_QUEUE_MAX = 500;

/** Played seconds needed before `duration` scrobbles at `percent`, or null when it never scrobbles. */
export function scrobbleThreshold(duration: number, percent: number): number | null {
  if (!Number.isFinite(duration) || duration < SCROBBLE_MIN_DURATION) return null;
  const pct = Math.min(100, Math.max(1, Number.isFinite(percent) ? percent : 50));
  return Math.min((duration * pct) / 100, SCROBBLE_MAX_THRESHOLD);
}

/** Counts played seconds only while running (paused time and seeks add nothing). */
export class PlayClock {
  private acc = 0;
  private since: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get running(): boolean {
    return this.since !== null;
  }

  start(): void {
    if (this.since === null) this.since = this.now();
  }

  stop(): void {
    if (this.since !== null) {
      this.acc += Math.max(0, this.now() - this.since) / 1000;
      this.since = null;
    }
  }

  reset(): void {
    this.acc = 0;
    this.since = null;
  }

  /** Played seconds so far. */
  seconds(): number {
    return this.acc + (this.since === null ? 0 : Math.max(0, this.now() - this.since) / 1000);
  }
}

/** The metadata every service needs; small enough to keep in the retry queue. */
export interface ScrobbleMeta {
  artist: string;
  title: string;
  album: string;
  /** Seconds. */
  duration: number;
  trackNumber: number;
  isrc: string;
}

const ARTIST_SPLIT = /\s*[&,]\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+with\s+|\s+x\s+/i;

/** First credited artist (scrobbling "A & B" as "A" keeps one clean entry per artist). */
export function primaryArtist(track: Pick<MusicTrack, 'artist' | 'artists'>): string {
  const first = track.artists?.[0]?.name?.trim();
  if (first) return first;
  const name = (track.artist || '').split(ARTIST_SPLIT)[0]?.trim();
  return name || 'Unknown Artist';
}

/** Title without trailing "(Remastered 2011)" style noise is NOT stripped: services match on the full title. */
export function scrobbleMeta(track: MusicTrack): ScrobbleMeta {
  return {
    artist: primaryArtist(track),
    title: (track.version ? `${track.title} (${track.version})` : track.title).trim(),
    album: track.album || '',
    duration: Math.floor(track.duration || 0),
    trackNumber: track.trackNumber || 0,
    isrc: track.isrc || '',
  };
}

export type ScrobbleServiceId = 'listenbrainz' | 'maloja' | 'librefm' | 'lastfm';
export const SCROBBLE_SERVICES: ScrobbleServiceId[] = ['listenbrainz', 'maloja', 'librefm', 'lastfm'];

export interface ScrobbleQueueItem {
  /** Unique within the queue. */
  id: string;
  service: ScrobbleServiceId;
  kind: 'scrobble' | 'love';
  meta: ScrobbleMeta;
  /** Epoch seconds the track started (scrobbles). */
  ts: number;
  tries: number;
}

/** Appends `item`, dropping the oldest entries past the cap and exact duplicates. */
export function enqueue(queue: ScrobbleQueueItem[], item: ScrobbleQueueItem): ScrobbleQueueItem[] {
  const dupe = queue.some((q) => q.service === item.service && q.kind === item.kind && q.ts === item.ts && q.meta.title === item.meta.title && q.meta.artist === item.meta.artist);
  const next = dupe ? queue : [...queue, item];
  return next.length > SCROBBLE_QUEUE_MAX ? next.slice(next.length - SCROBBLE_QUEUE_MAX) : next;
}

/** Whether a page served over https would block `url` as mixed content. */
export function isMixedContent(url: string, pageProtocol: string): boolean {
  return pageProtocol === 'https:' && /^http:\/\//i.test(url.trim());
}

/** Normalises a user-typed server URL: adds https://, strips trailing slashes. '' when unusable. */
export function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// ── payload builders ───────────────────────────────────────────────────────

export function listenBrainzPayload(type: 'single' | 'playing_now', meta: ScrobbleMeta, ts: number): unknown {
  const info: Record<string, unknown> = {
    submission_client: 'Stream Fiesta',
    media_player: 'Stream Fiesta',
    music_service: 'tidal.com',
  };
  if (meta.duration) info['duration'] = meta.duration;
  if (meta.trackNumber) info['tracknumber'] = meta.trackNumber;
  if (meta.isrc) info['isrc'] = meta.isrc;
  const track_metadata: Record<string, unknown> = { artist_name: meta.artist, track_name: meta.title, additional_info: info };
  if (meta.album) track_metadata['release_name'] = meta.album;
  const entry: Record<string, unknown> = { track_metadata };
  if (type === 'single') entry['listened_at'] = ts;
  return { listen_type: type, payload: [entry] };
}

export function malojaForm(meta: ScrobbleMeta, ts: number, key: string): Record<string, string> {
  const out: Record<string, string> = { artist: meta.artist, title: meta.title, key, time: String(ts) };
  if (meta.album) out['album'] = meta.album;
  if (meta.duration) out['duration'] = String(meta.duration);
  return out;
}

/** Params shared by Last.fm and Libre.fm (audioscrobbler 2.0). */
export function audioscrobblerParams(kind: 'nowplaying' | 'scrobble' | 'love', meta: ScrobbleMeta, ts: number): Record<string, string> {
  const out: Record<string, string> = { artist: meta.artist, track: meta.title };
  if (kind === 'love') return out;
  if (meta.album) out['album'] = meta.album;
  if (meta.duration) out['duration'] = String(meta.duration);
  if (meta.trackNumber) out['trackNumber'] = String(meta.trackNumber);
  if (kind === 'scrobble') out['timestamp'] = String(ts);
  return out;
}

/** Last.fm / Libre.fm request signature: sorted `name+value` pairs plus the secret. */
export function audioscrobblerSign(params: Record<string, string>, secret: string, md5: (s: string) => string): string {
  const base = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return md5(base + secret);
}
