import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFromProbe, runArgs, initArgs, subtitleArgs, masterPlaylist, mediaPlaylist, segmentGrid, segmentCount, alignStart,
  defaultAudioIndex, hdrOf, videoStartFrame, audioStartFrame, patchTfdt, mdhdTimescale, startTicks, admit, HLS_FILE,
} from './hls.mjs';

const v = (codec, extra = {}) => ({ codec_type: 'video', codec_name: codec, width: 1920, height: 1080, pix_fmt: 'yuv420p', r_frame_rate: '24000/1001', ...extra });
const au = (codec, extra = {}) => ({ codec_type: 'audio', codec_name: codec, channels: 2, ...extra });
const movie = (extra = {}) => planFromProbe({ streams: [v('h264', { bit_rate: '15000000' }), au('ac3', { channels: 6, tags: { language: 'rus', title: 'MVO' } }), au('dts', { tags: { language: 'kor' } })], format: { duration: '6300' }, ...extra });

test('a 1080p source gets a q60 + q50 1080p and a 720p rung, all hardware H.264 (never copied); a heavy one also a q70 near-source rung', () => {
  for (const codec of ['h264', 'vp8', 'hevc']) {
    const p = planFromProbe({ streams: [v(codec, { bit_rate: '1000000' }), au('aac')], format: { duration: '60' } });
    assert.deepEqual(p.renditions.map((r) => [r.w, r.h, r.q]), [[1920, 1080, 60], [1920, 1080, 50], [1280, 720, 50]]);
  }
  const heavy = planFromProbe({ streams: [v('h264', { bit_rate: '31000000' }), au('aac')], format: { duration: '60' } });
  assert.deepEqual(heavy.renditions.map((r) => r.q), [70, 60, 50, 50]);
  const a = runArgs(movie(), 'in.mkv', 0, 0).join(' ');
  assert.ok(a.includes('h264_videotoolbox') && !a.includes('libx26') && !a.includes('-c:v copy'));
});

test('a 4K source keeps 4K on top (q55) over 1080p and 720p; anything taller is capped at 2160p', () => {
  const p = planFromProbe({ streams: [v('hevc', { width: 3840, height: 2160, pix_fmt: 'yuv420p10le' }), au('aac')] });
  assert.deepEqual(p.renditions.map((r) => [r.w, r.h, r.q]), [[3840, 2160, 55], [1920, 1080, 60], [1280, 720, 50]]);
  assert.deepEqual(planFromProbe({ streams: [v('hevc', { width: 7680, height: 4320 }), au('aac')] }).renditions[0].h, 2160);
});

test('a source below 720p gets one rendition at its own size (no upscaling)', () => {
  const p = planFromProbe({ streams: [v('vp9', { width: 854, height: 480 }), au('opus')] });
  assert.deepEqual(p.renditions.map((r) => [r.w, r.h]), [[854, 480]]);
});

test('the segment grid never drifts: 96 frames, sometimes 95, at 23.976 fps (matches what a full ffmpeg run wrote)', () => {
  const p = movie();
  assert.equal(videoStartFrame(p, 1), 96);
  assert.equal(videoStartFrame(p, 2), 192);
  const g = segmentGrid(p, 'video');
  const d = new Set(g.slice(0, -1).map((s) => s.duration.toFixed(3)));
  assert.deepEqual([...d].sort(), ['3.962', '4.004']);
  // every boundary is within one frame of k*4 s
  g.forEach((s, k) => assert.ok(Math.abs(s.start - k * 4) < 0.0418, `segment ${k}`));
  assert.ok(Math.abs(g.at(-1).start + g.at(-1).duration - 6300) < 1e-6, 'ends at the movie end');
});

test('the audio grid alternates 188 and 187 AAC frames and is whole-numbered at even segments', () => {
  assert.deepEqual([1, 2, 3, 4].map(audioStartFrame), [188, 375, 563, 750]);
  const g = segmentGrid(movie(), 'audio');
  assert.deepEqual([g[0].duration.toFixed(6), g[1].duration.toFixed(6)], ['4.010667', '3.989333']);
  assert.equal(alignStart(movie(), 3, 7), 6, 'audio runs start on an even segment');
  assert.equal(alignStart(movie(), 0, 7), 7, 'video runs start anywhere');
});

test('the media playlist is the complete VOD list: every segment, real durations, ENDLIST', () => {
  const p = movie();
  const m = mediaPlaylist(p, 0);
  assert.match(m, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(m, /#EXT-X-MAP:URI="init\.mp4"/);
  assert.equal((m.match(/#EXTINF/g) || []).length, segmentCount(p, 0));
  assert.match(m, /#EXTINF:4\.004000,\nseg_00000\.m4s/);
  assert.ok(m.trimEnd().endsWith('#EXT-X-ENDLIST'));
  assert.equal((mediaPlaylist(p, 3).match(/#EXTINF/g) || []).length, segmentCount(p, 3), 'audio tracks too');
});

test('every rung has a bitrate ceiling (constant quality alone has none: it overshot the source on a grainy remux)', () => {
  const p = planFromProbe({ streams: [v('h264', { bit_rate: '31000000' }), au('aac')], format: { duration: '60' } });
  p.renditions.forEach((r) => assert.ok(r.maxrate > r.bandwidth && r.maxrate <= 40_000_000, `${r.h}p q${r.q}`));
  const a = runArgs(p, 'in.mkv', 0, 0).join(' ');
  assert.ok(a.includes(`-maxrate ${p.renditions[0].maxrate} -bufsize ${p.renditions[0].maxrate * 2}`));
  assert.ok(initArgs(p, 'in.mkv').join(' ').includes('-maxrate:v:3'));
  assert.ok(p.renditions[0].bandwidth < 31_000_000, 'the top rung never claims more than the source');
});

test('a run starts at the requested segment, on the movie clock, with the keyframe grid anchored there', () => {
  const p = movie();
  const a = runArgs(p, 'in.mkv', 1, 501).join(' ');
  assert.match(a, /-ss 2004\.0\d+/);
  assert.ok(a.includes('-copyts -start_at_zero'));
  assert.ok(a.includes('-start_number 501') && a.includes('expr:gte(t,(n_forced+501)*4)'));
  assert.ok(a.includes('-q:v 50') && a.includes('scale=1920:1080'));
  assert.ok(a.includes('-hwaccel videotoolbox'));
  const first = runArgs(p, 'in.mkv', 0, 0).join(' ');
  assert.ok(!first.includes('-ss ') && first.includes('-start_number 0'));
  const au1 = runArgs(p, 'in.mkv', 4, 500).join(' ');
  assert.ok(au1.includes('-map 0:a:1') && au1.includes('-ar 48000') && au1.includes('-vn') && au1.includes('-ss 2000'));
});

test('the init pass writes every rendition once, from the first seconds', () => {
  const a = initArgs(movie(), 'in.mkv').join(' ');
  assert.ok(a.includes('-t 3') && a.includes('split=3') && a.includes('v:0 v:1 v:2 a:0 a:1'));
  assert.ok(a.includes('use_editlist=0'));
});

test('a run\'s clock is fixed by adding its start to every tfdt; version 0 and 1 boxes both work', () => {
  const box = (ver, t) => { const b = Buffer.alloc(ver ? 20 : 16); b.write('tfdt', 0); b[4] = ver; if (ver) b.writeBigUInt64BE(BigInt(t), 8); else b.writeUInt32BE(t, 8); return b; };
  const seg0 = Buffer.concat([Buffer.from('xxmoof'), box(0, 1001), Buffer.from('yy'), box(0, 5005)]);
  patchTfdt(seg0, 48096048 - 0);
  assert.equal(seg0.readUInt32BE(seg0.indexOf('tfdt') + 8), 1001 + 48096048);
  assert.equal(seg0.readUInt32BE(seg0.lastIndexOf('tfdt') + 8), 5005 + 48096048);
  const seg1 = Buffer.concat([Buffer.from('zz'), box(1, 7)]);
  patchTfdt(seg1, 3);
  assert.equal(seg1.readBigUInt64BE(seg1.indexOf('tfdt') + 8), 10n);
  assert.equal(patchTfdt(Buffer.from('tfdt'), 0).length, 4, 'nothing to add: untouched');
  const p = movie();
  assert.equal(startTicks(p, 0, 501, 24000), 48048 * 1001, 'video: the first frame of segment 501 in 1/24000 s');
  assert.equal(startTicks(p, 3, 502, 48000), 187.5 * 502 * 1024, 'audio: whole AAC frames at an even segment');
  assert.equal(startTicks(p, 0, 0, 24000), 0);
  const mdhd = Buffer.alloc(40); mdhd.write('mdhd', 4); mdhd.writeUInt32BE(24000, 4 + 4 + 4 + 8);
  assert.equal(mdhdTimescale(mdhd), 24000);
});

test('master playlist lists every rung and every audio track (default first)', () => {
  const m = masterPlaylist(movie());
  assert.match(m, /BANDWIDTH=\d+,RESOLUTION=1920x1080,CODECS="avc1\.640028,mp4a\.40\.2",AUDIO="aud"\nv0\/index\.m3u8/);
  assert.match(m, /RESOLUTION=1280x720[^\n]*\nv2\/index\.m3u8/);
  assert.match(m, /LANGUAGE="rus",DEFAULT=YES[^\n]*URI="v3\/index\.m3u8"/);
  assert.match(m, /LANGUAGE="kor",DEFAULT=NO[^\n]*URI="v4\/index\.m3u8"/);
});

test('bitmap subtitles are skipped, text ones are numbered by ffmpeg\'s subtitle ordinal', () => {
  const p = planFromProbe({ streams: [v('h264'), au('aac'),
    { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
    { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'kor' } },
    { codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'rus' } }] });
  assert.deepEqual(p.subs.map((x) => [x.index, x.ordinal, x.lang]), [[0, 0, 'eng'], [1, 2, 'rus']]);
  const sa = subtitleArgs(p, 'in.mkv').join(' ');
  assert.ok(sa.includes('-map 0:s:0') && sa.includes('-map 0:s:2') && sa.includes('subs/1.vtt'));
});

test('no video is an error; no audio is fine', () => {
  assert.throws(() => planFromProbe({ streams: [au('aac')] }), /no video/);
  const p = planFromProbe({ streams: [{ ...v('mjpeg'), disposition: { attached_pic: 1 } }, v('vc1')] });
  assert.equal(p.audios.length, 0);
  assert.ok(!masterPlaylist(p).includes('EXT-X-MEDIA'));
});

test('only our own file names are served', () => {
  for (const ok of ['master.m3u8', 'v0/index.m3u8', 'v1/init.mp4', 'v0/seg_00012.m4s']) assert.ok(HLS_FILE.test(ok), ok);
  for (const bad of ['../x', 'v0/../x', 'seg_1.m4s', 'v0/index.m3u8.tmp', 'a/b', 'v10/index.m3u8', 'v0/init_0.mp4']) assert.ok(!HLS_FILE.test(bad), bad);
});

test('admission: another movie is admitted while the disk can feed it at 1.5x and the count allows', () => {
  const big = 35_000_000;
  assert.ok(admit({ runningSourceBps: [], sourceBps: big, budget: 480e6, maxWatch: 3 }).ok);
  assert.ok(admit({ runningSourceBps: [big, big], sourceBps: big, budget: 480e6, maxWatch: 3 }).ok);
  assert.ok(!admit({ runningSourceBps: [big, big, big], sourceBps: big, budget: 480e6, maxWatch: 3 }).ok, 'count cap');
  assert.ok(!admit({ runningSourceBps: [200e6, 100e6], sourceBps: 100e6, budget: 480e6, maxWatch: 5 }).ok, 'disk budget');
  assert.ok(admit({ runningSourceBps: [], sourceBps: 0, budget: 480e6, maxWatch: 3 }).ok, 'unknown bitrate is costed as a heavy source');
});

test('English is the default audio track, but never a commentary; with no English the first track stays', () => {
  const a = (lang, title = '') => ({ lang, title });
  assert.equal(defaultAudioIndex([a('rus', 'MVO'), a('rus'), a('eng', 'Director commentary'), a('eng', 'Original'), a('kor')]), 3);
  assert.equal(defaultAudioIndex([a('rus'), a('kor')]), 0);
  assert.equal(defaultAudioIndex([a('eng', 'Commentary'), a('rus')]), 1, 'only a commentary in English: take the first normal one');
  assert.equal(defaultAudioIndex([a('en'), a('rus')]), 0, 'two-letter codes too');
  const p = planFromProbe({ streams: [v('h264'), au('ac3', { tags: { language: 'rus' } }), au('eac3', { tags: { language: 'eng' } })] });
  assert.deepEqual(p.audios.map((x) => x.default), [false, true]);
  assert.match(masterPlaylist(p), /LANGUAGE="eng",DEFAULT=YES[^\n]*URI="v4\/index\.m3u8"/);
  assert.match(masterPlaylist(p), /LANGUAGE="rus",DEFAULT=NO/);
  // a plan saved before this rule (first track flagged) still gets English from the playlist
  const old = { ...p, audios: p.audios.map((x, i) => ({ ...x, default: i === 0 })) };
  assert.match(masterPlaylist(old), /LANGUAGE="eng",DEFAULT=YES/);
});

test('HDR (PQ/HLG, 10 bit) is kept as it is: HEVC Main10, tags passed on, VIDEO-RANGE in the master playlist', () => {
  const hdr = { pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc', bits_per_raw_sample: '10' };
  const p = planFromProbe({ streams: [v('hevc', { ...hdr, width: 3840, height: 2160, bit_rate: '60000000' }), au('eac3')], format: { duration: '100' } });
  assert.deepEqual(p.hdr, { trc: 'smpte2084', primaries: 'bt2020', space: 'bt2020nc', range: 'PQ' });
  const a = runArgs(p, 'in.mkv', 0, 0).join(' ');
  assert.ok(a.includes('hevc_videotoolbox') && a.includes('-profile:v main10') && a.includes('-tag:v hvc1') && a.includes('format=p010le'));
  assert.ok(a.includes('-color_trc smpte2084') && a.includes('-color_primaries bt2020') && a.includes('-colorspace bt2020nc'));
  assert.ok(!a.includes('h264_videotoolbox') && !a.includes('libx26'));
  const i = initArgs(p, 'in.mkv').join(' ');
  assert.ok(i.includes('-c:v:0 hevc_videotoolbox') && i.includes('format=p010le'));
  const m = masterPlaylist(p);
  assert.match(m, /CODECS="hvc1\.2\.4\.L153\.B0,mp4a\.40\.2",VIDEO-RANGE=PQ/);
  assert.equal(hdrOf({ color_transfer: 'arib-std-b67', pix_fmt: 'yuv420p10le' }).range, 'HLG');
  assert.equal(hdrOf({ color_transfer: 'smpte2084', pix_fmt: 'yuv420p' }), null, '8 bit cannot be HDR10');
  assert.equal(hdrOf({ color_transfer: 'bt709', pix_fmt: 'yuv420p10le' }), null, '10-bit SDR stays on the H.264 path');
  const sdr = runArgs(movie(), 'in.mkv', 0, 0).join(' ');
  assert.ok(sdr.includes('h264_videotoolbox') && sdr.includes('-profile:v high') && sdr.includes('format=yuv420p') && !sdr.includes('-color_trc'));
});

test('the HEVC variant: Main 8-bit, hvc1, q alone (hevc_videotoolbox drops -q:v when given -maxrate), lighter declared bandwidth', () => {
  const probe = { streams: [v('h264', { bit_rate: '31000000' }), au('aac')], format: { duration: '60' } };
  const h = planFromProbe(probe, { hevc: true }), a = planFromProbe(probe);
  assert.equal(h.codec, 'hevc'); assert.equal(a.codec, 'h264');
  const r = runArgs(h, 'in.mkv', 0, 0).join(' ');
  assert.ok(r.includes('hevc_videotoolbox') && r.includes('-profile:v main') && r.includes('-tag:v hvc1') && r.includes('format=yuv420p'));
  assert.ok(!r.includes('-maxrate') && !r.includes('main10'));
  assert.ok(!initArgs(h, 'in.mkv').join(' ').includes('-maxrate'));
  assert.ok(runArgs(a, 'in.mkv', 0, 0).join(' ').includes('-maxrate'));
  assert.ok(h.renditions[0].bandwidth < a.renditions[0].bandwidth);
  assert.match(masterPlaylist(h), /CODECS="hvc1\.1\.6\.L123\.B0,mp4a\.40\.2"/);
  assert.ok(!/VIDEO-RANGE/.test(masterPlaylist(h)));
});
