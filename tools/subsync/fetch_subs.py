"""Fetch all English SRT candidates (OpenSubtitles legacy REST) + metadata, mirroring api/subs.js ranking.
usage: fetch_subs.py <outdir> <imdb> [s e] [--max=12]"""
import json, os, sys, gzip, urllib.request, time
args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--'))
out, imdb = args[:2]; se = args[2:4]
MAX = int(opts.get('max', 12))
os.makedirs(out, exist_ok=True)
H = {'User-Agent': 'Mozilla/5.0 (compatible; fiesta-subs/1.0)'}
def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60) as r: return r.read()
        except Exception as e: err = e; time.sleep(1 + i)
    raise err
parts = ['imdbid-' + imdb.replace('tt', '')]
if se: parts += ['season-' + se[0], 'episode-' + se[1]]
res = []
for extra in ([], ['sublanguageid-eng']):
    res += json.loads(get('https://rest.opensubtitles.org/search/' + '/'.join(sorted(parts + extra))))
seen, en = set(), []
for s in res:
    if s.get('ISO639') != 'en' or s.get('IDSubtitleFile') in seen: continue
    if s.get('SubFormat') and s['SubFormat'].lower() != 'srt': continue
    seen.add(s['IDSubtitleFile']); en.append(s)
en.sort(key=lambda s: -int(s.get('SubDownloadsCnt') or 0))
cands = []
for rank, s in enumerate(en[:MAX]):
    fid = s['IDSubtitleFile']
    try:
        raw = gzip.decompress(get(f'https://dl.opensubtitles.org/en/download/file/{fid}.gz', tries=1))
    except Exception as e:
        try:  # per-IP cap hit: our proxy (CDN-cached files) returns VTT already decoded to UTF-8
            raw = get(f'https://fiesta.show/api/subs?file={fid}&enc=', tries=2); s = dict(s, SubEncoding='UTF-8')
        except Exception as e2:
            print('dl fail', fid, e, e2); continue
    open(os.path.join(out, f'{fid}.srt'), 'wb').write(raw)
    c = {k: s.get(k) for k in ('IDSubtitleFile', 'SubEncoding', 'SubDownloadsCnt', 'MovieReleaseName', 'SubFileName',
                               'MovieFPS', 'MovieTimeMS', 'MovieByteSize', 'MovieHash', 'SubHearingImpaired',
                               'SubFromTrusted', 'SubAddDate', 'SubRating', 'UserRank', 'SubAuthorComment', 'MatchedBy')}
    c['rank'] = rank
    cands.append(c)
    print(rank, fid, s.get('SubDownloadsCnt'), s.get('MovieFPS'), s.get('MovieTimeMS'), (s.get('MovieReleaseName') or '')[:60])
json.dump(cands, open(os.path.join(out, 'cands.json'), 'w'), indent=1)
