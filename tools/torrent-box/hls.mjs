// MKV/AVI/anything -> HLS (fMP4) for browsers, produced while the torrent is still downloading.
//
// ffmpeg reads the movie from the box's own /stream/:id (Range-capable, pieces are prioritised
// where it reads), so it works on a partial download. Output lives on the same HDD as the download:
// <root>/.fiesta/hls/<id>/{master.m3u8, v0/{index.m3u8,init.mp4,seg_00000.m4s,...}, v1/...}.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

// Hardware encoder only (Apple VideoToolbox on the M4): no software x264/x265, ever.
//  - H.264 8-bit that is already light is COPIED (no loss, no cost);
//  - everything else (VP8/VP9/HEVC/AV1/heavy H.264/10-bit) is re-encoded to H.264 in constant-quality mode
//    (-q:v), capped at 4K (2160p), as a small ladder (top + 1080p + 720p) so the player can adapt to the viewer's link;
//  - audio: AAC/MP3 copied, anything else (AC-3, DTS, Opus, ...) becomes AAC stereo.
const AUDIO_COPY = new Set(['aac', 'mp3']);
export const COPY_MAX_BPS = 4_500_000; // an H.264 file above this is worth re-encoding
// Measured on Tears of Steel (VP8 1920x800, 6.0 Mbit/s source), 5 clips across the film:
//   q40 2.55 Mbit/s SSIM .936 | q45 3.19 .940 | q50 3.99 .943 | q55 5.66 .947  -> past q45 traffic grows, quality barely does.
// 4K needs fewer bits per pixel for the same look: a lower q above 1440p (not measured yet, no 4K sample).
const qFor = (height) => (height >= 1440 ? 40 : height > 720 ? 45 : 40);
const bandwidthFor = (w, h) => Math.round(4_000_000 * ((w * h) / (1920 * 1080)) ** 0.75); // declared peak-ish, hls.js adapts anyway
const MAX_HEIGHT = 2160; // ceiling: 4K
const RUNGS = [1080, 720];
const HWDEC = process.env.HWDEC !== '0'; // decode H.264/HEVC on the media engine too (frees the CPU)
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Pure: ffprobe JSON (-show_streams -show_format) -> what to do. */
export function planFromProbe(probe) {
  const streams = probe?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('no video stream');
  const w = +video.width || 1920;
  const h = +video.height || 1080;
  const total = +probe?.format?.bit_rate || 0;
  const bps = +video.bit_rate || (total ? Math.max(0, total - (+audio?.bit_rate || 192_000)) : 0);
  const eightBit = /^(yuvj?4\d\dp|nv12|yuv4\d\dp)$/.test(video.pix_fmt || 'yuv420p');
  const copy = video.codec_name === 'h264' && eightBit && h <= MAX_HEIGHT && bps > 0 && bps <= COPY_MAX_BPS;
  let renditions;
  if (copy) renditions = [{ w, h, copy: true, bandwidth: bps }];
  else {
    const topH = Math.min(h, MAX_HEIGHT);
    renditions = [topH, ...RUNGS.filter((x) => x < topH)].map((rh) => {
      const rw = even((w * rh) / h);
      return { w: rw, h: rh, q: qFor(rh), bandwidth: bandwidthFor(rw, rh) };
    });
  }
  return {
    duration: +probe?.format?.duration || 0,
    hwdec: !copy && HWDEC && (video.codec_name === 'h264' || video.codec_name === 'hevc'),
    videoCodec: video.codec_name,
    sourceBps: bps,
    renditions,
    audio: !audio ? 'none' : AUDIO_COPY.has(audio.codec_name) ? 'copy' : 'aac',
    audioCodec: audio?.codec_name ?? null,
  };
}

/** Pure: ffmpeg arguments for a plan (input is a URL or path). Writes v<N>/index.m3u8 (+ init.mp4, seg_*.m4s). */
export function ffmpegArgs(plan, input) {
  const n = plan.renditions.length;
  const a = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-nostats', '-probesize', '50M', '-analyzeduration', '20M'];
  if (plan.hwdec) a.push('-hwaccel', 'videotoolbox');
  a.push('-i', input);
  if (plan.renditions[0].copy) {
    a.push('-map', '0:v:0', '-c:v', 'copy');
  } else {
    const chains = plan.renditions.map((r, i) => `[s${i}]scale=${r.w}:${r.h}:flags=bicubic,format=yuv420p[o${i}]`);
    const split = `[0:v:0]split=${n}${plan.renditions.map((_, i) => `[s${i}]`).join('')}`;
    a.push('-filter_complex', [split, ...chains].join(';'));
    plan.renditions.forEach((_, i) => a.push('-map', `[o${i}]`));
    plan.renditions.forEach((r, i) => a.push(`-c:v:${i}`, 'h264_videotoolbox', `-q:v:${i}`, String(r.q)));
    a.push('-profile:v', 'high', '-force_key_frames', 'expr:gte(t,n_forced*4)');
  }
  if (plan.audio !== 'none') {
    for (let i = 0; i < n; i++) a.push('-map', '0:a:0');
    if (plan.audio === 'copy') a.push('-c:a', 'copy');
    else a.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k');
  }
  a.push('-sn', '-dn', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', 'v%v/seg_%05d.m4s',
    '-hls_flags', 'independent_segments+temp_file',
    '-var_stream_map', plan.renditions.map((_, i) => (plan.audio === 'none' ? `v:${i}` : `v:${i},a:${i}`)).join(' '),
    'v%v/index.m3u8');
  return a;
}

/** Pure: the master playlist we write ourselves (ffmpeg cannot know the bitrate of a CQ encode). */
export function masterPlaylist(plan) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  plan.renditions.forEach((r, i) => {
    const codecs = r.copy ? '' : `,CODECS="avc1.${r.h > 1440 ? '640033' : r.h > 720 ? '640028' : '64001f'}${plan.audio === 'none' ? '' : ',mp4a.40.2'}"`;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth + 160_000},RESOLUTION=${r.w}x${r.h}${codecs}`, `v${i}/index.m3u8`);
  });
  return lines.join('\n') + '\n';
}

export const HLS_FILE = /^(master\.m3u8|v\d\/(index\.m3u8|init(?:_\d)?\.mp4|seg_\d{5}\.m4s))$/;
export const HLS_MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

const exists = (p) => fs.access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- scheduler -------------------------------------------------------------------------------
// Two kinds of encode job:
//  - 'watch'      somebody pressed play: starts at once, as many as the disk can feed in real time;
//  - 'background' a finished download pre-encoded for later: one at a time, and only while nobody is
//                 watching (it is SIGSTOPped while a watch job runs and continued afterwards).
// A watch job is admitted only if the disk can read its source at REALTIME x the playback rate on top of
// the other watch jobs, so encoding never has to run slower than playback because the disk is saturated.
export const REALTIME = 1.5;
const BUDGET_BPS = (+process.env.ENCODE_BUDGET_MBPS || 480) * 1e6; // ~60 MB/s sustained from a USB HDD shared with downloads
const MAX_WATCH = +process.env.MAX_WATCH_ENCODES || 3;
const UNKNOWN_SOURCE_BPS = 40_000_000;

/** Pure: may another watch job (source bitrate `sourceBps`) start next to the ones already running? */
export function admit({ runningSourceBps, sourceBps, budget = BUDGET_BPS, maxWatch = MAX_WATCH }) {
  const cost = (sourceBps || UNKNOWN_SOURCE_BPS) * REALTIME;
  const used = runningSourceBps.reduce((n, b) => n + (b || UNKNOWN_SOURCE_BPS) * REALTIME, 0);
  if (runningSourceBps.length >= maxWatch) return { ok: false, reason: `already ${maxWatch} movies being encoded for viewers` };
  if (used + cost > budget) return { ok: false, reason: 'the disk is busy feeding other movies' };
  return { ok: true };
}

export function createHls({ root }) {
  const base = path.join(root, '.fiesta', 'hls');
  /** id -> job: { dir, proc, plan, priority, paused, finished, error, ready, exited, outSeconds, speed, slow } */
  const jobs = new Map();
  const inflight = new Map(); // id -> Promise<job> while probing/starting
  const queue = []; // background requests not started yet: { id, inputUrl }
  const dirOf = (id) => path.join(base, id);

  const live = (j) => j.proc && !j.finished && !j.error && !j.killed;
  const watchers = () => [...jobs.values()].filter((j) => live(j) && j.priority === 'watch');

  const finishedOnDisk = (dir) => exists(path.join(dir, '.done')); // written only after ffmpeg exited cleanly

  /** Pause background encodes while somebody watches; resume them (and start the next queued) afterwards. */
  function rebalance() {
    const busy = watchers().length > 0;
    for (const j of jobs.values()) {
      if (!live(j) || j.priority !== 'background') continue;
      if (busy && !j.paused) { j.proc.kill('SIGSTOP'); j.paused = true; console.log(`[hls] ${j.id} paused (a viewer is being served)`); }
      else if (!busy && j.paused) { j.proc.kill('SIGCONT'); j.paused = false; console.log(`[hls] ${j.id} resumed`); }
    }
    if (busy) return;
    if ([...jobs.values()].some((j) => live(j) && j.priority === 'background')) return; // one background job at a time
    const next = queue.shift();
    if (next) start(next.id, next.inputUrl, 'background').catch((e) => { console.error('[hls] background start failed', next.id, String(e.message).slice(0, 200)); rebalance(); });
  }

  async function probe(inputUrl) {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-probesize', '50M', '-analyzeduration', '20M', '-print_format', 'json', '-show_streams', '-show_format', inputUrl], { maxBuffer: 8 << 20, timeout: 120_000 });
    return planFromProbe(JSON.parse(stdout));
  }

  /** Probe, admit (watch only), then spawn ffmpeg. */
  async function start(id, inputUrl, priority) {
    const dir = dirOf(id);
    if (await finishedOnDisk(dir)) {
      const job = { id, dir, proc: null, priority, finished: true, error: null, ready: Promise.resolve(), exited: Promise.resolve() };
      jobs.set(id, job);
      return job;
    }
    const plan = await probe(inputUrl);
    if (priority === 'watch') {
      const verdict = admit({ runningSourceBps: watchers().map((j) => j.plan.sourceBps), sourceBps: plan.sourceBps });
      if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { code: 'busy' });
    }
    await fs.rm(dir, { recursive: true, force: true }); // a crashed half-run cannot be resumed
    await Promise.all(plan.renditions.map((_, i) => fs.mkdir(path.join(dir, `v${i}`), { recursive: true })));
    await fs.writeFile(path.join(dir, 'master.m3u8'), masterPlaylist(plan));
    const proc = spawn(FFMPEG, ffmpegArgs(plan, inputUrl), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { id, dir, proc, plan, priority, paused: false, finished: false, error: null, ready: null, outSeconds: 0, speed: 0, slow: false };
    job.exited = new Promise((resolve) => proc.once('close', resolve));
    let log = '';
    let buf = '';
    let slowTicks = 0;
    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k === 'out_time_us') job.outSeconds = Math.max(0, +v / 1e6) || job.outSeconds;
        else if (k === 'speed' && parseFloat(v) > 0) {
          job.speed = parseFloat(v);
          slowTicks = job.priority === 'watch' && job.speed < 1.1 && !job.paused ? slowTicks + 1 : 0;
          job.slow = slowTicks >= 3; // below ~real time for three reports in a row
        }
      }
    });
    proc.stderr.on('data', (d) => { log = (log + d).slice(-2000); });
    proc.on('close', (code) => {
      job.finished = code === 0;
      if (code === 0) fs.writeFile(path.join(dir, '.done'), '').catch(() => {});
      if (code !== 0 && !job.killed) job.error = `ffmpeg exited ${code}: ${log.replace(/https?:\/\/\S+/g, '<url>').slice(-400)}`;
      console.log(`[hls] ${id} ffmpeg ${code === 0 ? 'finished' : 'ended with ' + code}`);
      rebalance();
    });
    job.ready = (async () => {
      for (let i = 0; i < 240; i++) { // up to 60 s for the first segment
        if (job.error) throw new Error(job.error);
        if (await exists(path.join(dir, 'v0', 'seg_00000.m4s')) && await exists(path.join(dir, 'v0', 'index.m3u8'))) return;
        await sleep(250);
      }
      throw new Error('timed out waiting for the first segment');
    })();
    jobs.set(id, job);
    console.log(`[hls] ${id} [${priority}] ${plan.videoCodec} ${Math.round(plan.sourceBps / 1000)} kbit/s -> ${plan.renditions.map((r) => (r.copy ? 'copy' : `${r.w}x${r.h} q${r.q}`)).join(' + ')}; audio ${plan.audioCodec ?? 'none'} -> ${plan.audio}${plan.hwdec ? '; hw decode' : ''}`);
    rebalance();
    return job;
  }

  /** A viewer wants this movie: reuse its job (promoting a background one), or start a new one. Throws {code:'busy'} when the disk is full. */
  async function ensure(id, inputUrl) {
    let job = jobs.get(id);
    if (!job) {
      const qi = queue.findIndex((q) => q.id === id);
      if (qi >= 0) queue.splice(qi, 1); // it was waiting for its turn: a viewer jumps the queue
      let p = inflight.get(id);
      if (!p) {
        p = start(id, inputUrl, 'watch').finally(() => inflight.delete(id));
        inflight.set(id, p);
      }
      job = await p;
    } else if (live(job) && job.priority === 'background') {
      const verdict = admit({ runningSourceBps: watchers().map((j) => j.plan.sourceBps), sourceBps: job.plan.sourceBps });
      if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { code: 'busy' });
      job.priority = 'watch';
      rebalance();
    }
    try { await job.ready; } catch (e) { jobs.delete(id); throw e; }
    return job;
  }

  /** A download finished: encode it when the encoder is free. */
  async function enqueue(id, inputUrl) {
    if (jobs.has(id) || inflight.has(id) || queue.some((q) => q.id === id) || await finishedOnDisk(dirOf(id))) return;
    queue.push({ id, inputUrl });
    rebalance();
  }

  async function stop(id) {
    const job = jobs.get(id);
    const qi = queue.findIndex((q) => q.id === id);
    if (qi >= 0) queue.splice(qi, 1);
    if (job?.proc && !job.finished) { job.killed = true; if (job.paused) job.proc.kill('SIGCONT'); job.proc.kill('SIGTERM'); }
    jobs.delete(id);
    await fs.rm(dirOf(id), { recursive: true, force: true });
    rebalance();
  }

  /** For the library list and the player. */
  async function status(id) {
    const job = jobs.get(id);
    if (job) {
      const state = job.error ? 'failed' : job.finished ? 'done' : job.paused ? 'paused' : 'running';
      return { state, priority: job.priority, encodedSeconds: Math.round(job.outSeconds || 0), duration: Math.round(job.plan?.duration || 0), speed: job.speed || 0, slow: !!job.slow };
    }
    if (queue.some((q) => q.id === id)) return { state: 'queued' };
    return { state: (await finishedOnDisk(dirOf(id))) ? 'done' : 'none' };
  }

  const stopAll = () => { for (const j of jobs.values()) { if (j.paused) j.proc?.kill('SIGCONT'); j.proc?.kill('SIGTERM'); } };

  return { ensure, enqueue, stop, stopAll, dirOf, status };
}
