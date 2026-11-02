import test from 'node:test';
import assert from 'node:assert/strict';
import { planFromProbe, ffmpegArgs, HLS_FILE } from './hls.mjs';

const s = (type, codec, extra = {}) => ({ codec_type: type, codec_name: codec, ...extra });

test('H.264 + AC-3 keeps the video and re-encodes only the audio', () => {
  const p = planFromProbe({ streams: [s('video', 'h264'), s('audio', 'ac3', { channels: 6 })] });
  assert.deepEqual([p.video, p.audio], ['copy', 'aac']);
  const a = ffmpegArgs(p, 'in.mkv');
  assert.ok(a.join(' ').includes('-c:v copy') && a.join(' ').includes('-c:a aac -ac 2'));
});

test('HEVC is copied and tagged hvc1; AAC audio is copied', () => {
  const p = planFromProbe({ streams: [s('video', 'hevc'), s('audio', 'aac', { channels: 2 })] });
  const a = ffmpegArgs(p, 'in.mkv').join(' ');
  assert.ok(a.includes('-tag:v hvc1') && a.includes('-c:a copy'));
});

test('exotic video goes through VideoToolbox; cover art is not the video; no audio is fine', () => {
  const p = planFromProbe({ streams: [s('video', 'mjpeg', { disposition: { attached_pic: 1 } }), s('video', 'vc1')] });
  assert.equal(p.video, 'h264_videotoolbox');
  assert.equal(p.audio, 'none');
  assert.ok(!ffmpegArgs(p, 'x').includes('0:a:0'));
});

test('no video stream is an error', () => {
  assert.throws(() => planFromProbe({ streams: [s('audio', 'aac')] }), /no video/);
});

test('only our own file names are served', () => {
  for (const ok of ['index.m3u8', 'init.mp4', 'seg_00012.m4s']) assert.ok(HLS_FILE.test(ok));
  for (const bad of ['../x', 'seg_1.m4s', 'index.m3u8.tmp', 'a/b']) assert.ok(!HLS_FILE.test(bad));
});
