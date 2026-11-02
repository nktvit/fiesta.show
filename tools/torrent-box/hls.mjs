// MKV/AVI/anything -> HLS (fMP4) for browsers, produced while the torrent is still downloading.
//
// ffmpeg reads the movie from the box's own /stream/:id (Range-capable, pieces are prioritised
// where it reads), so it works on a partial download. Video is COPIED when a browser can decode
// it (H.264, HEVC) and only re-encoded (VideoToolbox) otherwise; audio is copied when it is AAC/MP3
// and turned into AAC otherwise (browsers cannot play DTS/AC-3/TrueHD). Output lives on the same
// HDD as the download: <root>/.fiesta/hls/<id>/{index.m3u8,init.mp4,seg_00000.m4s,...}.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const VIDEO_COPY = new Set(['h264', 'hevc']);
const AUDIO_COPY = new Set(['aac', 'mp3']);

/** Pure: ffprobe JSON -> what to do with the first video and first audio stream. */
export function planFromProbe(probe) {
  const streams = probe?.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('no video stream');
  const plan = {
    video: VIDEO_COPY.has(video.codec_name) ? 'copy' : 'h264_videotoolbox',
    videoCodec: video.codec_name,
    audio: !audio ? 'none' : AUDIO_COPY.has(audio.codec_name) ? 'copy' : 'aac',
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? 0,
  };
  return plan;
}

/** Pure: ffmpeg arguments for a plan (input is a URL or path). */
export function ffmpegArgs(plan, input) {
  const a = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-probesize', '50M', '-analyzeduration', '20M', '-i', input,
    '-map', '0:v:0'];
  if (plan.audio !== 'none') a.push('-map', '0:a:0');
  a.push('-sn', '-dn');
  if (plan.video === 'copy') {
    a.push('-c:v', 'copy');
    if (plan.videoCodec === 'hevc') a.push('-tag:v', 'hvc1'); // Safari only accepts HEVC-in-MP4 tagged hvc1
  } else {
    a.push('-c:v', 'h264_videotoolbox', '-b:v', '8M', '-pix_fmt', 'yuv420p', '-g', '96', '-allow_sw', '1');
  }
  if (plan.audio === 'copy') a.push('-c:a', 'copy');
  else if (plan.audio === 'aac') a.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  a.push('-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg_%05d.m4s',
    '-hls_flags', 'independent_segments+temp_file', 'index.m3u8');
  return a;
}

export const HLS_FILE = /^(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$/;
export const HLS_MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

const exists = (p) => fs.access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHls({ root }) {
  const base = path.join(root, '.fiesta', 'hls');
  /** id -> { dir, proc, finished, error, ready } */
  const jobs = new Map();
  const dirOf = (id) => path.join(base, id);

  async function finishedOnDisk(dir) {
    try { return (await fs.readFile(path.join(dir, 'index.m3u8'), 'utf8')).includes('#EXT-X-ENDLIST'); } catch { return false; }
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
        const { stdout } = await run(FFPROBE, ['-v', 'error', '-probesize', '50M', '-analyzeduration', '20M', '-print_format', 'json', '-show_streams', inputUrl], { maxBuffer: 8 << 20, timeout: 120_000 });
        const plan = planFromProbe(JSON.parse(stdout));
        const proc = spawn(FFMPEG, ffmpegArgs(plan, inputUrl), { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
        job = { dir, proc, plan, finished: false, error: null, ready: null };
        let log = '';
        proc.stderr.on('data', (d) => { log = (log + d).slice(-2000); });
        proc.on('close', (code) => {
          job.finished = code === 0;
          if (code !== 0 && !job.killed) job.error = `ffmpeg exited ${code}: ${log.replace(/https?:\/\/\S+/g, '<url>').slice(-400)}`;
          console.log(`[hls] ${id} ffmpeg ${code === 0 ? 'finished' : 'ended with ' + code}`);
        });
        job.ready = (async () => {
          for (let i = 0; i < 240; i++) { // up to 60 s for the first segment
            if (job.error) throw new Error(job.error);
            if (await exists(path.join(dir, 'seg_00000.m4s')) && await exists(path.join(dir, 'index.m3u8'))) return;
            await sleep(250);
          }
          throw new Error('timed out waiting for the first segment');
        })();
        console.log(`[hls] ${id} ${plan.videoCodec}->${plan.video}, ${plan.audioCodec ?? 'no audio'}->${plan.audio}`);
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
