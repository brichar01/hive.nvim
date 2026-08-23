# Health checks and tests — §13–§14

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 13. Health checks

Extend `lua/hive/health.lua`. Each is a distinct `health.ok`/`warn`/`error`:

1. `curl` executable — existing.
2. `base_url` reachable — existing, but switch to the probe of §9.1 so it also
   reports the detected transport.
2b. **How the server is addressed.** Whether `base_url` is loopback or remote;
   for a remote one, whether the connection is plaintext or verified TLS, and
   whether a credential is configured and reachable without the argv (§9.6).
   Plaintext to a remote host is a `warn`, not an `error` — on a trusted segment
   it is the right call given the per-request handshake cost, and the check says
   what is at stake rather than insisting.
2c. **The configured model is actually served.** Compare `Config.model` against
   the ids in `GET /v1/models` and `health.error` with the available list when it
   is absent. `model` defaults to a placeholder and every server names its models
   differently, so this drifts precisely when the server moves (§9.6). Without it
   the symptom is an HTTP 400 at submit time.
3. **Thinking-model trap.** Send a 16-token completion through the configured
   transport. If `text == ""` and the token count is non-zero, `health.error`
   with the §9.4 hint. This is the check that turns a mystifying silence into a
   one-line diagnosis.
4. **FIM support.** Send a minimal FIM prompt for the configured dialect and
   report whether the response is non-empty. Also probe `suffix` and report
   `"does not support insert"` as information, not an error — it tells the user
   their model has no FIM template.
5. **Query supply.** For the target filetype, report
   `vim.treesitter.query.get(vim.treesitter.language.get_lang(ft), "locals") ~= nil`
   (§4.3's mapping — the raw filetype misses `typescriptreact` and friends) and
   whether it resolved to hive's vendored copy. `nil` for a non-vendored language is a `warn`, not an
   error — R2 degrades to proximity ranking (§7.2).
5b. **Language tier.** Report the §6.7 tier for the target filetype and *why*:
   which of `DECL_TYPES`, `PRELUDE`, `locals.scm` and a parser are present. This
   is the check that stops a user concluding hive is broken when it is in fact
   correctly running at Tier 3 for Clojure.
6. **Parser.** `vim.treesitter.get_parser` for the target filetype; `warn` if
   absent, since R3 falls back to line windows (§6.2's ladder). Report it as
   `info` rather than `warn` when the target is within `whole_file` limits, since
   no parser is needed in that case.
6b. **Strategy dry-run.** For the current target, report which rung of §6.2's
   ladder would be taken and why — `whole (48 lines / 1.4 KB, within limits)`,
   or `unit (file is 210 lines)`, or `lines (no DECL_TYPES entry for clojure)`.
   Together with 5b this is the one output that explains R3's contents without
   the user reading any source.
7. **LSP.** Whether any attached client supports `documentSymbol`, and its
   `offset_encoding`.
7b. **Consumers (§7.4).** Whether an attached client supports
   `textDocument/references`, and separately whether it advertises
   `callHierarchyProvider`. Absent `references` is a `warn` — R2 loses consumers
   and keeps its stubs. Absent call hierarchy is `info`, not a warning: it is the
   measured state on `lua_ls`, hive does not use it, and reporting it as a
   problem would send users hunting for a server that fixes nothing.
8. **Effective context window.** `GET /api/ps` for the loaded model and compare
   its `context_length` against `budget.total_tokens` (§8.3.7). `health.error` if
   the budget exceeds it, naming `num_ctx` on `ollama_raw` and
   `OLLAMA_CONTEXT_LENGTH` on `openai`. Do **not** read `/api/show` for this — it
   reports the architectural maximum, not the loaded window. Report the two side
   by side, since the gap between them (8192 loaded vs 32768 architectural here)
   is the thing users misread. **`/api/ps` is ollama-only**: against a remote
   `llama-server` or vLLM this check cannot run, and §8.3.7's silent
   head-truncation becomes undetectable. Report it as `info` naming the
   server-side flag (`--ctx-size`, `--max-model-len`) rather than silently
   skipping — see §9.6's open gap.
9. **Prefill cost.** Report the measured prefill rate from the last submit
   (`prompt_eval_count / prompt_eval_duration`) alongside `budget.total_tokens`,
   as `~896 prompt tokens ≈ 12 s at 75 tok/s`. On the §8.3.1 CPU baseline this is
   the number that explains a slow submit, and on a new machine it is the first
   input to re-deriving the budget per §8.3.4.

---

## 14. Tests

Busted-style `describe`/`it` specs through `tests/minit.lua` (lazy.nvim's
`lazy.minit`), matching the existing four spec files' structure. The suite must run
with no server — the existing `api_spec.lua` already skips the one live test when
nothing answers, and that pattern extends.

| File | Covers | Notes |
| --- | --- | --- |
| `tests/region_spec.lua` | `locate`/`read`/`write`/`repair` | The regression tests that matter: R2 grows, R2 shrinks, user edits R1, user deletes across a boundary, duplicated header, empty buffer. The first four exercise §4.1's measured boundary failure mode; duplicated header and empty buffer are §4.2/§4.4's repair conditions. |
| `tests/extract_spec.lua` | §6 | Fixtures per language, skipping (not failing) when a parser is absent. Must include: the lambda trap (cursor inside a callback ⇒ the walk finds the *named* declaration); the Python docstring case; **the empty-body case in Lua** (`function M.f()` + `end` with the cursor between — asserts `strategy == "unit"`, which fails if the walk is conditioned on `field("body")`, §6.3); `export function` and `export const … =>` in TypeScript (asserts the doc comment is captured, §6.3/§6.4); and a decorated Python `def` (asserts the decorators are captured). |
| `tests/whole_spec.lua` | §6.2 | The ladder. A 59-line file ⇒ `whole`; a 61-line file ⇒ `unit`; a 10-line file of 500-char lines ⇒ **not** `whole`, because `max_bytes` binds; a file with no parser and 30 lines ⇒ `whole`; a file with no parser and 300 lines ⇒ `lines`. Also asserts `whole` never emits an import block or an elision marker. |
| `tests/imports_spec.lua` | §6.8 | Strategy A per language; the `export_statement`-with-`source` discriminator (re-export in, `export function` out); `preproc_include`'s `end_col == 0` slice not swallowing the next line; strategy B's prologue boundary landing before an **empty-bodied** Lua function rather than after it; the elision marker suppressed when nothing is elided. |
| `tests/discover_spec.lua` | §7 | Synthetic `documentSymbol` payloads, including the noisy lua_ls shape from §7.1, asserting the filter drops `Package`/`String` and body-less `Variable`s while keeping a callable `Variable` (tsgo's arrow-const, §7.1). No live LSP. |
| `tests/consumers_spec.lua` | §7.4 | Synthetic `references` payloads, no live LSP — the four-server divergence is measured by `scripts/measure/consumers.lua`, not asserted here. Must cover: a result inside R3's own slice is dropped (the recursive-call case); an import line is dropped; a call whose arguments wrap is widened past its start line, both via a parser and via the bracket-balance fallback; a result in a **loaded, modified** buffer is read from the buffer and not from disk; and — the one that guards §8.3.1 — two runs over the same results shuffled render byte-identically, because §7.4 step 3 sorts by `(uri, line, character)`. Zero consumers renders as nothing, never as an error. |
| `tests/prompt_spec.lua` | §8 | Dialect rendering byte-for-byte; budget trimming order; assert the hole is never trimmed. Assert `reserve` sums to 1.0 and that `code.whole_file.max_bytes`, the 28+12 slice and the 20-line import block all fit inside `reserve.code` at the default budget (§8.3.3) — these are the couplings that silently rot when one default is tuned alone. Assert R1/R2 rendering is byte-identical across two submits with unchanged inputs, since §8.3.1's 6x prefix-cache win depends on it. |
| `tests/apply_spec.lua` | §10 | Provenance gravity at both boundaries; `overlap = true`; `invalidate` on deletion and restoration on undo; **one undo per accept**; reverse-sorted hunk application. |
| `tests/api_spec.lua` (edit) | §9.4 | Add: empty `text` with non-zero `completion_tokens` returns an error, not success. Whitespace-only text is still a success — the check is `== ""`, not `vim.trim(...) == ""`. |
| `tests/remote_spec.lua` | §9.6 | `connect_timeout` reaches the argv as seconds and is absent when unset; a blackholed host (TEST-NET `203.0.113.1`) returns well inside `timeout`; `cacert`/`insecure` reach curl; an unreadable `cacert` is rejected at `setup()`; the token resolves config-over-env, accepts a function, and — where curl supports `--expand-header` — **appears nowhere in `build_args`' output**, which is the assertion the whole indirection exists for. |

Child-process isolation matters here: several of these assert on `undolevels`
manipulation and buffer-local state, which leaks between tests otherwise.

