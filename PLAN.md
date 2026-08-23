# Research notes for `hive.nvim`

Companion to `IMPLEMENTATION.md`. That document is the build order; this one is
the set of verified facts it rests on. Sections are cited from there as `[R§n]`.

**This is a distilled document.** An earlier version surveyed how Neovim core and
ten third-party plugins move buffer text to external processes, in full. Once the
plugin's design was fixed — a three-region workbench buffer, one-shot HTTP per
request, FIM into a hole — most of that survey stopped being load-bearing. What
remains here is what `IMPLEMENTATION.md` actually cites: the mechanisms it uses,
and the traps that cost real debugging time if rediscovered. Retired sections are
kept as one-line stubs so the numbering and every cross-reference still resolve,
with a note on why they went. The full survey is recoverable from git history.

**This file is an index.** The notes live in `notes/research/`, split by topic.
Section numbers (`§1`–`§12`) are unchanged, so every `[R§n]` citation from
`IMPLEMENTATION.md` still resolves — use the section map below to find the file.

## Provenance of these facts

Measured on this machine, 2026-08-21: NVIM v0.12.4, `$VIMRUNTIME` =
`/usr/share/nvim/runtime`, 31 plugins under `~/.local/share/nvim/lazy/`, ollama
0.32.5 on `:11434`, `lua-language-server` via mason. Core and third-party line
numbers were re-resolved against disk on that date.

Two caveats about scope:

- `copilot.lua`, `supermaven-nvim`, `codecompanion.nvim` and `avante.nvim` are
  **not installed here**. §9's line numbers are from upstream sources as read,
  not re-resolved, and are less firm than everything else. The one §9 claim that
  *was* verified locally is §9.3's, because it turns on plenary and plenary is
  installed.
- `nvim-treesitter` is installed but **archived upstream and never `setup()`-ed**;
  `tree-sitter-manager.nvim` is the live query supply. §11.6.1 is the consequence
  and it is the most implementation-relevant finding in §11.

---

## Contents

### [1. Buffer I/O and subprocesses](notes/research/01-buffer-io.md) — §1–§7

How bytes leave a buffer, reach a process, and come back. `lsp._buf_get_full_text`
is the correct extraction idiom and why (`fileformat` separator, `endofline`,
BOM); why a line *table* must never be passed as `stdin`. The sharp edges of
`vim.system` — it **throws** on a bad binary or `cwd`, and an unguarded throw
inside a coroutine is a silent hang; writes are fire-and-forget; `text = true` is
ignored when `stdout` is a function; `on_exit` runs in a fast context; `:wait()`
is not interruptible. What `apply_text_edits` gets right (last-to-first ordering,
mark save/restore, CRLF normalization). The one debounce decision worth copying
from `_changetracking`: compute the change immediately, delay only the send.
Includes the retired stubs §3 (framed peers), §6 (treesitter never spawns) and
§7 (core's subprocess inventory).

### [2. Plugin precedents, and the transport gaps](notes/research/02-plugin-precedents.md) — §8–§10

What to copy from other plugins, and the resulting fix list for `hive.curl`.
conform.nvim's `runner.lua` is the reference buffer→CLI implementation
(`pcall`-wrapped spawn, `changedtick` staleness guard, error taxonomy);
gitsigns.nvim contributes the architecture and the only BOM-aware extraction
found anywhere; cancellation needs a `:kill()` **and** a generation counter,
belt-and-braces. Then §9, the four AI plugins whose whole job is shipping buffer
text to a model — copilot.lua's undo *break* and its live utf-16 bug, why hive's
HTTP body transport already beats all five, streaming caveats for later, virtual
text for partial output and real text on completion, and the finding that nobody
handles `fileformat`/`endofline`/BOM. §10 lists the four concrete gaps in
`hive.curl` today, each traceable to a precedent above.

### [3. Selecting which bytes to send](notes/research/03-byte-selection.md) — §11

The largest section, and the one `IMPLEMENTATION.md` §6 and §7 are built on.
Three layers — treesitter, LSP, plain lines — and what each provably *cannot*
answer, including the fact that **LSP has no synchronous mode**. Treesitter as
the boundary layer: the node walk to the enclosing unit and the lambda trap,
import/include sections, doc comments as *siblings* rather than children,
injected languages as a hazard that became a feature, and parse cost measured
rather than assumed (~3 ms cold, ~0.5 ms parse). Query supply, and §11.6.1's
correction — the queries are **not** on the runtime path here, which is the most
implementation-relevant finding in the whole section. `folds.scm` as a free
language-agnostic chunker, `locals.scm` as the discovery trigger, what LSP adds
and what it costs, and the `on_accept` seam in `vim.lsp.inline_completion`.

### [4. Provenance and partial accept](notes/research/04-provenance.md) — §12

Which bytes came from the model, and how to accept — or partially accept — text
without lying about either. **No reference implementation exists**: none of the
ten plugins surveyed tracks generated text after it lands, so everything here was
derived from primitives and measured. Core's `inline_completion` is the seam and
carries no provenance. Extmarks are the primitive, the *default* gravity is the
one you want, `invalidate = true` plus the default `undo_restore`, and
`overlap = true` is not optional. The traps: a reload silently re-points marks at
unrelated text; provenance does not survive a rewrite and must be re-derived.
The durable model is to store the base and recompute the diff. Partial accept
means slicing the suggestion and breaking undo every time.

### [5. Verification](notes/research/05-verification.md)

Copy-pasteable snippets that reproduce every load-bearing claim above — line
endings, the node walk, injections, parse cost, query supply, the `overlap` trap,
the undo break, the reload trap — plus the shell one-liners for the machine facts
themselves. Reading confirmation and measurement only; nothing here modifies the
plugin.

---

## Section map

| Section | File |
| --- | --- |
| §1 Getting text out of a buffer | [01-buffer-io.md](notes/research/01-buffer-io.md) |
| §2 Sending it — `vim.system()` | [01-buffer-io.md](notes/research/01-buffer-io.md) |
| §3 Long-lived framed peers — *retired* | [01-buffer-io.md](notes/research/01-buffer-io.md) |
| §4 Applying results back to a buffer | [01-buffer-io.md](notes/research/01-buffer-io.md) |
| §5 Debounce discipline | [01-buffer-io.md](notes/research/01-buffer-io.md) |
| §6 Treesitter never touches a subprocess — *retired* | [01-buffer-io.md](notes/research/01-buffer-io.md) |
| §7 Core's subprocess inventory — *retired* | [01-buffer-io.md](notes/research/01-buffer-io.md) |
| §8 Third-party plugins: what to copy | [02-plugin-precedents.md](notes/research/02-plugin-precedents.md) |
| §9 The AI plugins: the findings that survive | [02-plugin-precedents.md](notes/research/02-plugin-precedents.md) |
| §10 The transport gaps in `hive.curl` today | [02-plugin-precedents.md](notes/research/02-plugin-precedents.md) |
| §11 Selecting which bytes to send | [03-byte-selection.md](notes/research/03-byte-selection.md) |
| §12 Provenance and partial accept | [04-provenance.md](notes/research/04-provenance.md) |
| Verification | [05-verification.md](notes/research/05-verification.md) |
