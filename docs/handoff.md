# Session handoff

## IN PROGRESS (new session): comment spoilers + 15-minute edit window

Branch `feat/comment-spoilers-and-edit`, **not yet committed, not yet merged,
not deployed to production** — only to a preview (`streamfiesta-owpbiwzf2`).
User asked for two things: mark a comment as a spoiler, and let people edit
their own comment within 15 minutes of posting. Both are built and verified;
what's left is commit → merge → prod deploy.

**Spoilers.** `spoiler` is a client-set boolean stored on the comment member.
It is deliberately NOT a moderation concern — `lib/moderation.js` gets only
the text and display name, with no title or plot, so "is this a spoiler for
THIS film" is unanswerable from its inputs, and its schema has no outcome
between allow and reject (a spoiler category could only ever mean *delete the
comment*). The prompt was left untouched on purpose; don't add one later
without re-reading that reasoning. The UI renders a masked comment as its own
real text under `filter: blur(6px)` + `user-select: none` inside an
`overflow: hidden` box (the overflow matters — the blur otherwise bleeds
readable pixels outside), with a centred "SPOILER — TAP TO REVEAL" overlay.
Revealing is per-comment, page-view-local (a `signal<ReadonlySet<string>>`),
and the "Spoiler" pill that appears once revealed doubles as the re-hide
control. Note the blurred text IS still in the DOM — this is a courtesy mask,
not a secret.

**Editing.** New `PATCH /api/comments`. Enforced server-side against the
comment's own stored `createdAt`; the client's matching countdown only decides
when to stop drawing the pencil. Design points worth not re-deriving:
- **The edit re-runs moderation whenever the text changed.** Without that,
  "post something bland, then rewrite it" walks straight around the only
  safety mechanism this feature has. Verified for real against the preview:
  editing into `"the director is a cocksucker motherfucker"` came back 422
  with the model's own reason and the stored text untouched.
- **A no-op edit writes nothing** and doesn't stamp `(edited)`. This isn't
  just an optimisation: re-moderating already-approved text on a model that's
  documented as non-deterministic could 422 a comment that is already live.
- **The member swap is a Lua script** (`SWAP_MEMBER_SCRIPT`) doing
  ZSCORE → ZREM → ZADD, so the rewritten comment keeps its exact original
  score. `@upstash/redis` has no WATCH, and a `multi().zrem().zadd()` would
  ZADD unconditionally — leaving TWO members with the same comment id when
  the old one was already gone. The script returning 0 means "someone else
  changed or deleted this" → 409, which is also what stops a PATCH racing a
  DELETE from resurrecting a deleted comment (or recreating an orphaned
  `replies:{id}` set that no GET would ever read). Smoke-tested directly
  against real Upstash first, including unicode/quote/backslash byte fidelity
  through ARGV and the stale-member 0 path.
- **The new member is built from the STORED comment**, never merged with the
  request body. `id`, `clientId`, `country`, `parentId` and especially
  `createdAt` are server-owned. `createdAt` triples as the ZSET score, the
  pagination bound and the `nextCursor`, so letting an edit move it would both
  bump the comment up the feed and corrupt "Load more".
- **`editCount`, capped at `EDIT_MAX = 5`**, stored on the comment and
  stripped from GET responses. Rate limiters key on clientId and IP, both
  rotatable; this one isn't. It's the real control against re-submitting the
  same rejected text until the non-deterministic moderator happens to allow it.
- **Edits get their OWN rate limiters** (`ratelimit:comments:edit:*`, 5/5min
  per client, 15/10min per IP). Reusing the post limiter (1 per 20s) would
  have rejected the single most common edit there is — a typo spotted seconds
  after posting — about 60% of the time, depending only on where the original
  POST fell inside a fixed 20s bucket. Separate prefixes are fully isolated
  buckets, so edits can't starve posting.

**Also hardened while in there** (adjacent, flagged rather than silent):
`commentId`/`parentId` are now validated against the UUID shape in POST and
DELETE too, not just PATCH — they get interpolated straight into Redis key
names, so before this a client could create arbitrary `replies:<anything>`
keys. And `LikesCommentsComponent` gained its first `ngOnDestroy`, which also
clears the pre-existing `burstTimeout` leak.

**Verified** (preview `streamfiesta-owpbiwzf2-nktvit.vercel.app` + real
Upstash + real browser): 30/30 API assertions, a real moderation rejection on
an edit, and a browser pass covering the mask, reveal, re-hide, the inline
edit form, the inline moderation-error banner, and the pencil correctly
disappearing on a 17-minute-old comment. All test data was removed from Redis
afterwards — `content:movie:tt0111161` is back to zero members.

**Known/accepted**: the AI Gateway free-tier limit hit repeatedly during
testing (posting through the UI returned the fail-closed banner several
times). That's the pre-existing capacity ceiling documented below, not
something this change introduced — but it now applies to edits too, so a
moderated edit can fail with "Couldn't verify this edit right now".
`lib/moderation.js`'s default `maxRetries: 2` (one call → up to 3 attempts at
the bucket it just exhausted) was deliberately NOT changed here, since it
affects the POST path equally and deserves its own decision.

---

Written at a context-limit break — this session ran from ~407k tokens (first
guard warning) to ~507k (well past it, repeated warnings) without actually
stopping, because the user kept queuing small follow-ups in the same
session. **Start the next session fresh — do not continue this one.**
Everything below is already committed, pushed, and live on production
unless marked otherwise (this session shipped directly to `vercel deploy
--prod` after every change, verified live each time — check "Next task" for
the one thing that's genuinely unverified).

## SHIPPED (continued, same day, part 3): subcomments, trailer/bio fixes, contact removal

All committed, pushed, `vercel deploy --prod`'d, and spot-checked live on
`fiesta.show` after each change — commits `130f384`, `506bce2`, `3812753`
on top of everything in the sections below.

1. **One-level-deep comment replies** ("subcomments"), user-requested.
   Backend: `api/comments.js` — replies live in their OWN Redis sorted set
   per parent (`replies:{commentId}`), NOT interleaved into the top-level
   `comments:{key}` set, specifically so top-level pagination never has to
   reason about reply timestamps. Replies are NOT paginated (fetched in
   full whenever their parent comment is) — an intentional scope cut, fine
   while reply counts stay small, would need real pagination if a thread
   ever gets huge. `handleGet` does a two-pass pipeline: pass 1 gets each
   top-level comment's like state + its raw replies in one round trip;
   pass 2 (only once pass 1's reply count is known) gets every reply's own
   like state in a second round trip. **Verified this exact two-pass logic
   against real Redis with a synthetic multi-reply fixture before trusting
   it** — sort order, like counts, and `isMine` all confirmed correct.
   `handlePost` takes an optional `parentId` and writes to the right key.
   `handleDelete` takes an optional `parentId` to know which key to search;
   deleting a top-level comment cascades to `redis.del` its whole replies
   set (individual reply `commentlikes:{id}` keys are left as harmless
   orphans — not worth an extra round trip to enumerate, noted as an
   accepted simplification, not a silent gap).
   Frontend: `Comment` gained `parentId`/`replies`; `toggleCommentLike` and
   `deleteComment` on `LikesCommentsComponent` both take an optional
   `parentId` now and patch either a top-level comment or the right nested
   reply. New `replyingTo`/`replyText`/`postingReply` signals drive an
   inline reply composer under each top-level comment; a "Reply" button
   only appears on top-level comments (no replying to a reply, by design).
   **Full flow verified end-to-end via real API calls AND a real browser
   session**: post top-level → post reply with real `parentId` → GET
   confirms correct nesting → like the reply → delete-with-wrong-clientId
   correctly 403s → delete top-level cascades away its reply → confirmed
   gone from Redis.
2. **Trailer modal flicker, user-reported** (`movie-page.component.ts`).
   Root cause: `trailerUrl` was a plain getter calling
   `sanitizer.bypassSecurityTrustResourceUrl()` fresh on every
   change-detection pass — a NEW object every time even though the
   underlying URL string never changed, so Angular saw the iframe's
   `[src]` as "changed" on every CD cycle and reloaded the YouTube embed,
   which is what read as a blink/refresh. Fixed by memoizing the
   `SafeResourceUrl` keyed on `trailerKey`, only recomputing when the key
   itself changes. **If any other `bypassSecurityTrustX` call is ever
   added as a plain getter (not memoized), it will have this exact bug —
   this is a general Angular footgun, not something specific to trailers.**
   Also added: `document.body.style.overflow = 'hidden'` while the trailer
   modal is open (user asked for scroll-lock), reset on close AND on
   `ngOnDestroy` (covers navigating away mid-trailer). Verified live: body
   overflow toggles correctly, iframe gets a stable src.
3. **Person-page "Read More" button, user-reported** (bug: showed even for
   short bios). Root cause: visibility was gated on
   `bioParagraphs[0].length > 300` — a fixed character-count guess that
   doesn't track whether the paragraph actually overflows its
   `line-clamp-4`, since real wrapped-line count depends on font size and
   viewport width, not character count. Fixed with real DOM measurement:
   a `#bioClamp` template ref + `ngAfterViewChecked()` comparing
   `scrollHeight` vs `clientHeight`. Verified with two real people: a
   short single-paragraph bio (scrollHeight === clientHeight, confirmed no
   button) and a genuine 4-paragraph bio (button correctly shows via the
   separate "more than one paragraph" condition, independent of whether
   paragraph 1 alone is clamped). **Known, NOT fixed**: `movie-page.
   component.ts`'s Plot section (`isPlotLong = adjustedPlot.length > 400`)
   has the exact same bug pattern, just never reported. Same fix
   (DOM-measure via a template ref) would apply — flagging so it isn't
   independently "discovered" as a surprise later, but out of scope for
   what was actually asked this session.
4. **Removed contact/social sections**, user-requested: the whole "Get in
   Touch" section (Telegram/X links) from `about.component.html`, and the
   "Contact" paragraph from `terms.component.html` (which pointed at that
   now-deleted section). Removing the Terms paragraph left `RouterLink`
   unused in `terms.component.ts` — removed it too rather than leave a new
   NG8113 build warning behind (this repo has previously had an explicit
   pass to be build-warning-free; didn't want to quietly reintroduce one).
   **NOT touched, on purpose**: the "Support the Project" / Buy Me a
   Coffee section on the About page — that's a donation link, not a
   contact mention, and wasn't part of what was asked.

## SHIPPED (continued, same day): UI polish + delete-your-own-comment

All of this landed AFTER the "SHIPPED: anonymous likes & comments" section
below was written — that section is now slightly stale on layout details
(it still describes the original single-block placement); this section is
the up-to-date picture. Four separate commits, each built → previewed →
verified with Playwright → merged to `main` → pushed → `vercel deploy --prod`
→ re-verified live, same discipline as everything else this session:

1. **Repositioned the like/comments UI** (user-requested layout change):
   the Fiesta like badge now lives in the ratings row next to IMDb/RT/
   Metacritic (not its own block), and the comment thread moved to below
   "You Might Also Like" instead of directly under the player.
   Mechanism: `LikesCommentsComponent` gained a `mode: 'like' | 'comments'`
   input — one component, two placements, each instance only fetches the
   data its own mode needs (`reload()` branches on `mode()`). Two
   `<app-likes-comments>` instances now exist in
   `movie-page.component.html`: `mode="like"` in the ratings `<div>`
   (~line 108-148 area), `mode="comments"` after the recommendations
   `@if` block.
2. **Fixed a real layout bug the user caught**: the homepage
   (`main.component.html`)'s navbar had `[class.top-8]="!navbar.scrolled"`
   — a 32px reserved gap for the "ad-free player" banner (see below) that
   was left behind after the banner was removed, so removing the banner
   alone didn't close the gap. Fixed by just making the navbar always
   `top-0`. **If a similar "I removed X but the spacing is still there"
   report comes up again, check for this exact pattern first**: a fixed/
   sticky element with a scroll-conditional offset class is an easy thing
   to miss when deleting the element it was reserving space for.
3. **Icon quality, user-flagged**: the movie-card hover play icon (added
   earlier this session) was visibly off-center at large size — it used a
   hand-rolled triangle path (`M8 5v14l11-7z`, copied from an existing
   "Watch Trailer" button elsewhere, where the asymmetry is less
   noticeable next to text) plus a manual `translate-x-0.5` hack that
   didn't fully fix it. Replaced with Heroicons' actual solid Play icon
   path (properly balanced on its own, no hack needed) in
   `poster.component.html`. Also swapped the like heart to Heroicons'
   matched outline/solid pair (was reusing one path with a fill/stroke
   toggle, which is a similar smell — works but isn't as crisp as the
   real matched icons).
4. **Like button redesign** (user asked for "something great" — loaded the
   `frontend-design-v2` skill for this one): liked state now uses the
   site's own established brand gradient (`from-indigo-500 via-fuchsia-500
   to-pink-500` — the exact gradient from the removed banner, repurposed
   as "Fiesta's color" instead of a generic red heart) plus a heart-pop +
   6-particle CSS burst animation (`likes-comments.component.css`) that
   fires only on liking, not unliking, not on the initial fetch. Verified
   the animation actually fires (not just "looks right in code") via a
   direct DOM check right after a real click: particles spawn, correct
   classes apply, cleanup after ~650ms, and — importantly — confirmed
   ZERO particles spawn on unlike.
5. **Comment deletion** (user-reported gap: "I cannot delete my own
   comment" — there was genuinely no delete endpoint at all, GET/POST
   only). Added `DELETE /api/comments` — body `{type, id, s?, e?,
   commentId, clientId}`, ownership-checked against the comment's stored
   `clientId` (the same anonymous identity already used for `isMine`,
   since there are no accounts). Also deletes the comment's
   `commentlikes:{id}` key. **Non-obvious implementation detail, verified
   directly against real Redis before trusting it**: `ZREM` needs the
   exact original member string, but `@upstash/redis` sometimes
   auto-deserializes a JSON member back into an object on read (same
   surprise as the GET-path pagination code hit earlier) — so the delete
   handler re-serializes with `JSON.stringify` when the entry didn't come
   back as a raw string (`rawMember()` helper in `api/comments.js`), and a
   direct smoke test confirmed this round-trips correctly (`ZADD` two
   comments as JSON strings → `ZRANGE` back → re-stringify one → `ZREM`
   with it → confirmed exactly the right one was removed). Frontend: a
   trash icon appears only on `c.isMine` comments, `window.confirm()`
   before deleting (this app has no other confirm-dialog precedent, but a
   destructive, unrecoverable action on user content warranted the extra
   step), optimistic removal with rollback on error.
   `LikesCommentsService.deleteComment()` uses `HttpClient.delete()` with
   a body (Angular supports this via the `{ body }` option).

**Also resolved in conversation, no code needed**: user asked whether a
specific live Russian-language comment ("Плохой фильм, хуйня, залупа
конская" — "bad movie, garbage, [vulgar intensifier]") was moderated
correctly. Assessed: yes — all three phrases target the MOVIE, not a
person, so per the existing pure-unargued-abuse policy (crude opinion
about the work = allowed) this should be and was allowed. Notable as a
positive signal that the moderation prompt's nuanced policy generalizes
correctly to non-English text, not just the English eval cases.

## SHIPPED: anonymous likes & comments — merged, pushed, live on production

**Merged to `main` (commit `bf53688`, merge commit on top) and pushed to
`origin/main`.** Deployed to production via `vercel deploy --prod` and
confirmed aliased to `https://fiesta.show`. Verified live on production
(not just preview): `/api/likes` responds correctly, the movie page loads
with the component rendered (`Comments (0)`, like button, identity picker),
zero browser console errors. Did NOT re-run a live moderation call against
production specifically (already verified thoroughly against the preview
earlier this session — see below — and didn't want to spend more of the
tight/erratic free-tier AI Gateway quota on a redundant check).

`feat/likes-comments` branch still exists locally (safe to delete — it's
fully merged, `git merge-base main feat/likes-comments` equals
`feat/likes-comments`'s tip).

**Full plan** is at `/Users/nick-mbp/.claude/plans/functional-percolating-pillow.md`
— data model, API contracts, component design, wireframe. Everything below is
status/deltas on top of it, not a replacement.

### What's actually done

Everything in the plan's "Implementation order" is built AND verified working
end-to-end against the real Upstash instance and a real Vercel preview
deployment (`https://streamfiesta-5rmznc5nq-nktvit.vercel.app` as of this
session's last deploy, redeployed after the moderation model swap below —
preview URLs are ephemeral, redeploy to get a fresh one):

1. **Upstash provisioned** — `KV_REST_API_URL`/`KV_REST_API_TOKEN`/etc. are
   live in `vercel env ls` (Production, Preview, Development) and pulled into
   `.env.local`. `@upstash/redis`'s `Redis.fromEnv()` picks them up via its
   `KV_REST_API_*` fallback (confirmed by reading the installed package
   source, not assumed).
2. **`lib/redis.js`** (new) — shared `Redis.fromEnv()` client.
3. **`lib/content-key.js`** (new) — `resolveContentKey` (the
   `content:movie:{id}` / `content:tv:{id}:s{s}:e{e}` builder+validator) and
   `resolveLikeTargetKey`/`commentLikesKey` (see per-comment likes below).
4. **`lib/moderation.js`** — the shared moderation call. Model is
   **`alibaba/qwen3.7-flash`**, not the plan's original
   `anthropic/claude-haiku-4.5` assumption (see "Moderation model" below for
   why). `temperature: 0` was added this session after catching a real
   non-determinism issue live (see "Known limitation" below) — don't remove
   it.
5. **`api/likes.js`** — handles BOTH movie/episode likes (`type`/`id`/`s`/`e`)
   AND, new this session, **per-comment likes** (`commentId`) through the
   same endpoint — same idempotent Set+SADD/SREM/SCARD pattern either way,
   just a different Redis key (`resolveLikeTargetKey` picks which). One IP
   rate limiter (30/min) covers both.
6. **`api/comments.js`** — GET/POST as planned, PLUS: each comment in a GET
   response now carries `likeCount`/`liked`, batch-fetched via
   `redis.pipeline()` (one round trip for the whole page, not 2 calls ×
   20 comments) — needed once per-comment likes were added.
7. **`vercel.json`** — both functions added (`memory: 1024, maxDuration: 15`,
   matching house style; note Vercel now warns `memory` is ignored under
   Active CPU billing — harmless, matches the other pre-existing entries,
   not something to fix here).
8. **`src/app/services/likes-comments.service.ts`** (new) — `getLikes`,
   `toggleLike`, `getComments`, `postComment`, `toggleCommentLike`. Owns the
   `fiesta:client-id` localStorage identity, same pattern as
   `movie-player.component.ts`'s `SUBTITLE_PREF_KEY`.
9. **`src/app/components/likes-comments/`** (new) — `LikesCommentsComponent`,
   signals/effect-based, refetches on `imdbId`/`type`/`season`/`episode`
   change (verified: TV episode switch gets an independent thread — this was
   an explicit design requirement, confirmed correct both by code inspection
   of the content-key scheme and is safe to state with confidence even though
   it wasn't separately browser-tested this session).
10. **Wired into `movie-page.component.html`/`.ts`** — one
    `<app-likes-comments>` after both player blocks, before recommendations.
11. **Per-comment likes** (added mid-session, NOT in the original plan doc —
    the user asked for it after seeing the like/comment separation question).
    Each comment gets its own like button/count in the UI
    (`toggleCommentLike` in the component, heart icon next to each comment in
    the template).
12. `ng build` clean, no new warnings.

### Verified this session (real Upstash + real deployed preview + real browser)

- Redis command semantics smoke-tested directly against production Upstash
  before trusting them in the endpoints: SADD/SREM/SCARD/SISMEMBER toggle
  correctly; the `ZRANGE key max min BYSCORE REV LIMIT offset count` argument
  order (note: max BEFORE min when REV is combined with BYSCORE — easy to get
  backwards) paginates correctly; `@upstash/redis` **auto-deserializes** JSON
  string members back into objects on read (the `typeof entry === 'string' ?
  JSON.parse(entry) : entry` guard in `api/comments.js` is load-bearing, not
  defensive-programming excess — confirmed both cases actually occur);
  `redis.pipeline()` batches many commands into one round trip correctly.
- `/api/likes` GET/POST round-tripped correctly against a live preview via
  curl (like → count 1 → reload GET shows liked:true → unlike → count 0).
- `/api/comments` fail-closed path confirmed for real: an actual
  `GatewayRateLimitError` from the AI Gateway (see below) was caught, logged
  server-side, and returned as a `422` with **nothing saved** — the safety
  mechanism's failure mode was exercised for real, not just code-reviewed.
- Full browser flow via `playwright-cli` against the preview: like button
  toggles optimistically AND persists across a real page reload (same
  browser/localStorage); posted a real comment in "Random name" mode
  (generated "Curious Tiger"), it appeared immediately with the correct
  🇮🇪 flag (`title="Ireland"` via `Intl.DisplayNames`), "(you)" marker, and
  "just now" timestamp — the whole identity→moderation→save→render chain
  confirmed live, not just unit-level.
- All test data (comments, comment-likes, content-likes) created during this
  session's testing was cleaned out of the real Redis instance afterward —
  `content:movie:tt0111161`'s likes/comments keys are back to empty. Confirm
  this is still true before treating any pre-existing data on that key as
  real user data.
- NOT separately browser-tested this session: TV episode-switch independence
  (only verified by code/key-scheme inspection, not a live click-through),
  and the `[Load more]` pagination cursor (only smoke-tested directly against
  Redis with synthetic data, not through the actual API+UI).

### Moderation model (changed from the plan, with real findings — changed AGAIN mid-session)

The plan assumed `anthropic/claude-haiku-4.5`. Reality, confirmed by actually
calling each model against the AI Gateway this session:

- **Paid-only on this account's free tier** (immediate rejection, not a rate
  limit — don't bother retrying these without adding billing):
  `anthropic/claude-haiku-4.5`, `google/gemini-3.5-flash-lite`,
  `deepseek/deepseek-v4-flash-0731`.
- **`google/gemma-4-31b-it`**: available, but confirmed TWICE to unreliably
  omit the schema's `reason` field entirely (`generateObject` throws a schema
  validation error) — not usable for this feature, since showing the user
  *why* a comment was rejected is the point.
- **Actually usable on the free tier**: `openai/gpt-5.4-mini`,
  `openai/gpt-5.4-nano`, `alibaba/qwen3.7-flash`, and
  `inclusionai/ling-3.0-flash-fin` (this one needed several separate attempts
  across the session before finally getting a real answer instead of a rate
  limit — don't conclude a model is broken from one rate-limited attempt).
- **Currently wired up: `openai/gpt-5.4-nano`** (switched from
  `qwen3.7-flash` mid-session — see head-to-head finding below).
- **CORRECTED (had this wrong earlier in this same doc): per Vercel's own AI
  Gateway docs, the free-tier rate limit is PER-MODEL, not account-wide.**
  It felt account-wide this session for two explainable reasons, not because
  the docs are wrong: (1) the `ai` SDK auto-retries a `429` up to
  `maxRetries: 2` (3 attempts total, ~2s/4s backoff) by default — so a
  single rate-limited call immediately burns 2 more attempts against the
  exact quota it just exhausted, right when it's least likely to have
  recovered, which cascades into "everything downstream in the same run also
  fails"; (2) per the docs, "a `429` on either tier may come from the
  upstream provider rather than from AI Gateway" — so testing a fresh model
  right after exhausting a different one can coincidentally hit a real
  provider-side limit too. **Don't re-litigate the shape of this limit
  further** — it's genuinely erratic run-to-run (sometimes ~5 calls succeed
  then the rest of that run fails; sometimes even with 15s pacing between
  calls — see `scripts/moderation-evals.mjs`'s `CALL_GAP_MS` — the very
  first call fails while later ones succeed) and Vercel's own docs say this
  is expected free-tier behavior, not a bug to fix client-side. **The real,
  documented fix**: buying AI Gateway Credits moves the team to the paid
  tier, which removes AI Gateway's rate limit entirely (only the
  underlying provider's own, typically much higher, limit remains) — this
  is the exact mechanism behind the error message's own "upgrade to paid
  credits" suggestion. Production impact if this ships without adding
  billing: real visitors posting comments could occasionally see "Couldn't
  verify this comment right now" during traffic clusters — not a
  correctness bug (the fail-closed design is intentional), just a capacity
  ceiling.
- **Eval suite status: NOT a clean 10/10 on any single run yet**, across
  several attempts on two different models, purely due to the rate limit
  above (not prompt/logic failures — every case that actually got a real
  answer either passed or, in the one exception below, revealed a real
  finding). Don't trust any "N/10 passed" count from a single run as the
  full picture — cross-reference which specific case IDs got real answers.

### Head-to-head finding: qwen3.7-flash missed a real hate-speech case, gpt-5.4-nano caught it

The `hate-speech-placeholder` eval case (fictional "Zorbians are subhuman
vermin... wiped out" — see `scripts/moderation-evals.mjs`'s own comment on
why it's fictional, not a real slur) is supposed to be rejected under policy
category 4. On one run, `alibaba/qwen3.7-flash` returned `allowed: true` for
it with no reason given — a genuine miss on the most severe rejection
category, not just a borderline-case judgment call. Given the exact same
input (same prompt, same `temperature: 0`), `openai/gpt-5.4-nano` correctly
returned `allowed: false` with a clear reason ("extreme hateful
dehumanization and calls for harm against a group"). That's the reason for
the model switch. **Caveat**: this is one head-to-head data point on one
case, not a full comparative eval (the rate limit prevented a real 10/10 run
on nano too — confirmed passing on nano so far: `clean-positive`,
`harsh-profane-substantive`, `pure-unargued-abuse`,
`hate-speech-placeholder`). Also worth holding loosely: it's possible qwen's
miss was itself non-determinism (see below) rather than a systematic
weakness — one more reason not to over-index on a single sample per model
before the rate limit lets a real multi-run comparison happen.

### Known limitation: moderation is not perfectly consistent — real, observed

**This is not a code bug, don't try to "fix" the API for it.** Confirmed
live this session: the exact text `"you people are all idiots lol get a
life"` was correctly rejected by `scripts/moderation-evals.mjs` (case
`insult-no-movie-content`), then, minutes later, the SAME text was posted
through the real UI on the live preview and got `allowed: true` from the
same model (`qwen3.7-flash`, before the switch to nano) — confirmed via
`vercel logs` that no error occurred, i.e. the model itself gave a different
verdict on a near-identical borderline case. This is inherent to using an
LLM as a binary content gate on subjective "is there a real point here"
judgments — it will not be perfectly deterministic. Mitigation applied:
`temperature: 0` added to the `generateObject` call in `lib/moderation.js`
(was previously unset, so running on default sampling variance) — reduces
but does not eliminate this. If borderline-case flip-flopping becomes a real
user complaint later, the next lever is a stricter prompt or a
second-opinion re-check on borderline verdicts, not just temperature.

### Moderation policy (clarified with the user in an earlier session, not just my assumption)

Don't re-derive or second-guess this: **profanity, harsh criticism, and
political/ideological opinions are ALL allowed, however crude.** Reject ONLY:
spam, gibberish/random-character noise, "pure unargued abuse", or extreme
dehumanizing hate speech. The pure-unargued-abuse line, refined THIS session
after the first prompt draft failed its own calibration case: it's not about
whether the comment *explains* its opinion (a bare "Awful movie." is
allowed) — it's **critique of the work vs. a vulgar personal insult at a
person** (director/actor/other commenters) **with no critique of their work**.
*"the director is a cocksucker motherfucker"* → rejected (personal insult,
no critique of his directing). *"half the cast can barely act"* → allowed
(crude, but it's a critique of the acting, i.e. the work). Both calibration
cases now pass with this wording — see `lib/moderation.js`'s `SYSTEM_PROMPT`
(category 3) for the exact text, and `scripts/moderation-evals.mjs` for the
regression cases (now paced 15s apart between calls — `CALL_GAP_MS` — since
firing 10 calls back-to-back was itself partly why full runs kept failing;
see "Moderation model" below for why pacing alone still isn't a complete
fix). See that section for the real, current per-case pass/fail picture —
don't trust a bare "N/10 passed" count from a single run, and don't
re-derive case-by-case status from scratch; it's tracked there.

### Country-of-origin (added mid-plan, already folded into the approved plan doc)

Comments show the country they were posted from. Mechanism (verified against
current Vercel docs, not assumed): `req.headers['x-vercel-ip-country']` on
the classic Node `(req, res)` handler style this project's `api/*.js` files
use — NOT the `@vercel/functions` `geolocation()` helper, which expects a
Fetch `Request` object and doesn't fit this project's handler style. Store
the 2-letter code per comment; derive the flag emoji client-side (Unicode
codepoint math) and the country name via `Intl.DisplayNames` — no new
dependency for this part. Absent/`null` in local dev (header only exists on
real Vercel edge traffic).

## Small fixes batch (earlier in this session, same day as the relay work above)

All merged to `main` (`88b38be`/`9cfef24`/`4b8dbce`/`f7b8b1d`), deployed, and
verified on `fiesta.show` itself:

1. **Cast row now wraps into multiple lines** instead of horizontal-scrolling
   (`movie-page.component.html`) — matches the Directors row right above it,
   which already wrapped correctly. A subagent did the actual edit
   (mirrored Directors' `flex flex-wrap gap-4` + dropped `flex-shrink-0`);
   verified visually on both preview and prod.
2. **Two build warnings resolved**: removed `SearchBoxComponent` from
   `MainComponent`'s imports (dead — not used in its template; `NavbarComponent`
   already imports it for its own template) — fixed the NG8113 warning. Bumped
   `tsconfig.json`'s `target`/`useDefineForClassFields` to `ES2022`/`false`
   explicitly — the Angular CLI's esbuild builder was silently overriding these
   on every build anyway (real ECMA-version control for the shipped bundle is
   via Browserslist, not tsconfig `target` — confirmed by reading
   `node_modules/@angular/build/src/tools/esbuild/angular/compiler-plugin.js`),
   so this just stops the pointless warning without changing any build output.
   Verified: `ng build` warning-free, Karma test suite (`ChromeHeadless`, needs
   `CHROME_BIN` pointed at the installed Chrome.app — not on PATH by default)
   shows the same pre-existing 30-pass/5-fail split before and after (the 5
   failures are `movie.service.spec.ts` expecting a hardcoded OMDB API key
   that's blank in this local dev env — unrelated, pre-existing, confirmed via
   `git stash` + re-run).
3. **Legacy-browser routing broadened** (`middleware.js`): previously only
   UAs containing the literal substring `"Tizen"` got routed to the `/lite`
   (React 17, Chrome-47-floor) bundle. Any other engine old enough to lack
   `Proxy` (added Chrome 49 — Zone.js needs it) but not TV-branded — old
   Android TV boxes, other smart-TV browsers, or literally any UA reporting
   `Chrome/<49` — fell through to the modern bundle and would have failed to
   load. Added a second check: parse the Chrome major version from the UA,
   route to `/lite` if `< 49`. Verified with spoofed UAs via curl against both
   preview and prod: modern Chrome → real app, Chrome 48 (no Tizen token) →
   `/lite`, Chrome 49 (boundary) → real app, Tizen → still `/lite`.

**Separately, in-conversation only (no code written yet)**: user asked about
storage for an anonymous likes/comments feature and confirmed **Upstash
Redis** (atomic `INCR` for likes, a per-movie sorted set of JSON comment blobs
for comments, `@upstash/ratelimit` for anonymous-abuse throttling) — not yet
provisioned, do that via `vercel integration add upstash` per the
`vercel:marketplace`/`vercel:vercel-storage` skills, not a hand-rolled client.
Also confirmed: Vercel AI Gateway gives every team **$5/month free credits**
(zero markup, OIDC auth via `vercel env pull`) — earmarked for a simple
LLM-based moderation call on those comments; not yet implemented.

**Also noticed, not yet acted on**: `git push` warned the GitHub remote moved
— `origin` still points at `github.com/nktvit/streamfiesta-client.git` but
GitHub now redirects it to `github.com/nktvit/fiesta.show.git`. Push/pull
still work via the redirect, but worth updating the remote URL
(`git remote set-url origin ...`) at some point so it's not relying on that.

## Continuation: video preload / relay (this session)

User's ask: *"can we improve preloading? anything to do with the relay
itself?"* Investigated `tools/fiesta-proxy/relay.mjs` fresh (per the prior
session's note not to trust secondhand understanding) and found a real issue:
`handleHls`'s segment path buffered the **entire** upstream response
(`Buffer.from(await upstream.arrayBuffer())`, ~1-2MB) before sending any bytes
to the browser — the actual thing capping how fast the play buffer built
ahead.

**Shipped, merged to `main` (`5b35be2`/`453fb16`) AND deployed live to the
actual relay process — both halves confirmed working end-to-end:**

1. `movie-player.component.ts`: enabled hls.js's `progressive: true`, so
   fragments append to the buffer as they stream in rather than waiting for
   the whole response.
2. The relay's segment path now pipes the upstream body straight through
   (`pipeline(Readable.fromWeb(upstream.body), res)`) instead of buffering
   the whole ~1-2MB response first — cuts time-to-first-byte per segment,
   pairs with #1. Also aborts the upstream fetch if the client disconnects
   mid-download (seek/tab-close), and no longer forwards upstream's
   `Content-Length` for segments.
3. Ran an adversarial-review workflow on the diff before shipping. It caught
   a real, reproduced bug: forwarding upstream's `Content-Length` verbatim
   while streaming a `fetch()`-decoded body is unsafe, because Node's `fetch`
   transparently decodes `Content-Encoding` (gzip/br) but the header still
   reports the **pre-decode wire length** — a mismatch would corrupt HTTP
   framing on the keep-alive connection. Fixed by just not forwarding it.
   Also fixed a minor related issue: an unguarded `AbortError` from the
   playlist branch's `upstream.text()` would log as `[relay] unhandled` on
   ordinary client disconnects; now suppressed in the outer handler.

**Important: I initially assumed I had no way to deploy/test the relay half
and said so in this doc — that was wrong, and the user corrected it
mid-session.** There IS SSH access: `ssh mm` reaches the home Mac mini (user
`ms`). Use it. What actually happened once I checked:

- The relay does **not run from this git repo at all** — it's a standalone,
  ungitted deployment at `/Users/ms/Server/relay.fiesta.show/relay.mjs` on
  the Mac mini (`git status` there: "not a git repository"). The process
  (`show.fiesta.relay`, a launchd service, currently pid found via
  `ps aux | grep relay`) is started via
  `launchctl kickstart -k gui/$(id -u)/show.fiesta.relay`.
- That live file is **975 lines / ~39.5KB**, vastly beyond this repo's
  342-line/~13KB copy: it has a multi-hop resolver chain (`walkFromEmbed`,
  `walkFromLayer2`, `extractPlayerIframeApi`, `decryptStreamUrls`,
  `getHostToken`), a real Playwright-driven (`playwright-core`, `chromium`)
  headless-browser Turnstile fallback, per-request UA rotation carried
  through child URLs, a `/resolve` result cache, and `srv=1/2` front
  selection — i.e. the `vsembed.ru`/headless-browser features that
  `api/stream.js`'s commit messages describe DO exist, just never in this
  repo's copy. **The repo's `relay.mjs` is not a mirror of production and
  hasn't been for a long time** — it appears to be a much older/simpler
  snapshot that was never kept in sync. Nothing currently syncs them.
- Confirmed via `.autofix/` on the box: there's also a launchd-scheduled
  watchdog (`show.fiesta.relay.autofix`, every 5 min) that greps `relay.log`
  for a "same resolve error across ≥3 distinct titles" signature and, if it
  fires, invokes a **headless `claude -p` agent with a $3 budget** to
  autonomously diagnose, patch `relay.mjs` live, restart the service, and
  verify — with instructions to revert and log "NEEDS HUMAN" if it can't
  verify clean. This has **never actually triggered** (no
  `.autofix/autofix.log` exists at all) — the drift described above predates
  it and was hand-written directly on the box. Worth knowing this exists
  before anyone else touches that file: check `.autofix/checkpoint`/lock
  state for an in-progress run before editing, mirror its own verification
  procedure (`node --check`, `launchctl kickstart -k`, curl `/resolve` +
  fetch the returned master, tail `relay.log`) after editing, and back up
  the file first (no git = no free rollback) — I did all of this.
- Given the structural gap, I re-applied the *same* streaming/Content-Length/
  abort fix directly to the live 975-line file (not a copy-over of this
  repo's version, which would have silently deleted the resolver chain,
  headless fallback, cache, and UA rotation — backed up first
  (`relay.mjs.bak-20260907T181342Z`, still on the box), edited, verified
  `node --check` locally and on the box, restarted via `launchctl kickstart
  -k`, then verified live: `/resolve` for both a movie and a TV episode,
  fetched the real master playlist + a media playlist + an actual segment
  through the public `relay.fiesta.show` domain (valid MPEG-TS, 400KB, no
  bad Content-Length), tailed `relay.log` for a clean restart with no new
  errors, and confirmed real browser playback with Playwright directly on
  `fiesta.show` afterward (playing, buffered 120s ahead within 8s of
  pressing play, no errors). **Both halves of this fix are now actually live
  and verified**, not just committed to git.

**Open item, not yet acted on:** the repo's `tools/fiesta-proxy/relay.mjs`
is now confirmed stale/non-representative of production and will keep
drifting from whatever the autofix agent or manual edits do next. Worth
asking the user whether they want the git copy properly reconciled with the
real file (a much bigger diff than today's — the resolver chain alone is
several hundred lines) or just left as a rough reference. Also still stale:
`docs/stream-proxy-architecture.md` describes the old two-Lambda
Webshare-proxy model and references `api/hls.js`, which no longer exists in
the repo (confirmed deleted, not just moved — not in `vercel.json` either).

## Live and verified in production (prior session)

All merged to `main`, deployed, and confirmed working on `fiesta.show` itself
(not just previews):

1. **Legacy-TV support** (`tv/` dir, `middleware.js`) — a separate downleveled
   React 17 client served to Tizen 3.0 (2017 Samsung TV) browsers via Vercel
   Routing Middleware, since Angular 20/Zone.js needs `Proxy` (unavailable on
   that engine). Root path handled correctly (middleware runs pre-cache,
   unlike declarative `vercel.json` rewrites which lose to static-file
   precedence for `/`).
2. **Movie/person link previews** (`middleware.js`) — crawlers (iMessage,
   Slack, Discord, ...) never ran the Angular JS that fills in real
   title/poster/description, so every shared link showed the generic site
   card. Middleware now intercepts fresh `/movie/:id` and `/person/:id`
   navigations, fetches real metadata (handles both IMDb-style and numeric
   TMDB ids — most internal links use the latter), and injects it into the
   served HTML before it's ever seen.
3. **Speed Insights per-route tracking** (`app.component.ts`) — was installed
   but only initialized once at boot; since this is a client-routed SPA every
   Web Vital was attributed to whichever route loaded first. Now hooks
   `Router.events` to call `setRoute()` on every navigation.
4. **Middleware runtime** — moved off the now-deprecated edge runtime to
   Node.js (`runtime: 'nodejs'` in `middleware.js`'s config), per Vercel's own
   build-time warning.
5. **Subtitle 403 retry** (`api/subs.js`) — OpenSubtitles' search API
   intermittently 403s (confirmed transient: same request retried immediately
   succeeds). Added to the existing retryable-status set.
6. **Subtitle background preload + two real browser bugs fixed**
   (`movie-player.component.ts`) — see "Subtitle system" below, it's the
   meatiest change and worth reading before touching that file again.

Housekeeping done: merged/dead branches deleted (both local and `origin`) —
`feat/legacy-tv-support`, `feat/link-preview`, `feat/movie-page-redesign`,
`feat/person-link-preview`, `feat/person-pages`, `feat/person-search`,
`fix/tv-routing`, `worktree-movie-page-redesign` (+ its `origin` copy, an
abandoned April redesign attempt superseded by the real one). `.gitignore` now
actually excludes `.playwright-cli/**` (it didn't before, despite an earlier
session believing it did — that's why stray test-artifact cleanup kept
recurring).

## Open decisions — nothing urgent, just unresolved

- **`origin/feat/new-player`** (remote branch, never merged) — investigated
  thoroughly. Verdict: **fully dead, safe to delete**. 9 of its 10 commits
  already reached `main` independently under different SHAs (same
  author/timestamp, byte-identical diffs — someone cherry-picked most of it
  at some point without a real merge). The 10th ("stagger subtitle reveal")
  was superseded by a better fix that's also already on `main`. User has not
  yet said "yes, delete it" — just ask, it's a rubber stamp.
- **`feat/audio-quality`** (local branch, `876f2cf`) — Web Audio loudness
  normalization for the player (measures LUFS from the HLS master playlist's
  custom tag, applies a clamped gain boost via `GainNode`). Merges cleanly
  onto current `main`. User tested it live and "didn't notice the
  difference" — parked, not rejected. Don't merge without asking again.
- **`feat/mobile-bottom-nav`** (local-only, never pushed, ~5 months old) — a
  complete bottom-nav + search-overlay component predating the movie-page
  redesign. `main` has no bottom nav today. Merges cleanly but is stale
  relative to everything built since — revisit design fit before reviving it,
  don't just merge it.
- **RU/UA streaming sources + Jellyfin — both purely conversational this
  session, ZERO code written for either.** Don't start building either
  without the user explicitly asking again; here only so the context isn't
  lost.
  - RU/UA aggregators (HDRezka/UAKino/Filmix) were researched as a possible
    vidsrc-style addition for non-English content — see the research
    findings earlier in this doc (or ask; a background agent produced them,
    they're not re-derived here). **Since then the user mentioned HDRezka
    "recently introduced premium mode"** — i.e. it may no longer be as freely
    resolvable as the research assumed; treat that research as partially
    stale if this comes up again, re-verify before acting on it.
  - Separately, the user is considering paying for shared access to someone
    else's Jellyfin/Plex server via Reddit reseller communities (e.g.
    r/JellyfinShares — pasted a few concrete listings this session:
    BingeKings, PrimeHub, Plexify). Established with the user: this is
    fundamentally different from vidsrc/HDRezka (a self-hosted media-server
    API you'd become a *client* of, not a public embed to scrape) and only
    works as a **personal, gated feature** given the tiny concurrent-stream
    caps these resellers impose (Plexify: 2 streams for $50/yr) — not
    something to wire into the public movie pages. User is still comparing
    options, hasn't purchased anything, explicitly said not to shop-compare
    resellers for them (unverifiable anonymous sellers, a personal trust
    call). **Next step is entirely user-driven**: if they come back with an
    actual server URL + API key, Jellyfin has a real documented REST API
    (auth, then `/Items` to browse, `/Videos/{id}/stream` to play) — a much
    more straightforward integration than the vidsrc/cloudnestra resolver
    chain, no headless-browser/Turnstile work needed.

## Next task

None queued — everything explicitly asked for this session is shipped and
verified live (see the three "SHIPPED" sections above, newest first).
**This doc was written at a severe context-guard break (~507k tokens) —
start the next session fresh, don't continue this one.**

Nothing is blocking; if the user doesn't bring anything new, the honest
list of not-yet-done items from this session is: moderation eval suite
still not a clean confirmed 10/10 due to the AI Gateway free-tier limit
(see "Moderation model" above); TV episode-switch independence and comment
pagination are only code-verified, not click-tested live; the reply
feature's replies aren't paginated (fine at small scale, noted as a cut);
movie-page's Plot section has the identical "Read More shows when it
shouldn't" bug just fixed on the person page, never independently reported
though. Also still parked, unless the user brings it up again: the RU/UA
streaming-source research and the Jellyfin-reseller idea (both purely
conversational, zero code). See "Continuation: video preload / relay"
further below for one
older loose end (confirm the user restarted the relay process, and ask
about the `relay.mjs`/`api/stream.js` drift).

## Subtitle system — architecture notes (for future work in this file)

`movie-player.component.ts`'s subtitle handling changed significantly this
session. Current model, in case it needs touching again:

- `vttCache` (a `signal<Map<string,string>>`) is the **only** source of truth
  for whether a `<track>` has real content — keyed `lang::label`, values are
  `blob:` URLs of already-fetched VTT text. There is no more
  `loadedSubtitleKeys` / raw-network-src fallback path; it was removed
  entirely because it was unreliable (see next point).
- **Real, reproducible browser bug found and worked around**: a `<track>`
  element whose `src` attribute is assigned dynamically *after* the element
  already exists in the DOM can **silently never fetch** — confirmed by
  direct repro (toggling `.mode`, even re-touching the exact same `src`
  value, did nothing; only ever assigning a track a `src` it didn't already
  have reliably triggered a load). Fix, applied in two places:
  1. The default/restored track is fetched *before* its `<track>` element is
     even created (`loadSubtitles()` awaits `prefetchTrack()` first).
  2. The on-demand path (`wireSubtitlePersistence`, `assignTrackSrc()`)
     assigns a resolved blob URL directly via `el.setAttribute('src', ...)`
     rather than trusting Angular's reactive `[attr.src]` binding to have
     committed to the DOM by the time the code acts on it.
- **Second, related race**: `applySubtitlePreference()` runs off an
  `effect()` watching `subtitleTracks()`, which can fire before a freshly
  (re-)rendered track list (episode switch) has actually committed to the
  DOM — silently no-op'ing. Fixed by re-applying once more after a
  `queueMicrotask`.
- Series correctness: `vttCache` is fully cleared and all its blob URLs
  revoked on every `loadStream()` call (covers episode switch, retry, server
  escalation) — critical, since the cache key carries no episode identity and
  a stale entry would silently show the wrong episode's subtitles under the
  same language label. Verified repeatedly across real episode switches.
- **Known external constraint, not a bug in our code**: under this session's
  testing volume, OpenSubtitles' *download* host (`dl.opensubtitles.org`,
  distinct from the search host) started 502ing every request specifically
  from this Vercel project's egress IP, while the identical file succeeded
  instantly from an unrelated IP — a real IP-level rate-limit/block, not
  per-request flakiness. `PRELOAD_GAP_MS` was set to 800ms (from 400ms)
  accordingly. Vercel's CDN caches each VTT file 30 days, so real
  steady-state traffic hits the download host far less than concentrated
  testing does, but this is a genuine fragility of relying on a free legacy
  service — don't be surprised if it recurs, and don't assume more
  client-side tuning alone fixes it.

## Working style notes for whoever picks this up

- Every feature this session went: branch → build locally → deploy a Vercel
  *preview* → verify with real Playwright browser tests (not just curl) →
  merge `--no-ff` to `main` → push → wait for the production deployment to
  finish building → verify again directly on `fiesta.show` (not just the
  preview URL). Keep doing this — it caught real bugs every time it was done
  thoroughly (the `<track>` src-timing bug above was found *because* of this,
  not despite it).
- `vercel curl <url>` for hitting preview deployments (deployment protection
  is disabled for this project's previews, but `vercel curl` handles it
  either way). Plain `curl` works fine against `fiesta.show` directly.
- `playwright-cli` leaves `.playwright-cli/` artifacts in the cwd — now
  actually gitignored, but still worth `rm -rf`'ing when done to keep the
  working tree clean for `git status` checks.
- **`tools/fiesta-proxy/relay.mjs` (this repo) is NOT the production relay**
  and merging a change to it does **not** deploy anything — it's not part of
  the Vercel build (nothing in `vercel.json` references it). The real, much
  larger relay lives ungitted at
  `/Users/ms/Server/relay.fiesta.show/relay.mjs` on the home Mac mini and is
  reachable via **`ssh mm`** (user `ms`) — use it, don't assume no access.
  To ship a relay change: `scp` the edited file up (back up the original
  first — there's no git there, so no free rollback), `node --check` it
  (full path: the box's node isn't on the non-interactive PATH — it's at
  `/Users/ms/.nvm/versions/node/v22.17.0/bin/node`, found via
  `ps aux | grep relay`), restart with
  `launchctl kickstart -k gui/$(id -u)/show.fiesta.relay`, then verify with
  real `/resolve` + segment curls through `relay.fiesta.show` (see the
  "Continuation" section above for the exact commands used and why). There's
  also a launchd-scheduled autofix watchdog on that box (`.autofix/`,
  `scripts/autofix-watchdog.sh`) that can invoke its own headless Claude
  agent to patch `relay.mjs` — check `.autofix/checkpoint`/lock state isn't
  mid-run before editing.
