// Subtitles for the native player, sourced from OpenSubtitles' legacy REST API.
//
// Two modes on one endpoint:
//
//   LIST  GET /api/subs?id=tt123&type=movie|tv[&s=&e=]
//         -> { tracks: [{ lang, label, src }] }   (one best track per language)
//
//   VTT   GET /api/subs?file=<IDSubtitleFile>&enc=<SubEncoding>
//         -> text/vtt   (download .gz -> gunzip -> transcode -> SRT->VTT)
//
// The VTT url is token-less and stable (keyed by the numeric file id), so it
// edge-caches hard: each unique subtitle file is fetched from OpenSubtitles
// once globally, then served from Vercel's cache. Keeps us far under the
// per-IP download cap and off any metered bandwidth.

const { gunzipSync } = require('zlib');

const UA = 'Mozilla/5.0 (compatible; fiesta-subs/1.0)';
const SEARCH_BASE = 'https://rest.opensubtitles.org/search';
const DL_BASE = 'https://dl.opensubtitles.org/en/download/file';

// Map OpenSubtitles' SubEncoding strings to TextDecoder labels.
function decoderLabel(enc) {
  const e = String(enc || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!e || e === 'utf8' || e === 'ascii' || e === 'usascii') return 'utf-8';
  if (/^cp\d+$/.test(e)) return 'windows-' + e.slice(2); // cp1252 -> windows-1252
  if (/^windows\d+$/.test(e)) return 'windows-' + e.slice(7);
  if (/^iso8859\d+$/.test(e)) return 'iso-8859-' + e.slice(7); // iso88591 -> iso-8859-1
  if (/^\d+$/.test(e)) return 'windows-' + e;
  return e;
}

function decodeBuf(buf, enc) {
  for (const label of [decoderLabel(enc), 'utf-8']) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(buf);
    } catch {
      /* try next */
    }
  }
  return buf.toString('utf8');
}

// OpenSubtitles injects promo cues ("become VIP member", links to their site)
// at the head/tail of many files. Drop any cue block whose text matches.
const AD_RE = /opensubtitles|become vip member|advertise your product|osdb\.link|addic7ed/i;

function srtToVtt(srt) {
  const cleaned = srt
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  const blocks = cleaned
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b && !AD_RE.test(b));
  return 'WEBVTT\n\n' + blocks.join('\n\n') + '\n';
}

async function handleList(req, res) {
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const id = req.query.id;
  if (!id || !/^tt\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid IMDB ID. Expected format: tt1234567' });
  }
  const imdb = id.replace(/^tt/, '');

  // One language-agnostic search returns up to 100 results spanning ~20-35
  // languages; we group to the single best track per language below.
  const parts = ['imdbid-' + imdb];
  if (type === 'tv' && req.query.s && req.query.e) {
    parts.push('season-' + String(req.query.s).replace(/\D/g, ''));
    parts.push('episode-' + String(req.query.e).replace(/\D/g, ''));
  }
  const url = SEARCH_BASE + '/' + parts.sort().join('/');

  let list = [];
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error('search status ' + r.status);
    const json = await r.json();
    if (Array.isArray(json)) list = json;
  } catch (e) {
    // Best-effort: don't cache an upstream hiccup, just report no tracks.
    console.error('subs search error:', e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ tracks: [] });
  }

  // Best track per language: most-downloaded, must be gzip-downloadable srt.
  const byLang = new Map();
  for (const s of list) {
    const lang = s.ISO639;
    const fileId = s.IDSubtitleFile;
    if (!lang || !fileId || fileId === '0') continue;
    if (s.SubFormat && s.SubFormat.toLowerCase() !== 'srt') continue;
    const dl = parseInt(s.SubDownloadsCnt || '0', 10);
    const prev = byLang.get(lang);
    if (!prev || dl > prev._dl) {
      byLang.set(lang, {
        _dl: dl,
        lang,
        label: (s.LanguageName || lang) + (s.SubHearingImpaired === '1' ? ' (SDH)' : ''),
        src: '/api/subs?file=' + encodeURIComponent(fileId) + '&enc=' + encodeURIComponent(s.SubEncoding || ''),
      });
    }
  }

  const tracks = [...byLang.values()]
    .sort((a, b) => (a.lang === 'en' ? -1 : b.lang === 'en' ? 1 : a.label.localeCompare(b.label)))
    .map(({ _dl, ...t }) => t);

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
  return res.status(200).json({ tracks });
}

async function handleVtt(req, res) {
  const file = req.query.file;
  if (!file || !/^\d+$/.test(file)) {
    return res.status(400).json({ error: 'invalid file id' });
  }
  try {
    const r = await fetch(DL_BASE + '/' + file + '.gz', { headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error('download status ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const srt = decodeBuf(gunzipSync(buf), req.query.enc);
    const vtt = srtToVtt(srt);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=2592000, stale-while-revalidate=86400');
    return res.status(200).send(vtt);
  } catch (e) {
    console.error('subs vtt error:', e);
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.file) return handleVtt(req, res);
  return handleList(req, res);
};
