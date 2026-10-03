# Subtitle sync measurement

Measures how far each OpenSubtitles English candidate is from OUR stream's audio.
Needs: ffmpeg, a venv with `faster-whisper numpy`.

    python fetch_audio.py t/<name>/audio movie|tv tt123 [s e] [--srv=2]   # 8x2-min windows, media-time anchored (PTS)
    python fetch_subs.py  t/<name>/subs  tt123 [s e] --max=8               # candidates + metadata (falls back to /api/subs on the per-IP cap)
    python transcribe.py  t/<name>/audio                                   # ASR only 3 windows: most speech per third
    python align.py       t/<name>                                         # offset per window + fit audio = r*sub + c
    python vad_align.py   t/<name> --vad=energy                            # same, no ASR (browser-cheap energy VAD)

offset = audio_time - subtitle_time: positive = subtitle shows too EARLY, negative = too LATE.
