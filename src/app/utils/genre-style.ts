/**
 * Tile colours for the TMDB movie genres, chosen for the character of each one
 * (action = hot red, horror = blood on black, sci-fi = cold cyan, romance = rose, …).
 * Tailwind only generates classes it can see as complete literals, so every class
 * is spelled out here rather than built from parts. All stops are dark enough for
 * white text (>= 4.5:1).
 */
const FALLBACK = 'from-indigo-600 to-indigo-800';

const GENRE_GRADIENTS: Record<number, string> = {
  28: 'from-red-600 to-orange-700',        // Action
  12: 'from-emerald-600 to-teal-700',      // Adventure
  16: 'from-pink-600 to-violet-600',       // Animation
  35: 'from-amber-600 to-orange-700',      // Comedy
  80: 'from-stone-700 to-red-900',         // Crime
  99: 'from-emerald-700 to-stone-700',     // Documentary
  18: 'from-purple-700 to-indigo-900',     // Drama
  10751: 'from-sky-600 to-indigo-600',     // Family
  14: 'from-violet-600 to-fuchsia-700',    // Fantasy
  36: 'from-amber-800 to-stone-700',       // History
  27: 'from-red-800 to-zinc-950',          // Horror
  10402: 'from-pink-600 to-rose-600',      // Music
  9648: 'from-slate-700 to-indigo-900',    // Mystery
  10749: 'from-rose-600 to-pink-700',      // Romance
  878: 'from-cyan-700 to-blue-900',        // Science Fiction
  10770: 'from-slate-600 to-slate-800',    // TV Movie
  53: 'from-slate-800 to-orange-900',      // Thriller
  10752: 'from-stone-600 to-green-900',    // War
  37: 'from-amber-700 to-orange-900',      // Western
};

export function genreGradient(id: number): string {
  return GENRE_GRADIENTS[id] ?? FALLBACK;
}
