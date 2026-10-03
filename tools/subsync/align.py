"""Measure subtitle-vs-audio offset per window for every candidate.
usage: align.py <titledir> [--json]
offset = audio_time - subtitle_time  (positive: subtitle shows too EARLY; needs delaying)"""
import json, os, re, sys, glob
import numpy as np
T = sys.argv[1]
meta = json.load(open(f'{T}/audio/meta.json'))
words = {w['k']: w['words'] for w in json.load(open(f'{T}/audio/words.json'))}
cands = json.load(open(f'{T}/subs/cands.json'))
STOP = set('the and you that was for are with his her him she they them this what have not but all can your from out there were been has had our its just one get got know like well yeah okay right now then when who will would could should into about here come don did does didn isn aren wasn weren won wouldn couldn shouldn let gonna want say said see too very some any how why where because back down over more only really think going yes hey said tell'.split())
def norm(s): return re.sub(r"[^a-z0-9']", ' ', s.lower()).replace("'", '').split()
def ts(x):
    h, m, r = x.strip().replace('.', ',').split(':'); s, ms = r.split(',')
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms[:3].ljust(3, '0')) / 1000
AD = re.compile(r'opensubtitles|become vip member|advertise your product|osdb\.link|addic7ed', re.I)
def parse_srt(path, enc):
    raw = open(path, 'rb').read()
    for e in [enc or 'utf-8', 'utf-8', 'cp1252', 'latin-1']:
        try: txt = raw.decode(e.lower().replace('cp', 'cp') if e else 'utf-8'); break
        except Exception: pass
    cues = []
    for b in re.split(r'\n\s*\n', txt.replace('\r', '').lstrip('﻿')):
        m = re.search(r'(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)', b)
        if not m: continue
        text = re.sub(r'<[^>]+>|\{[^}]*\}', '', b[m.end():]).strip()
        if not text or AD.search(text): continue
        cues.append((ts(m.group(1)), ts(m.group(2)), set(t for t in norm(text) if len(t) >= 3 and t not in STOP)))
    return cues
RANGE, BIN = 900.0, 0.05
NB = int(2 * RANGE / BIN)
def window_offset(cues, ws, base):
    tok_index = {}
    for i, (a, b, toks) in enumerate(cues):
        for t in toks: tok_index.setdefault(t, []).append(i)
    acc = np.zeros(NB + 2)
    content = []
    for (w0, w1, w) in ws:
        toks = [t for t in norm(w) if len(t) >= 3 and t not in STOP]
        if not toks: continue
        t = base + w0; content.append((t, toks[0]))
        for i in tok_index.get(toks[0], []):
            a, b, _ = cues[i]
            lo, hi = t - b - 0.3, t - a + 0.3   # offsets that put the word inside the cue (+slack)
            if hi < -RANGE or lo > RANGE: continue
            i0 = max(0, int((lo + RANGE) / BIN)); i1 = min(NB, int((hi + RANGE) / BIN))
            acc[i0] += 1; acc[i1 + 1] -= 1
    v = np.cumsum(acc)[:NB]
    if not content or v.max() == 0: return None
    p = int(v.argmax()); best = v[p]
    plateau = np.where(v >= best - 0.5)[0]; plateau = plateau[np.abs(plateau - p) < 40]
    off = (plateau.mean() * BIN) - RANGE
    # second peak at least 3 s away
    mask = v.copy(); mask[max(0, p - 60):p + 60] = 0
    frac = best / len(content)
    # refine: median (first matched word time - cue start) for cues matched at this offset
    deltas = []
    for (t, tok) in content:
        for i in tok_index.get(tok, []):
            a, b, _ = cues[i]
            if a - 0.3 <= t - off <= b + 0.3: deltas.append(t - a)
    return {'off': round(off, 2), 'match': round(frac, 2), 'peak2': round(mask.max() / best, 2), 'n': len(content)}
rows = []
for c in cands:
    path = f"{T}/subs/{c['IDSubtitleFile']}.srt"
    if not os.path.exists(path): continue
    cues = parse_srt(path, c.get('SubEncoding'))
    per = []
    for w in meta['windows']:
        if w['k'] not in words: continue
        r = window_offset(cues, words.get(w['k'], []), w['start'])
        per.append(dict(r or {}, t=round(w['start'] + 60)))
    good = [p for p in per if p.get('match', 0) >= 0.25 and p.get('peak2', 1) < 0.7]
    fit = None
    if len(good) >= 3:
        at = np.array([p['t'] for p in good]); st = at - np.array([p['off'] for p in good])
        r_, c_ = np.polyfit(st, at, 1); res = at - (r_ * st + c_)
        fit = {'r': round(float(r_), 5), 'c': round(float(c_), 2), 'maxres': round(float(np.abs(res).max()), 2)}
    rows.append({'rank': c['rank'], 'id': c['IDSubtitleFile'], 'fps': c.get('MovieFPS'), 'dl': c.get('SubDownloadsCnt'),
                 'rel': (c.get('MovieReleaseName') or '')[:42], 'hi': c.get('SubHearingImpaired'), 'per': per, 'fit': fit,
                 'last_cue': round(cues[-1][1]) if cues else None})
if '--json' in sys.argv: print(json.dumps({'duration': meta['duration'], 'rows': rows})); sys.exit()
print(f"stream duration {meta['duration']:.0f}s  windows at " + ' '.join(str(round(w['start'])) for w in meta['windows'] if w['k'] in words))
for r in rows:
    offs = ' '.join((f"{p['off']:+7.1f}" + ('' if p.get('match', 0) >= 0.25 and p.get('peak2', 1) < 0.7 else '?')) if 'off' in p else '   n/a ' for p in r['per'])
    print(f"#{r['rank']:<2} {r['fps']:>6} {r['rel']:<42.42} | {offs} | fit {r['fit']} last_cue {r['last_cue']}")
    print('     match ' + ' '.join(f"{p.get('match',0):7.2f} " for p in r['per']))
