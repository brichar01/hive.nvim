# Build order — §15

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 15. Build order

Each step is independently testable and leaves the plugin working.

| # | Step | Done when |
| --- | --- | --- |
| 1 | §9.3 transport fixes + §9.4 empty-text validation + §9.6 remote options | `api_spec` covers empty text; a bad `base_url` errors instead of throwing; `remote_spec` passes; `:checkhealth` names the served models — **done** |
| 2 | §9.1 two profiles + `auto` probe; `M.infill` | `:Hive complete` still works; a FIM request round-trips against the local server |
| 3 | §3 session buffer + §4 region model + §4.4 repair | `:Hive open` creates the scaffold; `region_spec`'s six cases pass |
| 4 | §5 target tracking | `:Hive target` and the `WinLeave` capture both set a correct target |
| 5 | §6.2 the ladder + `whole` strategy | `:Hive refresh` fills R3 for *any* filetype with no parser and no tables — `whole_spec` passes. This is deliberately first in §6: it is the shortest path to a working refresh and it is language-agnostic. |
| 5b | §6.3–§6.6 unit extraction + §7.3 treesitter R2 | `extract_spec` passes, including the empty-body and export-wrapper cases |
| 5c | §6.8 import block | `imports_spec` passes; a >60-line file shows imports, an elision marker, then the slice |
| 6 | §8 prompt assembly + budget | `:Hive submit` fills the hole; trimming is reported; `num_ctx` is sent on `ollama_raw` and the §8.3.7 ceiling is refused on `openai` |
| 7 | §10.1–§10.3 provenance, accept, undo | `apply_spec` passes; five accepted words are five undos |
| 8 | §7.2 vendored queries + §7.1 LSP R2 | R2 ranks by free identifiers; `:checkhealth hive` reports the query supply |
| 8b | §7.4 consumers | `consumers_spec` passes; with a language server attached, editing an existing function shows its call sites in R2, and a freshly written one shows none without an error. Deliberately after 8: it shares §7.1's request plumbing, encoding conversion and timeout, and it is the first thing in R2 that reads a file hive did not already have. |
| 9 | §10.4 transplant | A rewrite lands as minimal hunks; one undo reverts it |
| 10 | §11 events + §12 commands + §13 health + `doc/hive.txt` | `make check` clean |

Steps 1–7 — 5b and 5c included — are the working product. 8 and 8b improve R2's
quality, 9 closes the loop back to the source, 10 is polish. Each step's
done-when implies its `:Hive` subcommand lands with that step; §12 in step 10 is
the final shape of the dispatch table, not the first appearance of the commands.

