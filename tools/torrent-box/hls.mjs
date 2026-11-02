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
//    (-q:v), capped at 1080p, as a small ladder (top + 720p) so the player can adapt to the viewer's link;
//  - audio: AAC/MP3 copied, anything else (AC-3, DTS, Opus, ...) becomes AAC stereo.
const AUDIO_COPY = new Set(['aac', 'mp3']);
export const COPY_MAX_BPS = 4_500_000; // an H.264 file above this is worth re-encoding
// Measured on Tears of Steel (VP8 1920x800, 6.0 Mbit/s source), 5 clips across the film:
//   q40 2.55 Mbit/s SSIM .936 | q45 3.19 .940 | q50 3.99 .943 | q55 5.66 .947  -> past q45 traffic grows, quality barely does.
const Q_TOP = 45;
const Q_LOW = 40;
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
  const copy = video.codec_name === 'h264' && eightBit && h <= 1088 && bps > 0 && bps <= COPY_MAX_BPS;
  let renditions;
  if (copy) renditions = [{ w, h, copy: true, bandwidth: bps }];
  else {
    const topH = Math.min(h, 1080);
    renditions = [{ w: even((w * topH) / h), h: topH, q: Q_TOP, bandwidth: Math.round(4_000_000 * ((even((w * topH) / h) * topH) / (1920 * 800))) }];
    if (topH > 720) renditions.push({ w: even((w * 720) / h), h: 720, q: Q_LOW, bandwidth: 2_200_000 });
  }
  return {
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
  const a = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-probesize', '50M', '-analyzeduration', '20M', '-i', input];
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
    const codecs = r.copy ? '' : `,CODECS="avc1.${r.h > 720 ? '640028' : '64001f'}${plan.audio === 'none' ? '' : ',mp4a.40.2'}"`;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth + 160_000},RESOLUTION=${r.w}x${r.h}${codecs}`, `v${i}/index.m3u8`);
  });
  return lines.join('\n') + '\n';
}

export const HLS_FILE = /^(master\.m3u8|v\d\/(index\.m3u8|init(?:_\d)?\.mp4|seg_\d{5}\.m4s))$/;
export const HLS_MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

const exists = (p) => fs.access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHls({ root }) {
  const base = path.join(root, '.fiesta', 'hls');
  /** id -> { dir, proc, finished, error, ready } */
  const jobs = new Map();
  const dirOf = (id) => path.join(base, id);

  async function finishedOnDisk(dir) {
    return exists(path.join(dir, '.done')); // written only after ffmpeg exited cleanly
  }

  /** Start (or reuse) the remux of torrent `id`; resolves when the first segment exists. */
  async function ensure(id, inputUrl) {
    const dir = dirOf(id);
    let job = jobs.get(id);
    if (!job) {
      if (await finishedOnDisk(dir)) {
        job = { dir, proc: null, finished: true, error: null, ready: Promise.resolve() };
      } else {
        await fs.rm(dir, { recursive: true, force: true }); // a crashed half-run cannot be resumed
        await fs.mkdir(dir, { recursive: true });
        const { stdout } = await run(FFPROBE, ['-v', 'error', '-probesize', '50M', '-analyzeduration', '20M', '-print_format', 'json', '-show_streams', '-show_format', inputUrl], { maxBuffer: 8 << 20, timeout: 120_000 });
        const plan = planFromProbe(JSON.parse(stdout));
        await Promise.all(plan.renditions.map((_, i) => fs.mkdir(path.join(dir, `v${i}`), { recursive: true })));
        await fs.writeFile(path.join(dir, 'master.m3u8'), masterPlaylist(plan));
        const proc = spawn(FFMPEG, ffmpegArgs(plan, inputUrl), { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
        job = { dir, proc, plan, finished: false, error: null, ready: null };
        let log = '';
        proc.stderr.on('data', (d) => { log = (log + d).slice(-2000); });
        proc.on('close', (code) => {
          job.finished = code === 0;
          if (code === 0) fs.writeFile(path.join(dir, '.done'), '').catch(() => {});
          if (code !== 0 && !job.killed) job.error = `ffmpeg exited ${code}: ${log.replace(/https?:\/\/\S+/g, '<url>').slice(-400)}`;
          console.log(`[hls] ${id} ffmpeg ${code === 0 ? 'finished' : 'ended with ' + code}`);
        });
        job.ready = (async () => {
          for (let i = 0; i < 240; i++) { // up to 60 s for the first segment
            if (job.error) throw new Error(job.error);
            if (await exists(path.join(dir, 'v0', 'seg_00000.m4s')) && await exists(path.join(dir, 'v0', 'index.m3u8'))) return;
            await sleep(250);
          }
          throw new Error('timed out waiting for the first segment');
        })();
        console.log(`[hls] ${id} ${plan.videoCodec} ${Math.round(plan.sourceBps / 1000)} kbit/s -> ${plan.renditions.map((r) => (r.copy ? 'copy' : `${r.w}x${r.h} q${r.q}`)).join(' + ')}; audio ${plan.audioCodec ?? 'none'} -> ${plan.audio}`);
      }
      jobs.set(id, job);
    }
    try { await job.ready; } catch (e) { jobs.delete(id); throw e; }
    return job;
  }

  async function stop(id) {
    const job = jobs.get(id);
    if (job?.proc && !job.finished) { job.killed = true; job.proc.kill('SIGTERM'); }
    jobs.delete(id);
    await fs.rm(dirOf(id), { recursive: true, force: true });
  }

  const stopAll = () => { for (const j of jobs.values()) j.proc?.kill('SIGTERM'); };

  return { ensure, stop, stopAll, dirOf };
}
