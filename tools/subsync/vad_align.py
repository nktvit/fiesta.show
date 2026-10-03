"""VAD-only alignment (what a browser could do): Silero speech mask vs cue mask, cross-correlated.
usage: vad_align.py <titledir> [--range=60] [--ids=a,b]   prints per-window offsets next to ASR ones."""
import json, os, sys, wave, glob
import numpy as np
from faster_whisper.vad import get_speech_timestamps, VadOptions
sys.argv_ = sys.argv
T = sys.argv[1]; opts = dict(a[2:].split('=', 1) for a in sys.argv[2:] if a.startswith('--'))
RANGE = float(opts.get('range', 60)); R = 100  # 10 ms bins
sys.argv = [sys.argv[0], T, '--json']
import importlib.util
spec = importlib.util.spec_from_file_location('al', os.path.join(os.path.dirname(__file__), 'align.py'))
meta = json.load(open(f'{T}/audio/meta.json')); cands = json.load(open(f'{T}/subs/cands.json'))
# reuse parse_srt from align.py without running it
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'align.py')).read().split('RANGE, BIN')[0]
ns = {}; exec(src.replace("meta = json.load", "#").replace("words = {", "#").replace("cands = json.load", "#"), ns)
asr = json.loads(os.popen(f"{sys.executable} {os.path.dirname(os.path.abspath(__file__))}/align.py {T} --json").read())
asr = {r['id']: r for r in asr['rows']}
masks = {}
for w in meta['windows']:
    with wave.open(f"{T}/audio/win_{w['k']}.wav") as f:
        a = np.frombuffer(f.readframes(f.getnframes()), np.int16).astype(np.float32) / 32768
    if opts.get('vad') == 'energy':
        # browser-cheap: 300-3400 Hz band energy per 10 ms, log, minus a 3 s rolling median, smoothed
        F = 160; nfr = len(a) // F
        spec = np.abs(np.fft.rfft(a[:nfr * F].reshape(nfr, F) * np.hanning(F), axis=1)) ** 2
        f = np.fft.rfftfreq(F, 1 / 16000); band = (f >= 300) & (f <= 3400)
        e = np.log10(spec[:, band].sum(1) + 1e-9)
        from numpy.lib.stride_tricks import sliding_window_view as sw
        pad = np.pad(e, 150, mode='edge'); base_ = np.median(sw(pad, 301)[:, ::5], axis=1)[:nfr]
        d = e - base_; d = np.convolve(d, np.ones(15) / 15, 'same')
        m = (d > 0.35).astype(np.float32)
    else:
        ts_ = get_speech_timestamps(a, VadOptions(min_silence_duration_ms=200, speech_pad_ms=0))
        m = np.zeros(int(len(a) / 16000 * R) + 1, np.float32)
        for s in ts_: m[int(s['start'] / 16000 * R):int(s['end'] / 16000 * R)] = 1
    masks[w['k']] = m
ids = opts.get('ids')
for c in cands:
    if ids and c['IDSubtitleFile'] not in ids.split(','): continue
    p = f"{T}/subs/{c['IDSubtitleFile']}.srt"
    if not os.path.exists(p): continue
    cues = ns['parse_srt'](p, c.get('SubEncoding'))
    out = []
    for w in meta['windows']:
        m = masks[w['k']]; base = w['start']
        # expected offset prior = ASR value is NOT used; search +-RANGE around 0 (and around last estimate)
        center = out[-1][0] if out and out[-1] else 0.0
        n = len(m); L = int(2 * RANGE * R)
        lo_t = base - center - RANGE
        cm = np.zeros(n + L, np.float32)
        for a_, b_, _ in cues:
            i0 = int((a_ - lo_t) * R); i1 = int((b_ - lo_t) * R)
            if i1 < 0 or i0 > n + L: continue
            cm[max(0, i0):min(n + L, i1)] = 1
        # score(off) = sum m[t] * cue(t - off), t window-relative; centered masks
        mm = m - m.mean(); cc = cm - cm.mean()
        sc = np.correlate(cc, mm, mode='valid')  # len L+1; index j -> cue time origin lo_t + j/R aligned to window start
        j = int(sc.argmax()); off = base - (lo_t + j / R)
        s2 = sc.copy(); s2[max(0, j - 300):j + 300] = -1e9
        out.append((round(off, 2), round(float(s2.max() / sc.max()), 2)))
    a_ = asr.get(c['IDSubtitleFile'])
    print(f"#{c['rank']:<2} {c.get('MovieFPS'):>6}  VAD: " + ' '.join(f"{o:+7.2f}" for o, _ in out))
    print(f"            ASR: " + ' '.join((f"{p['off']:+7.2f}" if 'off' in p else '    n/a') for p in a_['per']))
    print(f"         2nd/1st " + ' '.join(f"{q:7.2f}" for _, q in out))
