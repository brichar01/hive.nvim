# hive.nvim — implementation plan

Companion to `PLAN.md` (research). This document is the build order. It assumes
the findings in `PLAN.md` are true and does not re-derive them; where a step
depends on one, the section is cited inline as `[R§n]`.

Every claim about the model server, the LSP server and Neovim's region / extmark
/ undo behaviour in this document was measured on this machine (NVIM v0.12.4,
`lua-language-server` via mason). **The model server is `llama-server`** — the
plan targets it and nothing else, and §9 is one endpoint on one profile because
of that.

> **Measurement baseline.** §8.3.1 is the configuration §2's defaults are derived
> from: `llama-server` build 10612 on `localhost:8080` serving
> `Qwen2.5-Coder-3B-Instruct` Q6_K on an **RTX 3050 Ti Mobile (4 GB)**, host an
> Intel i7-12700H, measured 2026-08-25. Prefill plateaus at **1858–1961 tok/s**
> and decode is **45.7–46.7 tok/s**, flat across the whole window. `total_tokens
> = 3072` with `fim.max_tokens = 256` is a ~7.1 s cold submit, **5.6 s of which
> is decode**. That last figure is what the budget is tuned against: prefill is
> cheap here and completion tokens are not.
>
> **§8.3.4 measures a second server and derives the same tier** — `llama-server`
> at `192.168.50.133:8181` serving `Qwen2.5-Coder-7B-Instruct` Q4_K_M on an RTX
> 2060 (6 GB), 2026-08-24. Prefill **1412–1496 tok/s**, decode **42.6–44.4**. A
> 7b on a 6 GB card across a LAN and a 3b on a 4 GB card on loopback ship the
> same `defaults` table, because both are held to 3072 by a 4096-token window and
> by the quality plateau rather than by speed.
>
> **Neither number is a property of hardware alone, and §8.3.8 is the section to
> read before recording one.** On this machine the ACPI power profile is worth
> **2.7x on decode**, and the stock `llama serve` defaults — `-ngl auto`, `--fit`
> on, four slots — leave a quarter of a Q8_0 3b in host memory on a 4 GB card and
> cost **2.1x to 3.9x**. Neither shows up in any field the server serves: the
> decode *step decomposition* is what exposes both, and its KV term is what names
> the fault.
>
> **§8.3.4 was published once with wrong figures**, taken from that server while
> it was not serving the model from the card: decode read as 11.4–14.3 tok/s and
> the section concluded that a GPU makes decode *worse*. It does not. The
> correction, and the three reasoning errors that let a measurement of a
> misconfiguration reach this file's headline, are at the end of §8.3.4. The
> practical residue is §8.3.8's rule: verify the system is in the configuration
> you mean to describe before writing a performance figure down.

**This file is an index.** The plan lives in `notes/implementation/`, split by
topic. Section numbers (`§0`–`§17`) are unchanged, so every internal `§n`
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
as transport (`base_url`, why `model` is a placeholder, connect timeout,
headers, credentials and TLS for an off-box server),
FIM (sentinel dialect, decode cap, stop strings), prompt budget (every value
derived in §8.3 from the §8.3.1 measurements), and what goes in R3 (whole-file limits,
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
budget, which is the analytical core of the document. §8.3.1 measures what a
prompt token and a decoded token actually cost on the server §2 is tuned for, and
why the two must be measured separately; §8.3.2 derives `total_tokens = 3072`
from four ceilings, of which the server's own window is the one with nothing to
do with the model; §8.3.3 sets the region reserves so the whole-file rung of §6.2
fits with room to spare. §8.3.4 measures a second server and lands on the same
tier, and carries the correction notice on its own first published figures.
§8.3.5 is the tokenizer and the field that must not be reconciled against;
§8.3.6 the spend/trim/donate order — code → context → notes; §8.3.7 the window
and the two ways to overrun it, only one of which is loud. **§8.3.8 is the one to
read before recording a figure from any server**: it shows the same card slow by
2.1x to 3.9x with every HTTP field looking healthy, and the decode step
decomposition as the only thing that says so.

### [7. Transport](notes/implementation/07-transport.md) — §9

One endpoint, `POST /v1/completions` on a `llama-server`, with no profile to
choose and no probe to run (§9.1). It carries the design because this server does
not template `prompt`: §8.2's hand-assembled FIM layout arrives at the model
exactly as written, which is what `suffix` and `/infill` cannot do, since neither
has anywhere to put R1 and R2 inside the FIM prefix. Then the instruction not to
"upgrade" the HTTP body transport, which [R§9.3] already found to be the best of
the five surveyed (§9.2); the four transport fixes from [R§10] (§9.3); response
validation (§9.4) — an empty completion is a failure, and a completion the
window truncated must not pass silently; what changes if streaming is added later
(§9.5); §9.6, what `base_url`, TLS, credentials and the connect timeout have to
do when the server is not on this machine; and §9.7, the probes §9.1 rests on,
including why `fim.stop` is load-bearing on one build and not another.

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

### [13. Extension ideas](notes/implementation/13-extension-ideas.md) — §17

Designs worth writing down before they are worth building. **Nothing here is
measured or in §15's build order**, and each idea carries its own list of what
would have to be measured first. §17.1 is per-file plans generated from a prose
plan file: a structured file of one record per source file — role if new, change
if it exists — seeding R1 for the matching target. Recorded because the sense
check turned up more than the idea itself: it is really the specification R1 has
never had, §1's module layout table is the same artifact hand-written and so
doubles as the generator's acceptance test, and it collides with six things in
the plan as it stands — I1's write rule, §8.3.6's top-first R1 trim, §3.1's slug,
I5, staleness, and §0.2.

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
| §17 Extension ideas | [13-extension-ideas.md](notes/implementation/13-extension-ideas.md) |
