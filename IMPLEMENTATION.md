# hive.nvim — implementation plan

Companion to `PLAN.md` (research). This document is the build order. It assumes
the findings in `PLAN.md` are true and does not re-derive them; where a step
depends on one, the section is cited inline as `[R§n]`.

Every claim about the local model server, the LSP server and Neovim's region /
extmark / undo behaviour in this document was measured on this machine on
2026-08-21 (NVIM v0.12.4, ollama 0.32.5, lua-language-server via mason).

> **Measurement baseline — and why the budget defaults are small.**
> All timings in this document were measured on **CPU-only inference**:
> Intel i7-1165G7 (Tiger Lake, 4C/8T), no discrete GPU, `qwen2.5-coder:3b`
> Q4_K_M. `/api/ps` reports `size_vram=0` — ollama does not offload to the
> Iris Xe iGPU, so every prompt token is prefilled on the CPU at **59–88
> tok/s** (§8.3.1). That single number, not model capability and not the
> retrieval literature, is what sets `budget.total_tokens` in §2.
>
> **These defaults are wrong for a machine with a GPU, and §8.3.4 has now been
> measured on one** — `llama-server` at `192.168.50.133:8181` serving
> `Qwen2.5-Coder-7B-Instruct` Q4_K_M on an RTX 2060 (6 GB), 2026-08-24. Prefill
> there is **1412–1496 tok/s**, ~20x this baseline, and flat rather than
> degrading; decode is **42.6–44.4 tok/s**, ~2.4x. Both improve, but by very
> different factors, and that asymmetry is the finding: prompt tokens get ~20x
> cheaper while completion tokens get ~2.4x cheaper, so the binding constraint
> moves from prefill to **decode** rather than to context quality. The measured
> tier is `total_tokens = 3072` with `fim.max_tokens = 256` — a ~8.0 s cold
> submit, of which 6.0 s is decode. Treat every number in §8.3.1 as hardware-local
> and every number in §8.3.4 as hardware-*and-configuration*-local.
>
> **§8.3.4 was published once with wrong figures**, taken from this server while
> it was not serving the model from the card: decode read as 11.4–14.3 tok/s and
> the section concluded that a GPU makes decode *worse*. It does not. The
> correction, and the three reasoning errors that let a measurement of a
> misconfiguration reach this file's headline, are at the end of §8.3.4; the
> practical residue is that a performance figure needs the system verified to be
> in the configuration you mean to describe before it is written down.

**This file is an index.** The plan lives in `notes/implementation/`, split by
topic. Section numbers (`§0`–`§16`) are unchanged, so every internal `§n`
cross-reference still resolves — use the section map below to find the file.

---

## Contents

### [1. What is being built, and the module layout](notes/implementation/01-overview.md) — §0–§1

The whole design in one page: a **session buffer** — one markdown file, three
regions, refreshed on demand. R1 is user-curated prose that hive never writes,
R2 is generated signatures and stubs for the symbols R3 refers to, R3 is
generated code around the target cursor with the FIM output spliced into a hole.
Then the invariants (§0.1) and the explicit non-goals for v1 (§0.2) — read these
before changing anything, they are what the rest of the plan is accountable to.
§1 lists the new modules alongside the existing seven, marking which existing
files get edited and where.

### [2. Configuration](notes/implementation/02-configuration.md) — §2

The replacement `defaults` table for `lua/hive/config.lua`, fully annotated, with
every field validated and validation failure reverting the whole table. Grouped
as transport (`base_url`, model choice and why 3b not 7b, connect timeout,
headers, credentials and TLS for an off-box server, transport profile `auto`),
FIM (sentinel dialect, decode cap, stop strings), prompt budget (every value
derived in §8.3 from the CPU baseline), and what goes in R3 (whole-file limits,
the import/include block, slice sizes). The inline comments carry the derivation
for each number and point at the section that would have to be re-run to change
it.

### [3. The session buffer, regions and target tracking](notes/implementation/03-session-buffer.md) — §3–§5

Why the session buffer is a **real file** and not a scratch buffer (R1 must
survive a restart, and nothing in Neovim persists extmarks [R§12.10]), the
buffer-local options set on open, why markdown, and the scaffold itself. §4 is
the region model, and its central measured decision: **no extmarks for region
boundaries** — a table of three candidate designs shows the boundary-extmark
approach is outright broken, and scanning for the header lines is the only one
that detects the unrecoverable case instead of corrupting it. Then `region.lua`'s
API, how R2 and R3 are written, and repair. §5 covers target tracking: when the
user is *in* the session buffer the cursor is not in any code, so the target must
be remembered rather than read.

### [4. Building R3 — the code region](notes/implementation/04-code-region.md) — §6

The largest section. `extract.lua` turns a `Hive.Target` into prefix lines,
suffix lines, a hole position, a language and a **strategy** (`whole` / `unit` /
`lines`) that is reported to the user — a silently-degraded slice is the main way
this component can be wrong without looking wrong. Covers explicit parsing, the
decision ladder that sends short files whole, finding the enclosing unit,
extending upward over attached doc comments, placing the hole, byte-exactness,
the tiered language support and why the tier must be visible, and the
import/include block prepended when the whole file did not fit.

### [5. Building R2 — the context region](notes/implementation/05-context-region.md) — §7

`discover.lua`: the target plus R3's slice in, stub lines out. The LSP path uses
a single `textDocument/documentSymbol` request — the best tokens-per-round-trip
of the options in [R§11.9], because `DocumentSymbol.detail` is a rendered
signature — and the measurement here closes a real gap: against
`lua-language-server` it works but is **far noisier** than the research implies.
Then free identifiers and the vendored queries (the consequence of [R§11.6.1]),
and the treesitter fallback path. §7.4 adds the inverse signal — **what calls the
target**, which for a FIM plugin fixes the arity and argument shapes the model
would otherwise guess. It is sourced from `textDocument/references` rather than
call hierarchy, because measurement found `lua_ls` does not implement
`prepareCallHierarchy` at all and `CallHierarchyItem.range` means something
different on each of the three servers that do.

### [6. Prompt assembly](notes/implementation/06-prompt-assembly.md) — §8

`prompt.lua`: three region bodies plus R3's split in, one string out. The FIM
sentinel sets per model family (§8.1), the layout (§8.2), and then §8.3 — the
budget, which is the analytical core of the document. It derives every number in
§2's `budget` table from the measured CPU prefill rate (§8.3.1), sets the region
reserves so the whole-file rung of §6.2 fits exactly (§8.3.3), gives the second,
**measured** tier for the remote GPU server, why decode rather than prefill binds
there, and the correction notice on that section's first published figures
(§8.3.4), the procedure for re-deriving all of it on other hardware
(§8.3.5), and the spend/trim/donate order — code → context → notes (§8.3.6).

### [7. Transport](notes/implementation/07-transport.md) — §9

Why `POST /v1/completions` **cannot** carry this design, measured against the
ollama actually running here: it templates the prompt, ignores `think`, and gates
`suffix` on the model, so the plan carries two profiles with an `auto` probe
(§9.1). Then the instruction not to "upgrade" the HTTP body transport, which
[R§9.3] already found to be the best of the five surveyed (§9.2); the four
transport fixes from [R§10] (§9.3); response validation, including the empty-text
case (§9.4); what changes if streaming is added later (§9.5); and §9.6 — what
`base_url`, TLS, credentials and the connect timeout have to do when the server
is not on this machine.

### [8. Applying the output](notes/implementation/08-applying-output.md) — §10

Splicing the returned text into R3 is a pure insertion at a known position, so
**`vim.text.diff` must not be used here** — [R§12.7] measured that a line-granular
diff of a region rewrite invalidates every provenance mark inside it, under all
four granularity strategies. Use `nvim_buf_set_text` over the marker's exact
range. Then partial accept, undo blocks (and the distinction between a refresh —
one break, many edits — and an accept), and transplanting R3 back to the source
buffer, which is the multi-hunk last-to-first loop of [R§4].

### [9. Events, scheduling and commands](notes/implementation/09-events-and-commands.md) — §11–§12

The per-buffer state machine, with the in-flight `vim.SystemObj` and the
monotonic generation counter that drops stale responses; the trigger set; debounce
per [R§5]; and refresh atomicity. §12 is the user-facing surface: the
`sub_cmds` table in `plugin/hive.lua` extended with `open`, `target`, `refresh`,
`submit`, `accept`, `transplant` and `cancel`, each keeping the existing
lazy-`require` discipline, one entry point per §1 module.

### [10. Health checks and tests](notes/implementation/10-health-and-tests.md) — §13–§14

The `:checkhealth hive` additions, each a distinct ok/warn/error: `curl`,
`base_url` reachability via §9.1's probe so it also reports the detected
transport, how the server is addressed (loopback vs remote, plaintext vs verified
TLS, credential reachable without appearing in argv), and — importantly — whether
the configured model can actually do FIM. §14 is the test plan: busted-style
specs through `tests/minit.lua`, matching the existing four spec files, and the
whole suite must run with **no server**. Includes the six `region_spec` cases
that exercise §4.1's measured boundary failure mode.

### [11. Build order](notes/implementation/11-build-order.md) — §15

The numbered sequence, each step independently testable and leaving the plugin
working, with an explicit "done when" per step. Step 1 (transport fixes,
empty-text validation, remote options) is marked **done**.

### [12. Gaps found while writing this](notes/implementation/12-gaps.md) — §16

The delta between research and plan, recorded because the review of `PLAN.md`
turned on it. §16.1 is what the research did not cover and had to be measured —
starting with the FIM protocol, where the research's "best of the five"
conclusion was true about the HTTP *body* and silently wrong about the
*endpoint*. §16.2 is what the research has that this plan must not lose. §16.3
is the findings the research carries that this design deliberately retires.

---

## Section map

| Section | File |
| --- | --- |
| §0 What is being built | [01-overview.md](notes/implementation/01-overview.md) |
| §1 Module layout | [01-overview.md](notes/implementation/01-overview.md) |
| §2 Configuration | [02-configuration.md](notes/implementation/02-configuration.md) |
| §3 The session buffer | [03-session-buffer.md](notes/implementation/03-session-buffer.md) |
| §4 The region model | [03-session-buffer.md](notes/implementation/03-session-buffer.md) |
| §5 Target tracking | [03-session-buffer.md](notes/implementation/03-session-buffer.md) |
| §6 Building R3 — the code region | [04-code-region.md](notes/implementation/04-code-region.md) |
| §7 Building R2 — the context region | [05-context-region.md](notes/implementation/05-context-region.md) |
| §8 Prompt assembly | [06-prompt-assembly.md](notes/implementation/06-prompt-assembly.md) |
| §9 Transport | [07-transport.md](notes/implementation/07-transport.md) |
| §10 Applying the output | [08-applying-output.md](notes/implementation/08-applying-output.md) |
| §11 Events and scheduling | [09-events-and-commands.md](notes/implementation/09-events-and-commands.md) |
| §12 Commands | [09-events-and-commands.md](notes/implementation/09-events-and-commands.md) |
| §13 Health checks | [10-health-and-tests.md](notes/implementation/10-health-and-tests.md) |
| §14 Tests | [10-health-and-tests.md](notes/implementation/10-health-and-tests.md) |
| §15 Build order | [11-build-order.md](notes/implementation/11-build-order.md) |
| §16 Gaps found while writing this | [12-gaps.md](notes/implementation/12-gaps.md) |
