/** One syllable or word of a karaoke line. Times are seconds. */
export interface MusicLyricSyllable {
  start: number;
  end: number;
  text: string;
}

/** One lyric line. Times are seconds. */
export interface MusicLyricLine {
  start: number;
  end: number;
  text: string;
  /** Singer id from TTML (duets). */
  agent?: string;
  /** Background vocals (rendered smaller and dimmer, right after their main line). */
  background?: boolean;
  /** Word/syllable timing for karaoke. */
  syllables?: MusicLyricSyllable[];
  translation?: string;
  romanized?: string;
  /** Song part from TTML (Verse, Chorus...). */
  part?: string;
  /** Which side a duet line sits on. */
  align?: 'start' | 'end';
  /** Right-to-left text. */
  dir?: 'rtl';
}

export interface MusicLyrics {
  trackId: number;
  /** Provider name shown in the footer. */
  source: string;
  synced: boolean;
  wordSynced: boolean;
  lines: MusicLyricLine[];
  songwriters: string[];
}

/** Header tags of an LRC file. */
export interface MusicLrcMeta {
  ti?: string;
  ar?: string;
  al?: string;
  re?: string;
}
