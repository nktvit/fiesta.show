/** Translation targets offered in the lyrics footer and settings (Google Translate codes). */
export const MUSIC_LYRICS_LANGUAGES: readonly { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'id', name: 'Indonesian' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
];

/** The browser language when we offer it, else English. */
export function defaultLyricsLanguage(nav: { language?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): string {
  const lang = nav?.language ?? 'en';
  const exact = MUSIC_LYRICS_LANGUAGES.find((l) => l.code.toLowerCase() === lang.toLowerCase());
  if (exact) return exact.code;
  const primary = lang.toLowerCase().split(/[-_]/)[0];
  return MUSIC_LYRICS_LANGUAGES.find((l) => l.code.toLowerCase() === primary)?.code ?? 'en';
}
