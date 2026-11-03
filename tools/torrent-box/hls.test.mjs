import test from 'node:test';
import assert from 'node:assert/strict';
import { planFromProbe, ffmpegArgs, masterPlaylist, admit, HLS_FILE, COPY_MAX_BPS } from './hls.mjs';

const v = (codec, extra = {}) => ({ codec_type: 'video', codec_name: codec, width: 1920, height: 1080, pix_fmt: 'yuv420p', ...extra });
const au = (codec, extra = {}) => ({ codec_type: 'audio', codec_name: codec, channels: 2, ...extra });

test('a light 8-bit H.264 is copied as one rendition; AC-3 audio becomes AAC', () => {
  const p = planFromProbe({ streams: [v('h264', { bit_rate: '3000000' }), au('ac3', { channels: 6 })] });
  assert.equal(p.renditions.length, 1);
  assert.ok(p.renditions[0].copy);
  assert.equal(p.audio, 'aac');
  const a = ffmpegArgs(p, 'in.mkv').join(' ');
  assert.ok(a.includes('-c:v copy') && a.includes('-c:a aac -ac 2') && a.includes('v:0,a:0'));
});

test('a heavy H.264 is re-encoded on the hardware encoder as a 1080p + 720p ladder', () => {
  const p = planFromProbe({ streams: [v('h264', { bit_rate: String(COPY_MAX_BPS + 1) }), au('aac')] });
  assert.deepEqual(p.renditions.map((r) => [r.w, r.h, r.q]), [[1920, 1080, 45], [1280, 720, 40]]);
  const a = ffmpegArgs(p, 'in.mkv').join(' ');
  assert.ok(a.includes('h264_videotoolbox') && !a.includes('libx26'));
  assert.ok(a.includes('split=2') && a.includes('v:0,a:0 v:1,a:1') && a.includes('-c:a copy'));
});

test('VP8, HEVC, AV1 and 10-bit never get copied; a 4K source keeps 4K on top of a 1080p + 720p ladder', () => {
  for (const [codec, pix] of [['vp8', 'yuv420p'], ['hevc', 'yuv420p'], ['av1', 'yuv420p'], ['h264', 'yuv420p10le']]) {
    const p = planFromProbe({ streams: [v(codec, { bit_rate: '1000000', pix_fmt: pix, width: 3840, height: 2160 }), au('aac')] });
    assert.ok(!p.renditions[0].copy, codec + ' ' + pix);
    assert.deepEqual(p.renditions.map((r) => [r.w, r.h, r.q]), [[3840, 2160, 40], [1920, 1080, 45], [1280, 720, 40]]);
  }
});

test('anything taller than 4K is capped at 2160p', () => {
  const p = planFromProbe({ streams: [v('hevc', { width: 7680, height: 4320 }), au('aac')] });
  assert.deepEqual([p.renditions[0].w, p.renditions[0].h], [3840, 2160]);
});

test('a source below 720p gets a single rendition at its own size (no upscaling)', () => {
  const p = planFromProbe({ streams: [v('vp9', { width: 854, height: 480 }), au('opus')] });
  assert.deepEqual(p.renditions.map((r) => [r.w, r.h]), [[854, 480]]);
});

test('unknown bitrate is not copied; the container bitrate is used when the stream has none', () => {
  assert.ok(!planFromProbe({ streams: [v('h264'), au('aac')] }).renditions[0].copy);
  assert.ok(planFromProbe({ streams: [v('h264'), au('aac', { bit_rate: '128000' })], format: { bit_rate: '3128000' } }).renditions[0].copy);
});

test('no audio, cover art, no video', () => {
  const p = planFromProbe({ streams: [{ ...v('mjpeg'), disposition: { attached_pic: 1 } }, v('vc1')] });
  assert.equal(p.audio, 'none');
  assert.ok(!ffmpegArgs(p, 'x').includes('0:a:0'));
  assert.throws(() => planFromProbe({ streams: [au('aac')] }), /no video/);
});

test('master playlist lists every rendition with BANDWIDTH and RESOLUTION', () => {
  const m = masterPlaylist(planFromProbe({ streams: [v('vp9'), au('opus')] }));
  assert.match(m, /BANDWIDTH=\d+,RESOLUTION=1920x1080,CODECS="avc1\.640028,mp4a\.40\.2"\nv0\/index\.m3u8/);
  assert.match(m, /RESOLUTION=1280x720[^\n]*\nv1\/index\.m3u8/);
});

test('only our own file names are served', () => {
  for (const ok of ['master.m3u8', 'v0/index.m3u8', 'v1/init_1.mp4', 'v0/init_0.mp4', 'v0/seg_00012.m4s']) assert.ok(HLS_FILE.test(ok), ok);
  for (const bad of ['../x', 'v0/../x', 'seg_1.m4s', 'v0/index.m3u8.tmp', 'a/b', 'v10/index.m3u8']) assert.ok(!HLS_FILE.test(bad), bad);
});

test('admission: viewers are admitted while the disk can feed them at 1.5x and the count allows', () => {
  const big = 35_000_000; // a 35 Mbit/s Blu-ray remux costs 52.5 Mbit/s of disk reads at 1.5x
  assert.ok(admit({ runningSourceBps: [], sourceBps: big, budget: 480e6, maxWatch: 3 }).ok);
  assert.ok(admit({ runningSourceBps: [big, big], sourceBps: big, budget: 480e6, maxWatch: 3 }).ok);
  assert.ok(!admit({ runningSourceBps: [big, big, big], sourceBps: big, budget: 480e6, maxWatch: 3 }).ok, 'count cap');
  assert.ok(!admit({ runningSourceBps: [200e6, 100e6], sourceBps: 100e6, budget: 480e6, maxWatch: 5 }).ok, 'disk budget');
  assert.ok(admit({ runningSourceBps: [], sourceBps: 0, budget: 480e6, maxWatch: 3 }).ok, 'unknown bitrate is costed as a heavy source, not refused');
});

test('ffmpeg reports progress and uses the media engine to decode H.264/HEVC', () => {
  const p = planFromProbe({ streams: [v('hevc', { bit_rate: '30000000' }), au('aac')], format: { duration: '6000' } });
  const a = ffmpegArgs(p, 'in.mkv').join(' ');
  assert.equal(p.duration, 6000);
  assert.ok(a.includes('-progress pipe:1') && a.includes('-hwaccel videotoolbox'));
  assert.ok(!ffmpegArgs(planFromProbe({ streams: [v('vp9'), au('aac')] }), 'x').includes('-hwaccel'));
});
