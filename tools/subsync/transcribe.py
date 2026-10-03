"""ASR every win_*.wav in <audiodir> -> words.json [{k, words:[[t0,t1,word],...]}] (times are window-relative)."""
import json, os, sys, glob, wave
import numpy as np
from faster_whisper import WhisperModel
d = sys.argv[1]; size = sys.argv[2] if len(sys.argv) > 2 else 'small.en'
m = WhisperModel(size, device='cpu', compute_type='int8', cpu_threads=8)
from faster_whisper.vad import get_speech_timestamps, VadOptions
def load(wav):
    with wave.open(wav) as w: return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
wavs = sorted(glob.glob(os.path.join(d, 'win_*.wav')), key=lambda p: int(p.split('_')[-1][:-4]))
# Only 3 fragments: per third of the film, the window with the most speech (cheap Silero VAD).
speech = {}
for wav in wavs:
    a = load(wav); speech[wav] = sum(t['end'] - t['start'] for t in get_speech_timestamps(a, VadOptions())) / len(a)
thirds = [wavs[i * len(wavs) // 3:(i + 1) * len(wavs) // 3] for i in range(3)] if len(wavs) > 3 else [[w] for w in wavs]
picked = [max(g, key=speech.get) for g in thirds if g]
print('speech ratio', {os.path.basename(w): round(v, 2) for w, v in speech.items()}, 'picked', [os.path.basename(w) for w in picked], flush=True)
out = []
for wav in picked:
    k = int(wav.split('_')[-1][:-4])
    a = load(wav)
    segs, _ = m.transcribe(a, word_timestamps=True, vad_filter=True, beam_size=5, condition_on_previous_text=False)
    words = [[w.start, w.end, w.word.strip()] for s in segs for w in (s.words or [])]
    out.append({'k': k, 'words': words})
    print(k, len(words), ' '.join(w[2] for w in words[:15]), flush=True)
json.dump(out, open(os.path.join(d, 'words.json'), 'w'))
