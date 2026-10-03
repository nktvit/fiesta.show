"""Pull audio windows from our real stream with their media timeline position.

usage: fetch_audio.py <outdir> <type> <imdb> [s e] [--win=120] [--fracs=0.04,0.17,...]
Writes <outdir>/win_<k>.wav (16k mono) + meta.json {duration, windows:[{k,start,dur,pts0}]}.
start = media time (what video.currentTime shows) of the window's first sample.
"""
import json, os, subprocess, sys, urllib.request, urllib.parse, concurrent.futures as cf

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opts = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--'))
out, typ, imdb = args[:3]
se = args[3:5]
WIN = float(opts.get('win', 120))
FRACS = [float(x) for x in opts.get('fracs', '0.04,0.17,0.30,0.43,0.56,0.69,0.82,0.94').split(',')]
os.makedirs(out, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0'}

def get(url, binary=False, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                b = r.read()
                return b if binary else b.decode()
        except Exception as e:
            err = e
    raise err

q = {'type': typ, 'id': imdb}
if se: q.update(s=se[0], e=se[1])
if 'srv' in opts: q['srv'] = opts['srv']
info = json.loads(get('https://fiesta.show/api/stream?' + urllib.parse.urlencode(q)))
master = info['master']
origin = '{0.scheme}://{0.netloc}'.format(urllib.parse.urlparse(master))
lines = get(master).splitlines()
variants = []
for i, l in enumerate(lines):
    if l.startswith('#EXT-X-STREAM-INF'):
        bw = int(l.split('BANDWIDTH=')[1].split(',')[0])
        variants.append((bw, urllib.parse.urljoin(master, lines[i + 1])))
variants.sort()
media = variants[0][1]  # lowest bandwidth: audio is the same in every variant
segs, t, dur = [], 0.0, None
for l in get(media).splitlines():
    if l.startswith('#EXTINF'):
        dur = float(l[8:].split(',')[0])
    elif l and not l.startswith('#'):
        segs.append((t, dur, urllib.parse.urljoin(media, l)))
        t += dur
total = t

def pts(path):
    o = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time',
                        '-of', 'csv=p=0', path], capture_output=True, text=True).stdout.strip()
    return float(o.split('\n')[0])

seg0 = os.path.join(out, 'seg0.ts')
open(seg0, 'wb').write(get(segs[0][2], True))
pts_origin = pts(seg0)  # hls.js maps the first segment's PTS to media time 0

meta = {'master': master, 'upstream': info.get('upstream'), 'server': info.get('server'),
        'duration': total, 'nseg': len(segs), 'variant_bw': variants[0][0], 'windows': []}
for k, f in enumerate(FRACS):
    w0 = f * total
    pick = [s for s in segs if s[0] + s[1] > w0 and s[0] < w0 + WIN]
    with cf.ThreadPoolExecutor(6) as ex:
        blobs = list(ex.map(lambda s: get(s[2], True), pick))
    ts = os.path.join(out, f'win_{k}.ts')
    open(ts, 'wb').write(b''.join(blobs))
    p = pts(ts)
    start = p - pts_origin
    wav = os.path.join(out, f'win_{k}.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', ts, '-vn', '-ac', '1', '-ar', '16000', wav], check=True)
    os.remove(ts)
    meta['windows'].append({'k': k, 'start': start, 'playlist_start': pick[0][0], 'dur': sum(s[1] for s in pick)})
    print(f'win {k}: media {start:.3f}s (playlist {pick[0][0]:.3f}) len {sum(s[1] for s in pick):.0f}s', flush=True)
json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), indent=1)
print('duration', total)
