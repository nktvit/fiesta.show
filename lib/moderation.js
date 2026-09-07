// Shared comment-moderation call — used by api/comments.js AND
// scripts/moderation-evals.mjs (so tuning the prompt in one place is
// reflected everywhere it's used, and the eval suite tests exactly what
// production runs). Lives outside api/ so Vercel's zero-config /api routing
// never turns it into its own public endpoint.
//
// Policy (deliberately permissive on tone, strict on content-free noise):
//   - Explicit language, profanity, harsh criticism, and political/ideological
//     opinions are ALL allowed, however crude or one-sided.
//   - Rejected ONLY for: spam, gibberish, pure unargued abuse (insults with
//     no actual reaction/opinion behind them), or extreme dehumanizing hate
//     speech. A comment expressing any real opinion — even one word, even
//     profane, even political — is not "unargued abuse".
//
// `ai` is an ESM-only package (no CJS "require" export condition), so it's
// loaded via dynamic import() inside the async function rather than a
// top-level require() (which would throw ERR_REQUIRE_ESM in this CommonJS file).

const { z } = require('zod');

// Free-tier AI Gateway models confirmed to work for this call (checked this
// session): openai/gpt-5.4-mini, openai/gpt-5.4-nano, alibaba/qwen3.7-flash,
// inclusionai/ling-3.0-flash-fin. Paid-only on the free tier (fails
// immediately, not a rate limit): anthropic/claude-haiku-4.5,
// google/gemini-3.5-flash-lite, deepseek/deepseek-v4-flash-0731. Also ruled
// out: google/gemma-4-31b-it — available, but unreliably omits the schema's
// `reason` field (confirmed twice), which breaks showing the user why a
// comment was rejected.
//
// alibaba/qwen3.7-flash was tried first and missed a real hate-speech case
// (allowed a dehumanizing "wipe them all out" comment) that gpt-5.4-nano
// caught correctly on the same input — switched on that evidence.
const MODEL = 'openai/gpt-5.4-nano';

const ModerationResult = z.object({
  allowed: z.boolean(),
  reason: z.string(),
});

const SYSTEM_PROMPT = `You are moderating anonymous comments on a movie/TV streaming site's comment section. Be permissive: explicit language, profanity, harsh criticism, and political or ideological opinions are ALL allowed, no matter how crude or one-sided. Do not reject a comment just because it is rude, offensive in tone, or opinionated.

Reject ONLY if the comment (or the display name, if one is given) falls into one of these categories:

1. SPAM — advertisements, promotional links, or copy-pasted promotional content unrelated to a genuine reaction to the movie/show.
2. GIBBERISH — random characters, keyboard mashing, or text with no coherent meaning.
3. PURE UNARGUED ABUSE — vulgar name-calling or insults directed AT A PERSON (the director, an actor, other commenters, "you people") that do NOT critique that person's work — e.g. "the director is a cocksucker motherfucker" attacks the director personally without saying anything about his directing, so it is rejected. This is different from a harsh evaluative statement about the MOVIE/SHOW/PERFORMANCE itself, which is allowed no matter how brief or profane — e.g. "This is fucking piece of shit" (about the movie), "Awful movie.", or "half the cast can barely act" (critiques the acting, i.e. the work) all express a real reaction and are NOT this category. In short: crude judgments of the work = allowed; vulgar insults at a person with no critique of their work = rejected. A comment mixing both (a judgment of the movie plus a personal insult at someone with no work-critique) should still be rejected because of the personal-insult part.
4. EXTREME HATE SPEECH — content that dehumanizes or attacks people based on protected characteristics (race, ethnicity, religion, nationality, gender, sexual orientation, disability, etc.) — actual hate speech or slurs, not just a strong opinion.

Respond with allowed=true unless the comment (or display name) clearly falls into one of the four categories above. When allowed=false, "reason" must be a short, plain-language, user-facing sentence explaining why (e.g. "This comment doesn't contain any actual reaction to the movie — just abuse." or "That name looks like spam."). When allowed=true, "reason" can be an empty string.`;

async function moderateComment({ text, displayName }) {
  const { generateObject } = await import('ai');

  const prompt = `Comment text: ${JSON.stringify(text)}\nDisplay name (may be absent): ${JSON.stringify(displayName || null)}`;

  const { object } = await generateObject({
    model: MODEL,
    schema: ModerationResult,
    system: SYSTEM_PROMPT,
    prompt,
    // Borderline cases (e.g. abuse-with-no-content vs. a real-but-harsh
    // opinion) can flip verdicts across otherwise-identical calls at default
    // sampling — confirmed live (same eval case rejected in the eval suite,
    // then allowed on a live request minutes later). temperature: 0 doesn't
    // guarantee determinism but meaningfully reduces this variance.
    temperature: 0,
  });

  return object;
}

module.exports = { moderateComment, MODEL };
