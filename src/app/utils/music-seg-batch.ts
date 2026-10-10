/**
 * Segment batching for the `seg` proxy: one request carries `c` consecutive
 * ~4 s segments (concatenated, in order), so a track costs ~10 requests instead
 * of ~70. The ramp keeps start-up fast: a single segment first (quick first
 * byte), then a few, then the steady-state maximum.
 */

/** Batch sizes for the 1st, 2nd, 3rd... request after init; the last one repeats. */
export const SEG_RAMP = [1, 4, 8];
/** Steady-state batch size (matches the server's clamp). */
export const SEG_MAX_BATCH = SEG_RAMP[SEG_RAMP.length - 1];

/**
 * How many segments to ask for next. `step` counts the requests made since the
 * start or the last seek; `cap` limits the batch (a standby deck only needs ~10 s);
 * the batch never runs past segment `total` (1-based) when starting at `next`.
 */
export function batchCount(step: number, next: number, total: number, cap = SEG_MAX_BATCH): number {
  const want = SEG_RAMP[Math.min(step, SEG_RAMP.length - 1)];
  return Math.max(1, Math.min(want, cap, total - next + 1));
}

/** URL for segments n..n+c-1 (c = 1 keeps the plain single-segment URL, which honours Range). */
export function batchUrl(media: string, n: number, c: number): string {
  return c > 1 ? `${media}&n=${n}&c=${c}` : `${media}&n=${n}`;
}
