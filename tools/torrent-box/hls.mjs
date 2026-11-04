// MKV/AVI/anything -> HLS (fMP4) for browsers, produced ON DEMAND while the torrent may still be downloading.
//
// The player is given the complete playlist of the movie at once (a fixed grid of segments computed from the
// probe, so the whole timeline is seekable and the duration is the real one). Segments are produced only when
// somebody asks for them:
//  - one ffmpeg process per video rung / audio track, started at the requested segment (-ss), so a seek into
//    a part that was never encoded starts a new process right there;
//  - a process stays at most AHEAD_SEGMENTS in front of the last request (SIGSTOP), so only what is watched
//    gets encoded; a rung nobody asks for is never encoded;
//  - a process stops when it reaches a segment that already exists.
// ffmpeg reads the movie from the box's own /stream/:id (Range-capable, pieces prioritised where it reads).
// Layout: <root>/.fiesta/hls/<id>/{plan.json, subs/N.vtt, v<i>/{init.mp4, seg_00000.m4s, ...}, run-*/ (scratch)}.
//
// Hardware encoder only (Apple VideoToolbox on the M4): no software x264/x265, ever. Video is always re-encoded
// to H.264 8-bit SDR (constant quality, -q:v), capped at 4K; every audio track becomes AAC stereo 48 kHz.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const MAX_AUDIO_TRACKS = 6;
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']); // bitmap subs (PGS, VobSub) cannot be turned into text
/** Bump when the output layout/quality changes: a directory of another layout is wiped and redone on demand. */
export const FORMAT_VERSION = '5';
// VideoToolbox constant quality is greedy and its SSIM climbs slowly. Measured on a grainy 31.7 Mbit/s Blu-ray remux
// (1080p, hardware decode): q50 ~6 Mbit/s | q60 ~13 | q70 ~27. q60 on top, q50 as a lighter 1080p rung for slow links.
const Q_HIGH = 60;
const Q_MID = 50;
const Q_MAX = 70; // a heavy source (Blu-ray remux) also gets a near-source rung, for viewers whose link can carry it
const MAX_RUNG_SOURCE_BPS = 20_000_000;
const Q_4K = 55; // 4K needs fewer bits per pixel for the same look (no 4K sample yet to measure)
const BPS_1080 = { [Q_MAX]: 25_000_000, [Q_HIGH]: 12_000_000, [Q_MID]: 6_000_000, [Q_4K]: 8_000_000 }; // declared BANDWIDTH only; hls.js measures the real thing
const bandwidthFor = (w, h, q) => Math.round((BPS_1080[q] ?? 8_000_000) * ((w * h) / (1920 * 1080)) ** 0.75);
const MAX_HEIGHT = 2160; // ceiling: 4K
const HWDEC = process.env.HWDEC !== '0'; // decode H.264/HEVC on the media engine too (frees the CPU)
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export const SEG_SECONDS = 4;
const AAC_FRAME = 1024;
const AUDIO_RATE = 48000;

/** Pure: ffprobe JSON (-show_streams -show_format) -> what to do. */
export function planFromProbe(probe) {
  const streams = probe?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('no video stream');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const w = +video.width || 1920;
  const h = +video.height || 1080;
  const total = +probe?.format?.bit_rate || 0;
  const bps = +video.bit_rate || (total ? Math.max(0, total - audioStreams.reduce((n, s) => n + (+s.bit_rate || 192_000), 0)) : 0);

  const topH = Math.min(h, MAX_HEIGHT);
  const heavy = bps >= MAX_RUNG_SOURCE_BPS;
  const heights = topH > 1440 ? [[topH, Q_4K], [1080, Q_HIGH], [720, Q_MID]]
    : topH >= 1000 ? [...(heavy ? [[topH, Q_MAX]] : []), [topH, Q_HIGH], [topH, Q_MID], [720, Q_MID]]
    : topH > 720 ? [[topH, Q_HIGH], [topH, Q_MID]]
    : [[topH, Q_HIGH]];
  const renditions = heights.map(([rh, q]) => {
    const rw = even((w * rh) / h);
    return { w: rw, h: rh, q, bandwidth: bandwidthFor(rw, rh, q) };
  });

  const audios = audioStreams.slice(0, MAX_AUDIO_TRACKS).map((s, k) => ({
    k, codec: s.codec_name, channels: +s.channels || 2, lang: s.tags?.language || 'und', title: s.tags?.title || '',
  }));
  // The first track is the default: releases list the dub they were made for first; the viewer can switch.
  audios.forEach((x, i) => { x.default = i === 0; });

  // Text subtitles, numbered as ffmpeg's `-map 0:s:N` counts every subtitle stream (bitmap ones included).
  const subs = [];
  streams.filter((s) => s.codec_type === 'subtitle').forEach((s, ordinal) => {
    if (TEXT_SUBS.has(s.codec_name)) subs.push({ index: subs.length, ordinal, lang: s.tags?.language || 'und', title: s.tags?.title || '' });
  });

  const [fn, fd] = String(video.r_frame_rate || '').split('/').map(Number);
  const fps = fn > 0 && fd > 0 && fn / fd >= 5 && fn / fd <= 121 ? [fn, fd] : [24, 1];

  return {
    layout: FORMAT_VERSION,
    duration: +probe?.format?.duration || 0,
    fps,
    hwdec: HWDEC && (video.codec_name === 'h264' || video.codec_name === 'hevc'),
    videoCodec: video.codec_name,
    sourceBps: bps,
    renditions,
    audios,
    audioCodec: audios[0]?.codec ?? null,
    subs,
  };
}

// ---- the segment grid ---------------------------------------------------------------------------------
// Video segment k starts at the first frame at or after k*4 s, so every boundary is a whole frame and the
// pattern (96 or 95 frames at 23.976 fps) never drifts. Audio segment j starts at AAC frame ceil(187.5*j).
// ffmpeg cuts exactly there when keyframes are forced on that grid (see runArgs), whatever frame a run starts at.
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
/** First frame index of video segment k, and its start in seconds. */
export const videoStartFrame = (plan, k) => ceilDiv(SEG_SECONDS * k * plan.fps[0], plan.fps[1]);
export const videoStart = (plan, k) => (videoStartFrame(plan, k) * plan.fps[1]) / plan.fps[0];
export const audioStartFrame = (k) => ceilDiv(SEG_SECONDS * k * AUDIO_RATE, AAC_FRAME);
export const audioStart = (k) => (audioStartFrame(k) * AAC_FRAME) / AUDIO_RATE;

/** Pure: [{start, duration}] for every segment of the movie, for a video rung or an audio track. */
export function segmentGrid(plan, kind) {
  const at = kind === 'audio' ? audioStart : (k) => videoStart(plan, k);
  const out = [];
  for (let k = 0; at(k) < plan.duration - 0.01; k++) {
    const next = at(k + 1);
    out.push({ start: at(k), duration: Math.min(next, plan.duration) - at(k) });
  }
  return out;
}

/** Pure: the complete VOD playlist of one rendition (output index i: video rungs first, then audio tracks). */
export function mediaPlaylist(plan, i) {
  const grid = segmentGrid(plan, i < plan.renditions.length ? 'video' : 'audio');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(SEG_SECONDS + 0.5)}`, '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="init.mp4"'];
  grid.forEach((s, k) => lines.push(`#EXTINF:${s.duration.toFixed(6)},`, `seg_${String(k).padStart(5, '0')}.m4s`));
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

const outCount = (plan) => plan.renditions.length + plan.audios.length;
const isAudioOut = (plan, i) => i >= plan.renditions.length;
export const segmentCount = (plan, i) => segmentGrid(plan, isAudioOut(plan, i) ? 'audio' : 'video').length;

const baseArgs = (plan, input, probe = ['50M', '20M']) => {
  const a = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-nostats', '-probesize', probe[0], '-analyzeduration', probe[1]];
  if (plan.hwdec) a.push('-hwaccel', 'videotoolbox');
  return a;
};
const hlsOut = (startNumber, initName) => ['-f', 'hls', '-hls_time', String(SEG_SECONDS), '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
  '-hls_segment_options', 'use_editlist=0', // no edit list: the init file is the same whatever frame a run starts at
  '-hls_flags', 'independent_segments+temp_file', '-hls_fmp4_init_filename', initName, '-start_number', String(startNumber)];

/** Pure: ffmpeg arguments for ONE output (video rung or audio track) from segment `startSeg` on; cwd = the run's scratch dir. */
export function runArgs(plan, input, outIndex, startSeg) {
  const a = baseArgs(plan, input, ['20M', '10M']); // the streams are known from the plan: probe less
  if (!isAudioOut(plan, outIndex)) {
    const r = plan.renditions[outIndex];
    // -copyts -start_at_zero keeps the movie's own clock (zero at its first frame) through -ss, so the forced keyframes
    // sit on the same absolute 4 s grid as in a run that began at 0.
    if (startSeg > 0) a.push('-ss', (videoStart(plan, startSeg) - 0.002).toFixed(6));
    a.push('-copyts', '-start_at_zero', '-i', input,
      '-filter_complex', `[0:v:0]scale=${r.w}:${r.h}:flags=bicubic,format=yuv420p[o]`, '-map', '[o]',
      '-c:v', 'h264_videotoolbox', '-q:v', String(r.q), '-profile:v', 'high',
      '-force_key_frames', `expr:gte(t,(n_forced+${startSeg})*${SEG_SECONDS})`, '-an', '-sn', '-dn',
      ...hlsOut(startSeg, 'run_init.mp4'), '-hls_segment_filename', 'seg_%05d.m4s', 'index.m3u8');
  } else {
    const x = plan.audios[outIndex - plan.renditions.length];
    if (startSeg > 0) a.push('-ss', String(audioStart(startSeg)));
    a.push('-copyts', '-start_at_zero', '-i', input, '-map', `0:a:${x.k}`, '-c:a', 'aac', '-ac', '2', '-ar', String(AUDIO_RATE), '-b:a', '160k',
      '-vn', '-sn', '-dn', ...hlsOut(startSeg, 'run_init.mp4'), '-hls_segment_filename', 'seg_%05d.m4s', 'index.m3u8');
  }
  return a;
}

/** Audio runs start on an even segment: 187.5 AAC frames per segment is a whole number only for even j. */
export const alignStart = (plan, outIndex, k) => (isAudioOut(plan, outIndex) ? k - (k % 2) : k);

/** Pure: ffmpeg arguments for the one-off pass that writes every rendition's init segment (first seconds of the movie). */
export function initArgs(plan, input) {
  const n = plan.renditions.length;
  const a = baseArgs(plan, input);
  a.push('-copyts', '-start_at_zero', '-t', '3', '-i', input);
  const chains = plan.renditions.map((r, i) => `[s${i}]scale=${r.w}:${r.h}:flags=bicubic,format=yuv420p[o${i}]`);
  a.push('-filter_complex', [`[0:v:0]split=${n}${plan.renditions.map((_, i) => `[s${i}]`).join('')}`, ...chains].join(';'));
  plan.renditions.forEach((_, i) => a.push('-map', `[o${i}]`));
  plan.renditions.forEach((r, i) => a.push(`-c:v:${i}`, 'h264_videotoolbox', `-q:v:${i}`, String(r.q)));
  a.push('-profile:v', 'high', '-force_key_frames', `expr:gte(t,n_forced*${SEG_SECONDS})`);
  plan.audios.forEach((x, i) => a.push('-map', `0:a:${x.k}`, `-c:a:${i}`, 'aac', `-ac:a:${i}`, '2', `-ar:a:${i}`, String(AUDIO_RATE), `-b:a:${i}`, '160k'));
  a.push('-sn', '-dn', ...hlsOut(0, 'init_%v.mp4'), '-hls_segment_filename', 'v%v/seg_%05d.m4s',
    '-var_stream_map', Array.from({ length: outCount(plan) }, (_, i) => (i < n ? `v:${i}` : `a:${i - n}`)).join(' '), 'v%v/index.m3u8');
  return a;
}

/** Pure: ffmpeg arguments that pull the text subtitle tracks out as WebVTT (reads the whole container, no decoding). */
export function subtitleArgs(plan, input) {
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input];
  plan.subs.forEach((s, i) => a.push('-map', `0:s:${s.ordinal}`, '-c:s', 'webvtt', '-f', 'webvtt', `subs/${i}.vtt`));
  return a;
}

/** Pure: the master playlist (ffmpeg cannot know the bitrate of a constant-quality encode). */
export function masterPlaylist(plan) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const nv = plan.renditions.length;
  const esc = (t) => String(t).replace(/["\r\n]/g, ' ').slice(0, 80);
  plan.audios.forEach((x, i) => {
    const name = esc([x.lang !== 'und' ? x.lang : '', x.title, x.channels > 2 ? `${x.channels}ch` : ''].filter(Boolean).join(' ') || `Track ${i + 1}`);
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}",LANGUAGE="${esc(x.lang)}",DEFAULT=${x.default ? 'YES' : 'NO'},AUTOSELECT=YES,CHANNELS="2",URI="v${nv + i}/index.m3u8"`);
  });
  plan.renditions.forEach((r, i) => {
    const hasAudio = plan.audios.length > 0;
    const codecs = `,CODECS="avc1.${r.h > 1440 ? '640033' : r.h > 720 ? '640028' : '64001f'}${hasAudio ? ',mp4a.40.2' : ''}"`;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth + 160_000},RESOLUTION=${r.w}x${r.h}${codecs}${hasAudio ? ',AUDIO="aud"' : ''}`, `v${i}/index.m3u8`);
  });
  return lines.join('\n') + '\n';
}

// ---- fMP4 timestamps -------------------------------------------------------------------------------------
// A run's first fragment has baseMediaDecodeTime 0 (ffmpeg rebases it). Add the run's start so that a segment from
// a run that began at segment M carries the same time as the one a run from 0 would have written.
/** Timescale of the first track in an init segment (moov/trak/mdia/mdhd). */
export function mdhdTimescale(init) {
  const i = init.indexOf('mdhd');
  if (i < 0) return 0;
  const v = init[i + 4];
  return init.readUInt32BE(i + 4 + 4 + (v === 1 ? 16 : 8));
}

/** Add `ticks` to every tfdt in a media segment, in place. Returns the buffer. */
export function patchTfdt(seg, ticks) {
  if (!ticks) return seg;
  for (let i = seg.indexOf('tfdt'); i >= 0; i = seg.indexOf('tfdt', i + 4)) {
    const v = seg[i + 4];
    if (v === 1) seg.writeBigUInt64BE(seg.readBigUInt64BE(i + 8) + BigInt(ticks), i + 8);
    else seg.writeUInt32BE(seg.readUInt32BE(i + 8) + ticks, i + 8);
  }
  return seg;
}

/** The run's first fragment sits at tfdt 0; this is what to add for a run that starts at segment `startSeg`. */
export function startTicks(plan, outIndex, startSeg, timescale) {
  if (!startSeg) return 0;
  return isAudioOut(plan, outIndex)
    ? Math.round((audioStartFrame(startSeg) * AAC_FRAME * timescale) / AUDIO_RATE)
    : Math.round((videoStartFrame(plan, startSeg) * plan.fps[1] * timescale) / plan.fps[0]);
}

export const HLS_FILE = /^(master\.m3u8|v\d\/(index\.m3u8|init\.mp4|seg_\d{5}\.m4s))$/;
export const HLS_MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

const exists = (p) => fs.access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const segName = (k) => `seg_${String(k).padStart(5, '0')}.m4s`;

// ---- scheduler -------------------------------------------------------------------------------------------
// A movie being watched costs disk reads: the encoder reads the source at about REALTIME x the playback rate, so a
// new movie is admitted only while the disk can feed it on top of the others (all rungs of one movie read roughly
// the same place, so they count once).
export const REALTIME = 1.5;
const BUDGET_BPS = (+process.env.ENCODE_BUDGET_MBPS || 480) * 1e6; // ~60 MB/s sustained from a USB HDD shared with downloads
const MAX_WATCH = +process.env.MAX_WATCH_ENCODES || 3;
const UNKNOWN_SOURCE_BPS = 40_000_000;
const AHEAD_SEGMENTS = +process.env.AHEAD_SEGMENTS || 24; // ~100 s: how far an encode may run in front of the viewer
const NEAR_SEGMENTS = 20; // a request this close in front of a running encode just waits for it
const IDLE_KILL_MS = 10 * 60_000; // nobody asked for this movie for ten minutes: stop its processes
const WAIT_MS = 60_000;

/** Pure: may another movie (source bitrate `sourceBps`) start next to the ones already encoding? */
export function admit({ runningSourceBps, sourceBps, budget = BUDGET_BPS, maxWatch = MAX_WATCH }) {
  const cost = (sourceBps || UNKNOWN_SOURCE_BPS) * REALTIME;
  const used = runningSourceBps.reduce((n, b) => n + (b || UNKNOWN_SOURCE_BPS) * REALTIME, 0);
  if (runningSourceBps.length >= maxWatch) return { ok: false, reason: `already ${maxWatch} movies being encoded for viewers` };
  if (used + cost > budget) return { ok: false, reason: 'the disk is busy feeding other movies' };
  return { ok: true };
}

export function createHls({ root }) {
  const base = path.join(root, '.fiesta', 'hls');
  /** id -> session: { id, dir, plan, input, runs: Map<outIndex, run>, last: Map<outIndex, segment>, lastAt, subsDone, subsProc } */
  const sessions = new Map();
  const preparing = new Map(); // id -> Promise<session>
  const dirOf = (id) => path.join(base, id);
  // Once a download is complete ffmpeg reads the file itself from the disk: no detour through the box's HTTP stream.
  const files = new Map();
  const inputOf = (s) => files.get(s.id) || s.input;
  const useFile = (id, p) => { if (p) files.set(id, p); };
  const finalPath = (s, i, name) => path.join(s.dir, `v${i}`, name);

  const liveRun = (r) => r && !r.exited;
  const liveRuns = (s) => [...s.runs.values()].filter(liveRun);

  async function probe(inputUrl) {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-probesize', '50M', '-analyzeduration', '20M', '-print_format', 'json', '-show_streams', '-show_format', inputUrl], { maxBuffer: 8 << 20, timeout: 120_000 });
    return planFromProbe(JSON.parse(stdout));
  }
  const readPlan = async (dir) => { try { return JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')); } catch { return null; } };

  /** Probe once, write the init segments and pull the subtitles; no video is encoded here. */
  async function prepare(id, input) {
    let s = sessions.get(id);
    if (s) { s.input = input; return s; }
    let p = preparing.get(id);
    if (!p) {
      p = (async () => {
        const dir = dirOf(id);
        let plan = await readPlan(dir);
        if (!plan || plan.layout !== FORMAT_VERSION) {
          await fs.rm(dir, { recursive: true, force: true }); // another layout (or a crashed half-prepare): start clean
          plan = await probe(input);
          await fs.mkdir(path.join(dir, 'subs'), { recursive: true });
          await Promise.all(Array.from({ length: outCount(plan) }, (_, i) => fs.mkdir(path.join(dir, `v${i}`), { recursive: true })));
          await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan));
        }
        const sess = { id, dir, plan, input, runs: new Map(), last: new Map(), lastAt: Date.now(), subsDone: plan.subs.length === 0 || (await exists(path.join(dir, 'subs', '.done'))), subsProc: null };
        await writeInits(sess);
        sessions.set(id, sess);
        console.log(`[hls] ${id} planned: ${plan.videoCodec} ${Math.round(plan.sourceBps / 1000)} kbit/s ${plan.fps.join('/')} fps, ${plan.renditions.map((r) => `${r.w}x${r.h} q${r.q}`).join(' + ')}; audio ${plan.audios.length ? plan.audios.map((x) => `${x.lang}:${x.codec}`).join(',') : 'none'}; subs ${plan.subs.length}; ${Math.round(plan.duration / 60)} min`);
        return sess;
      })().finally(() => preparing.delete(id));
      preparing.set(id, p);
    }
    return p;
  }

  async function writeInits(s) {
    const missing = [];
    for (let i = 0; i < outCount(s.plan); i++) if (!(await exists(finalPath(s, i, 'init.mp4')))) missing.push(i);
    if (!missing.length) return;
    const tmp = path.join(s.dir, 'run-init');
    await fs.rm(tmp, { recursive: true, force: true });
    await Promise.all(Array.from({ length: outCount(s.plan) }, (_, i) => fs.mkdir(path.join(tmp, `v${i}`), { recursive: true })));
    const proc = spawn(FFMPEG, initArgs(s.plan, inputOf(s)), { cwd: tmp, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    const code = await new Promise((resolve) => proc.once('close', resolve));
    for (let i = 0; i < outCount(s.plan); i++) {
      const f = path.join(tmp, `v${i}`, `init_${i}.mp4`);
      if (await exists(f)) await fs.rename(f, finalPath(s, i, 'init.mp4'));
    }
    await fs.rm(tmp, { recursive: true, force: true });
    for (const i of missing) if (!(await exists(finalPath(s, i, 'init.mp4')))) throw new Error(`could not write the init segment (ffmpeg ${code}): ${err.replace(/https?:\/\/\S+/g, '<url>').slice(-300)}`);
  }

  // Subtitles sit all over a container, so pulling them out reads the WHOLE file: done once, when the download is
  // complete, straight from the disk (not through the box's HTTP stream) and at background priority so it never
  // slows a viewer down.
  async function startSubs(s, filePath) {
    if (s.subsDone || s.subsProc || !s.plan.subs.length || !filePath || !(await exists(filePath))) return;
    const args = subtitleArgs(s.plan, filePath);
    const sp = process.platform === 'darwin' ? spawn('taskpolicy', ['-b', FFMPEG, ...args], { cwd: s.dir, stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn(FFMPEG, args, { cwd: s.dir, stdio: ['ignore', 'ignore', 'pipe'] });
    s.subsProc = sp;
    sp.stderr.on('data', () => {});
    sp.on('close', (code) => {
      s.subsProc = null;
      if (code === 0) { s.subsDone = true; fs.writeFile(path.join(s.dir, 'subs', '.done'), '').catch(() => {}); }
      console.log(`[hls] ${s.id} subtitles ${code === 0 ? 'extracted (' + s.plan.subs.length + ')' : 'extraction ended with ' + code}`);
    });
  }

  // ---- runs ----------------------------------------------------------------------------------------------
  /** Start one ffmpeg process for output `i` at segment `k`. */
  async function startRun(s, i, k) {
    const startSeg = alignStart(s.plan, i, k);
    const scratch = path.join(s.dir, `run-${i}-${Date.now()}`);
    await fs.mkdir(scratch, { recursive: true });
    const timescale = mdhdTimescale(await fs.readFile(finalPath(s, i, 'init.mp4')));
    const proc = spawn(FFMPEG, runArgs(s.plan, inputOf(s), i, startSeg), { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
    const r = { i, proc, scratch, startSeg, next: startSeg, offset: startTicks(s.plan, i, startSeg, timescale), exited: false, killed: false, paused: false, error: null, speed: 0, outSeconds: 0, log: '', stopWhenDone: false };
    s.runs.set(i, r);
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const [key, v] = line.split('=');
        if (key === 'out_time_us' && +v > 0) {
          // Speed from consecutive reports (ffmpeg's own `speed` is an average since the start and drops while we SIGSTOP the run).
          const out = +v / 1e6;
          const now = Date.now();
          if (r.lastWall && now - r.lastWall < 3000 && out > r.outSeconds) r.speed = (out - r.outSeconds) / ((now - r.lastWall) / 1000);
          r.outSeconds = out;
          r.lastWall = now;
        }
      }
    });
    proc.stderr.on('data', (d) => { r.log = (r.log + d).slice(-1500); });
    proc.once('close', async (code) => {
      r.exited = true;
      // A process that was stopped flushes a cut-short last segment on SIGTERM: never take it. One that ran to the
      // end of the movie (or reached an existing segment on its own) has a complete tail.
      if (!r.killed) await harvest(s, r).catch(() => {});
      if (code !== 0 && !r.killed) r.error = `ffmpeg exited ${code}: ${r.log.replace(/https?:\/\/\S+/g, '<url>').slice(-300)}`;
      fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
      console.log(`[hls] ${s.id} out ${i} from segment ${startSeg}: ffmpeg ${code === 0 ? 'finished' : r.killed ? 'stopped' : 'ended with ' + code}`);
    });
    console.log(`[hls] ${s.id} out ${i} ${i < s.plan.renditions.length ? `${s.plan.renditions[i].h}p q${s.plan.renditions[i].q}` : 'audio'} started at segment ${startSeg} (${Math.round(videoStart(s.plan, startSeg))} s)`);
    return r;
  }

  function stopRun(r) {
    if (!r || r.exited) return;
    r.killed = true;
    if (r.paused) r.proc.kill('SIGCONT');
    r.proc.kill('SIGTERM');
  }

  /** Move the segments ffmpeg has finished from the scratch dir into place, with the clock fixed. */
  async function harvest(s, r) {
    let names;
    try { names = (await fs.readdir(r.scratch)).filter((n) => /^seg_\d{5}\.m4s$/.test(n)).sort(); } catch { return; }
    for (const n of names) {
      const k = +n.slice(4, 9);
      if (k < r.next) { fs.rm(path.join(r.scratch, n), { force: true }).catch(() => {}); continue; }
      const dst = finalPath(s, r.i, n);
      if (await exists(dst)) { r.next = k + 1; await fs.rm(path.join(r.scratch, n), { force: true }); continue; } // never overwrite a good segment
      const data = patchTfdt(await fs.readFile(path.join(r.scratch, n)), r.offset);
      await fs.writeFile(dst + '.tmp', data);
      await fs.rename(dst + '.tmp', dst);
      await fs.rm(path.join(r.scratch, n), { force: true });
      r.next = k + 1;
    }
  }

  async function tick() {
    const now = Date.now();
    for (const s of sessions.values()) {
      for (const r of liveRuns(s)) {
        await harvest(s, r).catch(() => {});
        if (r.exited) continue;
        const asked = s.last.get(r.i) ?? 0;
        if (now - s.lastAt > IDLE_KILL_MS) { stopRun(r); continue; }
        // Reached a segment that is already there (another run made it): nothing more to do.
        if (await exists(finalPath(s, r.i, segName(r.next)))) { stopRun(r); continue; }
        if (r.next >= segmentCount(s.plan, r.i)) { stopRun(r); continue; }
        const tooFar = r.next - asked > AHEAD_SEGMENTS;
        if (tooFar && !r.paused) { r.proc.kill('SIGSTOP'); r.paused = true; }
        else if (!tooFar && r.paused) { r.proc.kill('SIGCONT'); r.paused = false; }
      }
    }
  }
  const timer = setInterval(() => void tick(), 200);
  timer.unref?.();

  /** Make sure something is producing segment k of output i (or about to). */
  async function drive(s, i, k) {
    const r = s.runs.get(i);
    if (liveRun(r) && r.next <= k && k - r.next <= NEAR_SEGMENTS) {
      if (r.paused) { r.proc.kill('SIGCONT'); r.paused = false; }
      return;
    }
    if (liveRun(r)) {
      stopRun(r);
      await new Promise((resolve) => r.proc.once('close', resolve));
    }
    if (!liveRuns(s).length) {
      // The first process of a movie: is there disk to feed it next to the other movies being watched?
      const others = [...sessions.values()].filter((o) => o !== s && liveRuns(o).length);
      const verdict = admit({ runningSourceBps: others.map((o) => o.plan.sourceBps), sourceBps: s.plan.sourceBps });
      if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { code: 'busy' });
    }
    await startRun(s, i, k);
  }

  /** The path of segment k of output i, produced on demand. Waits up to WAIT_MS. */
  async function segment(id, input, i, k) {
    const s = await prepare(id, input);
    if (i >= outCount(s.plan) || k >= segmentCount(s.plan, i)) return null;
    s.lastAt = Date.now();
    s.last.set(i, k);
    const p = finalPath(s, i, segName(k));
    if (await exists(p)) {
      const r = s.runs.get(i);
      if (liveRun(r) && r.paused && r.next - k <= AHEAD_SEGMENTS) { r.proc.kill('SIGCONT'); r.paused = false; }
      return p;
    }
    const asked = Date.now();
    await drive(s, i, k);
    for (const end = asked + WAIT_MS; Date.now() < end;) {
      if (await exists(p)) {
        const waited = (Date.now() - asked) / 1000;
        if (waited > 1.5) console.log(`[hls] ${id} out ${i} segment ${k} ready after ${waited.toFixed(1)} s`);
        return p;
      }
      const r = s.runs.get(i);
      if (r?.error) throw new Error(r.error);
      if (!liveRun(r)) { await drive(s, i, k); } // died quietly or was stopped for being too far: start again
      await sleep(120);
    }
    throw new Error('timed out waiting for the segment');
  }

  /** Files that exist before any segment: master, media playlists, init segments. */
  async function file(id, input, name) {
    const s = await prepare(id, input);
    s.lastAt = Date.now();
    if (name === 'master.m3u8') return { body: masterPlaylist(s.plan), type: '.m3u8' };
    const m = /^v(\d)\/index\.m3u8$/.exec(name);
    if (m) return +m[1] < outCount(s.plan) ? { body: mediaPlaylist(s.plan, +m[1]), type: '.m3u8' } : null;
    if (/^v\d\/init\.mp4$/.test(name)) { const p = path.join(s.dir, name); return (await exists(p)) ? { path: p } : null; }
    return null;
  }

  /** Warm a finished download: plan, init segments and (from its file on disk) subtitles, no video encoding. */
  async function enqueue(id, inputUrl, { subsPath } = {}) {
    useFile(id, subsPath);
    const s = await prepare(id, inputUrl);
    await startSubs(s, subsPath);
  }

  async function stop(id) {
    const s = sessions.get(id);
    if (s) { for (const r of s.runs.values()) stopRun(r); s.subsProc?.kill('SIGTERM'); sessions.delete(id); }
    await fs.rm(dirOf(id), { recursive: true, force: true });
  }

  /** For the library list and the player. */
  async function status(id) {
    const s = sessions.get(id);
    const plan = s?.plan ?? (await readPlan(dirOf(id)));
    if (!plan || plan.layout !== FORMAT_VERSION) return { state: 'none', encodedSeconds: 0, duration: 0, speed: 0, slow: false, audios: [], subtitles: [] };
    const subsDone = s ? s.subsDone : await exists(path.join(dirOf(id), 'subs', '.done'));
    // How much of the movie exists in the most complete video rung.
    let have = 0;
    try { have = Math.max(...await Promise.all(plan.renditions.map(async (_, i) => (await fs.readdir(path.join(dirOf(id), `v${i}`))).filter((n) => /^seg_\d{5}\.m4s$/.test(n)).length))); } catch { /* not created yet */ }
    const total = segmentCount(plan, 0);
    const runs = s ? liveRuns(s) : [];
    const running = runs.some((r) => !r.paused);
    const speed = Math.max(0, ...runs.map((r) => r.speed || 0));
    return {
      state: running ? 'running' : runs.length ? 'paused' : have >= total && total > 0 ? 'done' : have > 0 ? 'paused' : 'none',
      encodedSeconds: Math.round(have * SEG_SECONDS), duration: Math.round(plan.duration), speed, slow: running && speed > 0 && speed < 1.1,
      audios: plan.audios.map((x) => ({ lang: x.lang, title: x.title, channels: x.channels, default: !!x.default })),
      subtitles: plan.subs.map((x) => ({ index: x.index, lang: x.lang, title: x.title, ready: subsDone })),
    };
  }

  const stopAll = () => { for (const s of sessions.values()) { for (const r of s.runs.values()) stopRun(r); s.subsProc?.kill('SIGTERM'); } };

  /** Path of a finished WebVTT track, or null while it is still being extracted. */
  async function subtitleFile(id, n) {
    const dir = dirOf(id);
    const s = sessions.get(id);
    const ready = s ? s.subsDone : await exists(path.join(dir, 'subs', '.done'));
    const p = path.join(dir, 'subs', `${n}.vtt`);
    return ready && (await exists(p)) ? p : null;
  }

  return { segment, file, enqueue, useFile, stop, stopAll, dirOf, status, subtitleFile };
}
