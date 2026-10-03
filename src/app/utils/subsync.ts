// Live subtitle sync for the Fiesta (hls.js) player.
//
// OpenSubtitles files are often timed for a different release than the stream:
// measured on 9 titles, the most-downloaded file ranged from in sync to 0.8-1.4 s
// late to minutes off (a 25 fps DVD file on a 23.976 stream drifts ~4%). Every
// usable file was off by a constant plus a slow linear drift, so a correction
// re-measured every few seconds while watching fixes all of them.
//
// How: hls.js already appends the stream's audio to a SourceBuffer as fMP4. We
// copy each audio append, decode it at 16 kHz with the browser's own decoder
// (decodeAudioData accepts init + one fragment in Chrome, WebKit and Firefox),
// band-pass it to the speech range and keep one log-energy value per 10 ms.
// Speech/no-speech from that is correlated against when the showing track's
// cues are on screen; the best lag is the offset. No extra network requests,
// and the audio the viewer hears is untouched (we only read a copy).
//
// offset = audio time - subtitle time: a cue is shown at (its time + offset).

const RATE = 16000;
const HOP = 160; // 10 ms at 16 kHz
const BIN = HOP / RATE;

export interface CueSpan {
  start: number;
  end: number;
}

export interface OffsetEstimate {
  offset: number;
  slope: number;
  // second-best peak (>= 3 s away) / best: lower is more certain
  ratio: number;
}

// Speech mask from per-10 ms log energies: energy above a rolling 3 s median
// baseline (so music beds and room tone don't count), smoothed over 150 ms.
// NaN in = unknown (not buffered) and stays NaN.
export function speechMask(energy: Float32Array): Float32Array {
  const n = energy.length;
  const out = new Float32Array(n).fill(NaN);
  const half = 150;
  const diff = new Float32Array(n).fill(NaN);
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(energy[i])) continue;
    win.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j += 5) {
      if (!Number.isNaN(energy[j])) win.push(energy[j]);
    }
    win.sort((a, b) => a - b);
    diff[i] = energy[i] - win[win.length >> 1];
  }
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(diff[i])) continue;
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - 7); j <= Math.min(n - 1, i + 7); j++) {
      if (!Number.isNaN(diff[j])) {
        s += diff[j];
        c++;
      }
    }
    out[i] = s / c > 0.35 ? 1 : 0;
  }
  return out;
}

// Best fit of the cues to a speech mask whose bin 0 is at media time t0.
// A cue at file time x is placed at x + offset + slope * (x - tref): offset is
// the shift at tref, slope the relative speed error (a 25 fps file on a 23.976
// stream is +0.0427). Offsets are searched over [center - range, center + range]
// coarse (100 ms) for every slope, then refined at 10 ms around the winner.
// null if there is nothing to compare (no known bins or no cues in the span).
export function estimateOffset(
  mask: Float32Array,
  t0: number,
  cues: CueSpan[],
  center: number,
  range: number,
  slopes: number[] = [0],
  tref = t0 + (mask.length * BIN) / 2,
): OffsetEstimate | null {
  const n = mask.length;
  let known = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(mask[i])) {
      known++;
      sum += mask[i];
    }
  }
  if (known === 0) return null;
  const mean = sum / known;
  // prefix sums of the centered mask (unknown bins contribute 0)
  const p = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) p[i + 1] = p[i] + (Number.isNaN(mask[i]) ? 0 : mask[i] - mean);
  const t1 = t0 + n * BIN;
  const maxSlope = Math.max(...slopes.map(Math.abs));
  const reach = range + Math.abs(center) + maxSlope * (t1 - t0 + range) + 1;
  const rel = cues.filter((c) => c.end + reach > t0 && c.start - reach < t1);
  if (rel.length === 0) return null;
  const at = (t: number) => p[Math.min(n, Math.max(0, Math.round((t - t0) / BIN)))];
  const score = (d: number, sl: number) => {
    let s = 0;
    for (const c of rel) s += at(c.end + d + sl * (c.end - tref)) - at(c.start + d + sl * (c.start - tref));
    return s;
  };
  const COARSE = 0.1;
  const steps = Math.round((2 * range) / COARSE) + 1;
  let bestS = 0;
  let bestK = 0;
  let bestV = -Infinity;
  let bestRow = new Float64Array(0);
  for (const sl of slopes) {
    const row = new Float64Array(steps);
    for (let k = 0; k < steps; k++) {
      row[k] = score(center - range + k * COARSE, sl);
      if (row[k] > bestV) {
        bestV = row[k];
        bestS = sl;
        bestK = k;
        bestRow = row;
      }
    }
  }
  if (!(bestV > 0)) return null;
  let second = -Infinity;
  const gap = Math.round(3 / COARSE);
  for (let k = 0; k < steps; k++) if (Math.abs(k - bestK) >= gap && bestRow[k] > second) second = bestRow[k];
  // refine at 10 ms; the centre of the plateau (cue edges make it flat for a few bins)
  const d0 = center - range + bestK * COARSE;
  const fine: number[] = [];
  for (let k = -15; k <= 15; k++) fine.push(score(d0 + k * BIN, bestS));
  const top = Math.max(...fine);
  const idx = fine.map((v, i) => (v >= top - 1e-9 ? i : -1)).filter((i) => i >= 0);
  const offset = d0 + ((idx[0] + idx[idx.length - 1]) / 2 - 15) * BIN;
  return { offset: +offset.toFixed(2), slope: bestS, ratio: Math.max(0, second) / bestV };
}

// --- fMP4 helpers ----------------------------------------------------------

function findBox(d: Uint8Array, path: string[], from = 0, to = d.length): [number, number] | null {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let i = from;
  while (i + 8 <= to) {
    let size = dv.getUint32(i);
    const type = String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
    let head = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(i + 8));
      head = 16;
    } else if (size === 0) size = to - i;
    if (size < head) return null;
    if (type === path[0]) {
      if (path.length === 1) return [i + head, i + size];
      return findBox(d, path.slice(1), i + head, i + size);
    }
    i += size;
  }
  return null;
}

// mdhd timescale of the (single) track in an init segment
export function initTimescale(init: Uint8Array): number | null {
  const box = findBox(init, ['moov', 'trak', 'mdia', 'mdhd']);
  if (!box) return null;
  const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
  return dv.getUint8(box[0]) === 1 ? dv.getUint32(box[0] + 20) : dv.getUint32(box[0] + 12);
}

// baseMediaDecodeTime of the first traf of a media segment
export function fragmentDecodeTime(seg: Uint8Array): number | null {
  const box = findBox(seg, ['moof', 'traf', 'tfdt']);
  if (!box) return null;
  const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  return dv.getUint8(box[0]) === 1 ? Number(dv.getBigUint64(box[0] + 4)) : dv.getUint32(box[0] + 4);
}

// --- live controller ---------------------------------------------------------

interface Chunk {
  start: number; // media time of energy[0]
  energy: Float32Array;
}

// One confident measurement: the cue at file time x is heard at media time t.
interface Point {
  x: number;
  t: number;
  slope: number;
}

export interface SubSyncState {
  // shift at the playhead (s) and the fitted line: audio = a * file + b
  offset: number;
  a: number;
  b: number;
  locked: boolean;
  track: string | null;
  // decoded audio (s) inside the current estimate window, and chunks held
  known: number;
  chunks: number;
  // cost: slowest estimate so far, mean decode per ~5 s fragment (ms)
  tickMs: number;
  decodeMs: number;
  log: { t: number; est: number; slope: number; ratio: number; action: string }[];
}

interface HlsLike {
  on(event: string, fn: (event: string, data: AppendData) => void): void;
  off(event: string, fn: (event: string, data: AppendData) => void): void;
}
interface AppendData {
  type: string;
  data: Uint8Array;
  offset?: number;
}

const TICK_MS = 10_000;
const MIN_KNOWN_S = 90; // audio needed before an estimate (offline: 90 s -> confident = right)
const MIN_CUES = 12;
const COLD_RANGE = 90;
const TRACK_RANGE = 4;
const CONFIDENT = 0.8;
// ±5% covers 25 <-> 23.976 fps (4.3%) and the odd retimed file (measured: 1.85%)
const COLD_SLOPES = Array.from({ length: 41 }, (_, i) => +((i - 20) * 0.0025).toFixed(4));

// Least squares t = a*x + b; null if the x spread is too small to trust a slope.
export function fitLine(points: { x: number; t: number }[], minSpan: number): { a: number; b: number } | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x);
  if (Math.max(...xs) - Math.min(...xs) < minSpan) return null;
  const n = points.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  let sxx = 0;
  let sxt = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxt += (p.x - mx) * (p.t - mt);
  }
  const a = sxt / sxx;
  return { a, b: mt - a * mx };
}

export class SubtitleSync {
  readonly state: SubSyncState = { offset: 0, a: 1, b: 0, locked: false, track: null, known: 0, chunks: 0, tickMs: 0, decodeMs: 0, log: [] };
  private chunks: Chunk[] = [];
  private init: Uint8Array | null = null;
  private timescale = 0;
  private decoding: Promise<void> = Promise.resolve();
  private original = new WeakMap<TextTrackCue, [number, number]>();
  private trackRef: TextTrack | null = null;
  private points: Point[] = [];
  private pending: Point | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onAppend = (_e: string, d: AppendData) => this.capture(d);

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly hls: HlsLike,
    private readonly appendEvent: string,
  ) {
    hls.on(appendEvent, this.onAppend);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  // Stops measuring and puts the showing track's cues back at their file times.
  destroy() {
    if (this.trackRef) this.apply(this.trackRef, 1, 0);
    this.hls.off(this.appendEvent, this.onAppend);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.chunks = [];
  }

  private capture(d: AppendData) {
    if (d.type !== 'audio' || !d.data?.byteLength) return;
    const bytes = d.data.slice(); // our copy: the SourceBuffer append may detach/transfer the original
    if (findBox(bytes, ['moov'])) {
      this.init = bytes;
      this.timescale = initTimescale(bytes) ?? 0;
      return;
    }
    const init = this.init;
    const ts = this.timescale;
    if (!init || !ts) return;
    const tfdt = fragmentDecodeTime(bytes);
    if (tfdt === null) return;
    const start = tfdt / ts + (d.offset ?? 0);
    // decode one at a time: decoding is cheap, but a burst after a seek shouldn't pile up
    this.decoding = this.decoding.then(() => this.decode(init, bytes, start)).catch(() => {});
  }

  private decodes = 0;

  private async decode(init: Uint8Array, seg: Uint8Array, start: number) {
    const began = performance.now();
    const buf = new Uint8Array(init.byteLength + seg.byteLength);
    buf.set(init);
    buf.set(seg, init.byteLength);
    const decoded = await new OfflineAudioContext(1, RATE, RATE).decodeAudioData(buf.buffer);
    const ctx = new OfflineAudioContext(1, decoded.length, RATE);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    src.connect(hp).connect(lp).connect(ctx.destination);
    src.start();
    const pcm = (await ctx.startRendering()).getChannelData(0);
    const energy = new Float32Array(Math.floor(pcm.length / HOP));
    for (let f = 0; f < energy.length; f++) {
      let s = 0;
      for (let i = f * HOP; i < (f + 1) * HOP; i++) s += pcm[i] * pcm[i];
      energy[f] = Math.log10(s + 1e-9);
    }
    // a quality switch re-appends the same time range: replace, don't duplicate
    const now = this.video.currentTime;
    this.chunks = this.chunks.filter((c) => Math.abs(c.start - start) > 0.5 && c.start > now - 400 && c.start < now + 200);
    this.chunks.push({ start, energy });
    this.chunks.sort((a, b) => a.start - b.start);
    this.decodes++;
    this.state.decodeMs = +(this.state.decodeMs + (performance.now() - began - this.state.decodeMs) / this.decodes).toFixed(1);
  }

  // Energies on a 10 ms grid over [t0, t1); NaN where nothing was decoded.
  private energyGrid(t0: number, t1: number): Float32Array {
    const n = Math.max(0, Math.round((t1 - t0) / BIN));
    const g = new Float32Array(n).fill(NaN);
    for (const c of this.chunks) {
      const off = Math.round((c.start - t0) / BIN);
      for (let i = 0; i < c.energy.length; i++) {
        const j = off + i;
        if (j >= 0 && j < n) g[j] = c.energy[i];
      }
    }
    return g;
  }

  private showingTrack(): TextTrack | null {
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.mode === 'showing' && (t.kind === 'subtitles' || t.kind === 'captions')) return t;
    }
    return null;
  }

  // File times of the track's cues. A cue seen for the first time is at file
  // time (fillTrack adds them unshifted) and gets the current mapping applied.
  private originalCues(track: TextTrack): CueSpan[] {
    const out: CueSpan[] = [];
    const cues = track.cues;
    if (!cues) return out;
    const { a, b } = this.state;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      let o = this.original.get(c);
      if (!o) {
        o = [c.startTime, c.endTime];
        this.original.set(c, o);
        if (a !== 1 || b !== 0) this.place(c, a * o[0] + b, a * o[1] + b);
      }
      out.push({ start: o[0], end: o[1] });
    }
    return out;
  }

  private place(c: TextTrackCue, start: number, end: number) {
    // keep start <= end at every step
    if (start > c.endTime) {
      c.endTime = end;
      c.startTime = start;
    } else {
      c.startTime = start;
      c.endTime = end;
    }
  }

  private apply(track: TextTrack, a: number, b: number) {
    const cues = track.cues;
    if (cues) {
      for (let i = 0; i < cues.length; i++) {
        const o = this.original.get(cues[i]);
        if (o) this.place(cues[i], a * o[0] + b, a * o[1] + b);
      }
    }
    this.state.a = +a.toFixed(6);
    this.state.b = +b.toFixed(3);
  }

  // shift (media time - file time) the current line gives at media time t
  private offsetAt(t: number): number {
    const { a, b } = this.state;
    return t - (t - b) / a;
  }

  private note(t: number, e: OffsetEstimate | null, action: string) {
    this.state.log.push({ t: Math.round(t), est: e?.offset ?? NaN, slope: e?.slope ?? NaN, ratio: e ? +e.ratio.toFixed(2) : NaN, action });
    if (this.state.log.length > 200) this.state.log.shift();
  }

  // Line through the points: least squares once they span 2 min of the film
  // (dropping any point > 1 s off and refitting), before that the window
  // estimate's own slope through their mean.
  private model(): { a: number; b: number } {
    let pts = this.points;
    let fit = fitLine(pts, 120);
    if (fit) {
      const f = fit;
      const kept = pts.filter((p) => Math.abs(p.t - (f.a * p.x + f.b)) < 1);
      if (kept.length >= 3 && kept.length < pts.length) {
        this.points = pts = kept;
        fit = fitLine(pts, 120) ?? fit;
      }
      return fit;
    }
    // a 3-minute window can't tell 0.1% from 0: only call real drifts (frame-rate
    // mismatches are 1-4%) a slope until the points span enough film to fit one
    const slopes = pts.map((p) => p.slope).sort((x, y) => x - y);
    const median = slopes[slopes.length >> 1];
    const a = Math.abs(median) < 0.004 ? 1 : 1 + median;
    const b = pts.reduce((s, p) => s + p.t - a * p.x, 0) / pts.length;
    return { a, b };
  }

  async tick() {
    await this.decoding;
    const now = this.video.currentTime;
    const track = this.showingTrack();
    if (!track) return;
    const id = `${track.language}|${track.label}`;
    if (track !== this.trackRef || id !== this.state.track) {
      // different file, different timing: put the old one back and start over
      if (this.trackRef) this.apply(this.trackRef, 1, 0);
      this.trackRef = track;
      this.state.track = id;
      this.state.a = 1;
      this.state.b = 0;
      this.state.offset = 0;
      this.state.locked = false;
      this.points = [];
      this.pending = null;
    }
    const cues = this.originalCues(track);
    if (cues.length === 0) return;
    this.state.offset = +this.offsetAt(now).toFixed(2);

    const t0 = Math.max(0, now - 150);
    const t1 = now + 60;
    const mask = speechMask(this.energyGrid(t0, t1));
    let known = 0;
    for (let i = 0; i < mask.length; i++) if (!Number.isNaN(mask[i])) known++;
    this.state.known = Math.round(known * BIN);
    this.state.chunks = this.chunks.length;
    if (known * BIN < MIN_KNOWN_S) return;
    const tref = (t0 + t1) / 2;
    const center = this.offsetAt(tref);
    const inSpan = cues.filter((c) => c.end + center > t0 && c.start + center < t1).length;
    if (inSpan < MIN_CUES) return this.note(now, null, 'few-cues');

    const locked = this.state.locked;
    const slope0 = this.state.a - 1;
    const slopes = locked ? [-2, -1, 0, 1, 2].map((k) => slope0 + k * 0.001) : COLD_SLOPES;
    const began = performance.now();
    const e = estimateOffset(mask, t0, cues, center, locked ? TRACK_RANGE : COLD_RANGE, slopes, tref);
    this.state.tickMs = Math.max(this.state.tickMs, Math.round(performance.now() - began));
    if (!e || e.ratio > CONFIDENT) return this.note(now, e, 'unsure');
    const point: Point = { x: tref - e.offset, t: tref, slope: e.slope };

    if (!locked) {
      // cold: two estimates from audio at least 20 s apart must agree (allowing for the slope)
      const p = this.pending;
      if (p && tref - p.t >= 20 && Math.abs(p.t + (point.x - p.x) * (1 + e.slope) - point.t) < 0.5) {
        this.points = [p, point];
        this.pending = null;
        this.state.locked = true;
        const m = this.model();
        this.apply(track, m.a, m.b);
        this.state.offset = +this.offsetAt(now).toFixed(2);
        return this.note(now, e, 'lock');
      }
      if (!p || tref - p.t >= 20) this.pending = point;
      return this.note(now, e, 'pending');
    }
    // locked: a point far from the line needs a second one agreeing with it
    // before the line is thrown away (a seek onto a differently cut part, or a
    // wrong lock)
    const miss = point.t - (this.state.a * point.x + this.state.b);
    if (Math.abs(miss) > 1) {
      const p = this.pending;
      if (p && Math.abs(p.t + (point.x - p.x) * (1 + e.slope) - point.t) < 0.5) {
        this.points = [p, point];
        this.pending = null;
      } else {
        this.pending = point;
        return this.note(now, e, 'confirm');
      }
    } else {
      this.pending = null;
      // keep the line local: points from the last ~15 min of film around here
      this.points = [...this.points.filter((q) => Math.abs(q.t - point.t) < 900), point];
    }
    const m = this.model();
    const moved = Math.abs(m.a * now + m.b - (this.state.a * now + this.state.b));
    if (moved >= 0.15 || Math.abs(m.a - this.state.a) > 0.0005) {
      this.apply(track, m.a, m.b);
      this.state.offset = +this.offsetAt(now).toFixed(2);
      return this.note(now, e, 'move');
    }
    this.state.offset = +this.offsetAt(now).toFixed(2);
    this.note(now, e, 'hold');
  }
}
