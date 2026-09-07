// Re-runnable eval suite for the comment-moderation prompt (lib/moderation.js).
// Run after any prompt change to check for regressions:
//   npm run eval:moderation
//
// Each case has an expectedAllowed the prompt SHOULD produce. A failing case
// means the prompt needs tuning — the printed `reason` for every case (not
// just failures) is there to help judge borderline calls, not just pass/fail.
//
// Note on case 9: uses a fictional group name ("Zorbians") rather than a real
// slur/real target, deliberately — this repo shouldn't carry real hate-speech
// text as a checked-in fixture. It tests the dehumanization PATTERN; testing
// against real-world slurs should be done manually, out of band.

import { moderateComment } from '../lib/moderation.js';

const CASES = [
  {
    id: 'clean-positive',
    text: "This movie completely blew me away, the pacing was perfect and the lead's performance was incredible.",
    displayName: null,
    expectedAllowed: true,
  },
  {
    id: 'harsh-profane-substantive',
    text: 'This movie is fucking garbage, the plot makes zero sense and half the cast can barely act.',
    displayName: null,
    expectedAllowed: true,
  },
  {
    id: 'pure-unargued-abuse',
    text: 'this is fucking piece of smelly ugly shit, the director is a cocksucker motherfucker',
    displayName: null,
    expectedAllowed: false,
  },
  {
    id: 'insult-no-movie-content',
    text: 'you people are all idiots lol get a life',
    displayName: null,
    expectedAllowed: false,
  },
  {
    id: 'terse-real-opinion',
    text: 'Awful movie.',
    displayName: null,
    expectedAllowed: true,
  },
  {
    id: 'political-opinion-crude',
    text: 'This film is just propaganda dressed up as entertainment, typical Hollywood nonsense pushing an agenda nobody asked for.',
    displayName: null,
    expectedAllowed: true,
  },
  {
    id: 'spam-link',
    text: 'Best deals on watches!! Click here: bit.ly/totally-real-deal free shipping worldwide, limited time only!!!',
    displayName: null,
    expectedAllowed: false,
  },
  {
    id: 'gibberish',
    text: 'asdkfj alksdjf ;laksdjf laksjdf laksjdflk aslkdjf',
    displayName: null,
    expectedAllowed: false,
  },
  {
    id: 'hate-speech-placeholder',
    text: 'All Zorbians are subhuman vermin and the world would be better off if they were all wiped out.',
    displayName: null,
    expectedAllowed: false,
  },
  {
    id: 'spam-display-name',
    text: 'Really enjoyed this one, would watch again.',
    displayName: 'BuyCheapWatchesNow.com',
    expectedAllowed: false,
  },
];

// The AI Gateway free tier enforces a short rate-limit window (observed:
// exactly 5 calls succeed back-to-back, then every subsequent call in the
// same run fails, every time, regardless of how long you wait BETWEEN runs).
// The SDK's default retry backoff (~2s then ~4s) is nowhere near enough to
// clear that window on its own, so pace calls within this run instead of
// hoping retries catch up.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CALL_GAP_MS = 15000;

let passed = 0;
let failed = 0;

for (const [i, c] of CASES.entries()) {
  if (i > 0) await sleep(CALL_GAP_MS);

  let result;
  try {
    result = await moderateComment({ text: c.text, displayName: c.displayName });
  } catch (err) {
    console.log(`✗ FAIL  ${c.id}  (threw: ${err?.message || err})`);
    failed++;
    continue;
  }

  const ok = result.allowed === c.expectedAllowed;
  if (ok) passed++;
  else failed++;

  const mark = ok ? '✓ PASS' : '✗ FAIL';
  console.log(`${mark}  ${c.id}  expected=${c.expectedAllowed} actual=${result.allowed}`);
  if (result.reason) console.log(`        reason: ${result.reason}`);
}

console.log(`\n${passed}/${CASES.length} passed`);
if (failed > 0) process.exit(1);
