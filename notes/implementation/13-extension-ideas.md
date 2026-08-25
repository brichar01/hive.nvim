# Extension ideas — §17

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 17. Extension ideas

**Nothing in this section is measured, scheduled, or in §15's build order.** It is
a holding area for designs that are worth writing down before they are worth
building, and it is kept to the same evidential standard as the rest of the plan
in one respect only: where a claim here *is* grounded in something measured
elsewhere in the document, it cites the section; where it is not, it says so.
Numbers that would have to be measured before any of this ships are listed per
idea rather than estimated.

### 17.1 Per-file plans, generated from a plan file

#### 17.1.1 The idea, and what it actually is

Given a prose plan file — the kind an agent writes before a feature, of which
this document is an example — produce a second, **structured** file: one record
per source file the feature touches, each naming the file's role in the feature
if it is new, or what has to change in it if it exists. Hive then seeds R1 for a
given target from that file's record.

The framing that makes the rest of this section fall out: **this is not an
extension, it is the specification R1 does not currently have.** R1 is the only
region of the session buffer with no defined shape — §3.4 scaffolds it with a
prompt in an HTML comment and §4.2 reads it back as opaque lines. Two existing
requirements are already reaching for a shape it does not have:

- §8.3.1's prefix-cache finding (recorded as a gap in §16.1 #8) requires that
  everything above R3 be **byte-stable across submits**, and free prose typed
  into a live buffer is the least byte-stable thing in the design.
- §8.3.6 step 4 trims R1 **from the top, keeping the most recent prose**. That
  rule is only correct if R1 is an append-only human log. It is the wrong rule
  for anything with a header line worth keeping.

So the honest description is: this idea proposes a structure for R1, and a way to
fill it that happens to be an agent.

#### 17.1.2 What already exists that this leans on

Four things in the current plan make this cheaper than it looks, and they are the
reason it is worth recording rather than dismissing.

1. **§1's module layout table *is* the target artifact, hand-written.** A list of
   filenames, each marked `(new)` or `(edit)`, each with a one-line role —
   `extract.lua  (new)  R3 builder — treesitter slice around the target`. That is
   exactly the output being described, produced by hand from exactly this kind of
   plan file. It doubles as the acceptance test: run the generator over
   `notes/implementation/*.md` and diff its output against §1's table. A generator
   that cannot reproduce a table a human already wrote from the same source has
   not earned a place on the roadmap.
2. **§4.1's scan-and-detect parser is the right parser for LLM output**, for the
   reason it was chosen for the session buffer: it returns `nil` on a missing
   *or duplicated* header instead of confidently picking the first match. A model
   emitting one stray `##` heading is the same failure class as a user yanking a
   block containing `# hive: code`, and §4.2's `locate` already answers it
   correctly. Reuse the discipline, not necessarily the code.
3. **§3.1's session-file slug already keys on the target file**, so the mapping
   from a record to a session buffer is a name lookup and not a new index — with
   one caveat in §17.1.6.
4. **R2 answers "what exists"; this answers "what should exist".** They do not
   overlap, and the case where the new signal is the *only* signal is the one
   this design is for: a file that does not exist yet. For a new file, §7.1's
   `documentSymbol` returns nothing and §7.4's consumers return nothing, correctly
   and unhelpfully. The per-file record is the only thing in the prompt that knows
   what the file is supposed to become.

#### 17.1.3 The artifact

Markdown, not JSON. The file is a review artifact before it is a machine input —
it will be read, corrected by hand and committed — and §4.1's scan works on
headings. A fixed grammar, one record per file:

```markdown
# hive: file plans
source: notes/implementation/01-overview.md
source-sha: 3f2a1c…

## lua/hive/extract.lua
status: new
role: R3 builder — turns a Hive.Target into prefix/suffix/hole plus a strategy.
depends: lua/hive/target.lua, queries/lua/locals.scm

## lua/hive/config.lua
status: edit
role: transport, FIM, budget and region options for the session buffer.
change: add the `budget` and `code` tables; validation failure reverts the whole table.
```

Three properties are load-bearing:

- **One record is one file.** The record that reaches R1 is the target's record
  alone. Sending the whole plan is what makes this expensive (§17.1.6).
- **No timestamps, no ordering that depends on when it ran.** Records sorted by
  path. This is §8.3.1's rule, and it is the single easiest way to accidentally
  destroy the 6x prefix-cache win: a `generated: <date>` line at the top of a
  file that renders into the top of the FIM prefix costs a full cold prefill on
  every submit thereafter.
- **The provenance lives in the file's own header, not in a record.** `source`
  and `source-sha` answer "is this stale?" (§17.1.6) without entering R1's body.

#### 17.1.4 The generator, and how it is triggered

Out of process, and **not from inside the plugin**. Hive spawns exactly one kind
of subprocess — `curl` — and every fix in §9.3 exists because `vim.system` throws
and an unguarded throw in a coroutine is a silent hang [R§2]. A second subprocess
with its own authentication, a multi-minute runtime and no bounded output would
land on the wrong side of every constraint in §11: it cannot share I4's
one-in-flight rule, it cannot be debounced at §11.3's 300 ms, and it would make
§14's "the whole suite runs with no server" false.

So: the generator writes a file, hive reads a file. That is the entire interface,
and it keeps §1's "no new dependencies" true.

On the trigger, one correction to the shape as proposed. **A skill is the wrong
mechanism for the trigger, and the right one for the template.** A skill is
selected by the model from its description; a slash command is invoked by name.
For a headless run whose whole point is determinism, the instruction should be a
command — `.claude/commands/file-plans.md` — invoked as `claude -p "/file-plans
notes/implementation/01-overview.md"`, with the format spec either inline or in a
template asset the command reads. A skill can be added on top if the same thing
should fire in interactive sessions; it should not be the only entry point.

**Verify before building: this repo's skills are not where Claude Code looks.**
The six skills here live under `.agents/skills/`, and none of them appear in this
session's available-skills list — the loaded skills are all user-level and
built-in. `.claude/` in this repo contains only `worktrees/`. Whatever the
`.agents/` convention is being used for, a skill placed there should not be
assumed to load; check with `ls .claude/skills` and by whether the name is offered
before relying on it, and mirror or move if not.

#### 17.1.5 What hive does with the file

One new subcommand and one seeding path:

| Subcommand | Args | Behaviour |
| --- | --- | --- |
| `plan` | `[path]` | seed R1 for the current target from `path`'s record; with no arg, use the configured plan file |

Config, alongside §2's `session` block:

```lua
plan = {
  file = nil,          -- string?  path to the structured file; nil disables
  seed = "manual",     -- "manual" | "on_open" — never on refresh
},
```

`seed = "on_open"` at most. **Seeding must never run on refresh or submit.** A
refresh that rewrote R1 would violate I2 in the most annoying possible way — it
would delete prose the user typed while thinking — and it would put a
per-submit-varying byte at the top of the prefix, which is §8.3.1's cold-path
trap again.

The seeded text is delimited textually, not by extmark:

```markdown
# hive: notes

<!-- hive:plan lua/hive/extract.lua -->
R3 builder — turns a Hive.Target into prefix/suffix/hole plus a strategy.
<!-- /hive:plan -->

Anything the user writes lives here and is never touched.
```

Textual delimiters rather than marks because R1's whole purpose is to survive a
reload (I2), and a reload silently re-points extmarks at unrelated text
[R§12.5] — §11.2 already clears provenance on `BufReadPost` of the session
buffer, so mark-based "this part is generated" cannot answer the question after a
restart. A comment pair can. Re-seeding replaces the delimited span and nothing
else.

#### 17.1.6 The collisions — what in the current plan has to change

This is the part worth having written down. Six, in descending order of how much
they cost to discover late.

1. **I1 gains a third exception, and it is the one that can destroy user work.**
   "Hive never writes above the `# hive: context` header" currently has two
   declared exceptions — first-open scaffolding (§3.4) and repair (§4.4) — and
   both are guarded by the region never having existed or being already broken.
   Seeding is neither. I1 is enforced "by convention, not by construction":
   §4.2's `M.write` will happily target the notes region. Any version of this
   needs an assertion that the seed path is the *only* caller that passes R1 to
   `write`, and a test for it.
2. **§8.3.6's R1 trim rule is wrong for structured content.** It drops from the
   top and keeps the most recent prose; the seeded block is at the top and its
   first line is the file's role, which is the highest-value token in R1. At
   §8.3.3's `reserve.notes = 0.15` that is **134 tokens on the CPU tier** — about
   100 words for the seed *and* everything the user typed. The rule has to become:
   trim the user's prose from the top first, and the seeded block last, or
   per-record with a cap. Not doing this makes the feature silently self-defeating
   in exactly the way [R§8.10] forbids.
3. **§3.1's slug collides, and this feature is what exposes it.** The session path
   is `<git-root-basename>__<file-stem>.hive.md`. A plan touching `foo/init.lua`
   and `bar/init.lua` produces two records and **one** session buffer. This is a
   pre-existing defect independent of this idea, but a per-file plan is the first
   thing that routinely hands hive two same-stem paths at once. The fix is a
   path-derived slug, and it should happen whether or not this ships.
4. **I5 needs a ruling.** "Every byte hive wrote is attributable" — seeded R1
   bytes are bytes hive wrote, in a region §10.1's provenance namespace does not
   cover. Either the delimiter comment *is* the attribution (preferred — it
   survives reload, which marks do not) and I5's wording is widened to say so, or
   R1 is exempted explicitly. Leaving it undecided is how I5 quietly becomes
   false.
5. **Staleness has no mechanism.** The structured file is generated once; the code
   moves. There is no `changedtick` analogue [R§8]. `source-sha` in the file
   header is the minimum — hive compares it to the plan file on disk and warns
   once on a mismatch. It must stay in the header and out of the record body, or
   it re-enters R1 and (2) and the prefix cache both bite.
6. **§0.2's "no multi-file editing" holds and must be restated.** A per-file plan
   is a multi-file *artifact*; it is read one record at a time and §10.4's
   transplant still targets one buffer. The temptation this creates — "apply the
   plan across all its files" — is a different product.

#### 17.1.7 What would have to be measured, and the one real risk

Unmeasured, in the order that would decide whether to build it:

- **Does a role line change the completion at all?** The whole design rests on R1
  being worth its 15% reserve, and that has never been tested. The A/B is cheap:
  the same target, the same R2/R3, with and without the seeded block, on the
  §8.3.4 tier. If the answer is no, the correct outcome is to cut `reserve.notes`
  and donate it to context, which is a useful result either way.
- **Does the seeded block hold the prefix cache?** §8.3.1's directional finding
  predicts a warm submit stays warm as long as the block is byte-identical.
  `scripts/measure/prefill.lua` already measures this.
- **Does the generator reproduce §1's table?** §17.1.2 (1) is the test; it needs
  no server and no API to score, only a diff.

The real risk is not technical. It is that a generated role line is *plausible*
and the model conditions on it just as hard when it is wrong as when it is right —
and unlike R2, which is derived from the code and is therefore falsifiable against
it, R1 is derived from a plan and has nothing to check it against. §16.1 #11 is
this document's own record of what a confident, stable, wrong input costs. A
per-file plan is a confident, stable input by construction. That is an argument
for keeping the block short, delimited, visible in the buffer and trivially
deletable — all of which the design above does — and not an argument that it is
safe.

### 17.2 Keeping the workbench out of the prompt — fold markers in R1

#### 17.2.1 The problem this solves

R1 becomes a dumping ground. That is not a misuse of it; it is what an
always-open buffer next to the code you are working on turns into — the task
statement, plus the todo that occurred to you mid-thought, plus the question for
someone else, plus a note about a different file entirely. §17.1.1 already names
R1 as the region with no defined shape. This is the same observation arriving
from the other direction: the shape it acquires on its own is a pile.

Two existing rules decide what that costs.

- **`reserve.notes` is 0.15 — 422 tokens, about 320 words** (§8.3.3), and the
  same on both tiers. That is a comfortable task statement and not much more, and
  R1 is the only region whose size is bounded by nothing except how long the
  buffer has been open.
- **§8.3.6 step 4 trims R1 from the top, keeping the most recent prose.** That
  rule is correct for an append-only log, which §17.1.1 also notes. A dumping
  ground is interleaved by *topic*, not by recency, so when it does fire the rule
  drops the task statement at the top and keeps the todo list at the bottom — the
  exact inversion of what is worth sending.

Whether R1 is over 422 tokens in practice is unmeasured and §17.2.5 lists it
first; the point here is that the failure mode when it is over is the wrong one.

The user-facing ask is "let me minimise the junk and have it not be sent". The
mechanism it appears to want is Neovim's folds. It is not, quite.

#### 17.2.2 Fold *state* is the wrong lever

Verified in `scripts/verify/folds.lua` (`make verify-folds`) — 21 checks, all
green on NVIM v0.12.5, 2026-08-25. No server, no parser, no plugin.

| Claim | Check | Result |
| --- | --- | --- |
| Fold state is window-local: the same buffer in two windows disagrees | `W1` | open in one (`-1`), closed in the other (`5`) |
| A manual fold does not survive a reload | `T6` | `5` before `:e!`, `-1` after |
| A marker fold does | `T5` | `5` before `:e!`, `5` after |
| The text reader answers with no window on the buffer at all | `T3` | 0 windows, same lines |

Not checked there but measured the same day: under `foldmethod=expr` with
`vim.treesitter.foldexpr`, `foldclosed()` before a `zx` returned **`1` where the
fold actually starts at `3`** — not `-1`, a confidently wrong boundary. It is
[R§12.5]'s failure shape in a different primitive, and it is absent from the
script rather than passing in it because reproducing it would put a parser on
that script's runtime path.

Three consequences, in the order that decides the design:

1. **There is often no window to ask.** §3.2 sets `bufhidden = "hide"`, and §5
   exists precisely because the user is usually *not* in the session buffer when
   the code they care about is on screen. A submit issued from the code buffer
   finds no window on R1 at all, and `foldclosed()` then answers about whichever
   buffer the current window holds — silently, and wrongly.
2. **The state does not survive the buffer.** R1 is a real file (§3.1, I2) that
   will be reloaded and reopened across restarts. Manual folds are gone at that
   point (`T6`), so "minimised" silently un-minimises and the prompt silently
   grows back. That is [R§8.10]'s no-silent-caps rule broken from the unusual
   direction: content *re-enters* the prompt with nothing reported.
3. **It puts reading state above R3, which §8.2 forbids.** The layout rule is
   unconditional — *"if R1/R2 rendering is not byte-stable across submits, every
   submit pays the cold price."* Fold state is reading state: the user folds a
   section to scroll past it and unfolds it to check a line, several times a
   minute, and under a fold-driven rule each toggle rewrites the head of the FIM
   prefix. Be honest about the size of this one on the current baseline: §8.3.1
   measures the prefix cache at **~6x on prefill — 0.76 s cold against 0.13 s
   warm at ~1500 tokens** — so the loss is a fraction of a second against a ~8.0 s
   cold submit that is mostly decode, and §8.3.1 says as much ("it matters less
   here than it would on a slower server"). It is not the argument on its own.
   It is free to keep, it was expensive on every slower server measured, and (1)
   and (2) settle the question without it.

#### 17.2.3 The design: the marker is the truth, the fold is its rendering

Put the exclusion in the file, as `{{{`/`}}}` inside an HTML comment, and set
`foldmethod = "marker"` so minimising and excluding become the same act:

```markdown
# hive: notes

rename build_args to request_args

## parked <!-- {{{ -->
- ask ben re: the 400 on llama.cpp
<!-- }}} -->

still relevant
```

Three properties follow, each the negation of a §17.2.2 row: it is readable with
no window (`T3`); it survives reload and restart (`T5`); and it is byte-stable,
so the cache holds unless the user changes what is *included*. A fourth is free:
it is visible in the file, so `git diff` on the session file shows what got
parked.

The reader hive ships is the text one — `nvim_buf_get_lines`, a depth counter,
no window:

```lua
for _, line in ipairs(lines) do
  if line:find("{{{", 1, true) then depth = depth + 1
  elseif line:find("}}}", 1, true) then depth = math.max(0, depth - 1)
  elseif depth == 0 then keep[#keep + 1] = line end
end
```

`T2` verifies it returns exactly what a `foldclosed`/`foldclosedend` walk returns
while the folds are closed. `T4` verifies the deliberate divergence: after the
user opens a fold to read it, the window walk grows and the text reader is
**byte-identical**. That disagreement is the feature — reading is not editing,
and reading must not move a prompt byte.

Marker placement is a documentation matter rather than a code one, and it cuts
both ways by design: a marker **on** a heading takes the heading with it (`F1`),
one on the line **below** leaves the heading standing as a visible stub
(`F4`/`F5`). Both are useful and hive need not care which the user picked.

Where it hooks in:

- **§3.2's option block gains `foldmethod = "marker"` and `foldlevel = 0`**, so a
  newly marked section opens minimised. These are *window* options, so they
  belong on `BufWinEnter` for the session buffer rather than on a one-shot open —
  `W1`'s divergence is the same fact seen from the setter's side.
- **The filter belongs in `prompt.lua` (§8), not in `region.read` (§4.2).**
  `read` should stay the buffer's faithful view for `refresh`, `repair` and
  anything else that needs to round-trip it, and §8 is where the excluded count
  can be folded into §8.3.6's single trimming report.
- **Scope the scan to R1.** R2 and R3 are fenced code written by hive, and `K1`
  records the false positive that makes this non-optional: a fenced block whose
  body contains a bare `{{{` reads as a marker and swallows the rest of the
  region. Deterministic, and the same disposition as §4.2's fence stripper —
  total, not lossless.
- **Do not read `'foldmarker'`.** The verification script does, because it runs
  in a window it controls. Hive should not: the option is window-local, an
  ftplugin or the user may change it, and the text reader by design runs when
  there is no window to read it from. Fix hive's own literal — or a
  `session.exclude_marker` config pair — so the answer never depends on which
  window happens to be current.

#### 17.2.4 What this collides with

1. **[R§8.10], directly.** Excluded lines are a silent cap unless they are
   reported. §8.3.6 already emits one `Util.info` per submit with token counts;
   the excluded section and token count go on the same line. This is not
   optional — it is the only thing standing between "I parked that" and "why did
   the model ignore my plan".
2. **§8.3.6 step 4 needs re-reading, not necessarily rewriting.** If exclusion
   lands, R1 arrives at the trimmer already pruned and the top-dropping rule may
   simply stop firing. That is the good case and it should be measured rather
   than assumed. §17.1.6 (2) proposes a different fix to the same rule, and the
   two have to be reconciled before either ships.
3. **§17.1's `<!-- hive:plan -->` delimiters share R1 with these.** They compose
   — a seeded plan block can itself be marked — but the ordering has to be fixed:
   exclusion runs first, then §17.1.6 (2)'s trim ordering operates on what
   survives. Two comment conventions in one region is one more than ideal; if
   both ship, consider whether the plan delimiter should simply *be* a marker
   pair.
4. **I5, marginally.** The marker lines are bytes the *user* wrote, so nothing
   about attribution actually changes — but §17.1.6 (4) is already opening I5's
   wording for R1, and this should be settled in the same edit rather than
   noticed later.

#### 17.2.5 What would have to be measured

- **How much of a real R1 is junk?** This is the load-bearing unknown and it
  gates the rest. Instrument the ratio over a week of real use. If R1 rarely
  approaches 422 tokens, the reserve was never binding and §17.1.7's "cut
  `reserve.notes` and donate it to context" is the better move; if it routinely
  overruns, this is the cheapest token win in the plan.
- **Does exclusion hold the prefix cache across a working session?** §8.3.1
  predicts yes and `scripts/measure/prefill.lua`'s `cache` mode measures it
  directly. Worth ~0.6 s per submit at the current baseline (§17.2.2 (3)), which
  is why it is second on this list and not first.
- **Does anyone mark anything?** The gesture has to be as cheap as `zf` or it
  will not be used, and the fold habit is decades deep. A `:Hive park` over a
  visual selection that inserts the pair is the mitigation, and its adoption is
  the real test of the feature.

The risk is the mirror of §17.1.7's. There the danger is a confident, stable,
*wrong* input; here it is a confident, stable, *incomplete* one — the model
conditions just as hard on half a plan, and R1 is the one region with nothing to
falsify it against. That argues for the report in (1), for keeping the markers
visible rather than concealed, and for the exclusion always being something the
user did on purpose and can see they did. It is not an argument that it is safe.
