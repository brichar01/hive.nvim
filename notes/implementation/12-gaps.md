# Gaps found while writing this — §16

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 16. Gaps found while writing this

Recorded because the review of `PLAN.md` turned on them.

### 16.1 What the research did not cover, and had to be measured

1. **The FIM protocol.** `PLAN.md` had nothing on how a fill-in-the-middle request
   is expressed. Measured in §9.1: on this machine, `/v1/completions` templates
   the prompt, ignores `think`, and gates `suffix` on the model — so the research's
   conclusion that hive's `/v1/completions` transport was "the best of the five"
   was true about *the HTTP body* and silently wrong about *the endpoint*.
2. **The empty-completion trap.** A thinking model returns HTTP 200,
   `finish_reason = "length"`, non-zero `completion_tokens`, and `text = ""`.
   Nothing in the research anticipated a successful-looking empty response, and
   `parse_completion` accepts it today.
3. **Token accounting, and the cost of a token.** No tokenizer endpoint exists on
   this server, so §8.3.5's bytes/token had to be measured — and re-measured: the
   original 3.61 was taken through a templating path and the raw figure is 3.9.
   Much more importantly, the research costed context in *tokens* and never in
   *seconds*. §8.3.1 measures the latter for the first time: 59–88 tok/s prefill
   on CPU, which is what actually sets the budget and which invalidated the
   original 4096 default outright.
4. **Region boundaries.** §4.1's failure — two boundary extmarks collapsing when
   the region between them is replaced — is a new result. `PLAN.md` §12 covered
   extmarks over *text*, never as *structural* delimiters.
5. **`documentSymbol` noise.** [R§11.9] recommended it on tokens-per-round-trip
   grounds without noting that lua_ls returns every local, every table element and
   every `if`/`for` block. §7.1's filter is a hard requirement, not a refinement.
6. **Target tracking.** The research never considered that the cursor might be in
   a buffer that is not the code — the whole of §5 is new.
7. **Markdown as the region substrate.** [R§11.4] measured injections as a
   *hazard* to be handled. §3.3 turns the same mechanism into the feature that
   gives R2/R3 correct highlighting and a real parse tree.
8. **The prefix cache is a design constraint, not an optimisation.** §8.3.1
   measures a 6x gap between a warm and a cold submit, decided entirely by whether
   the bytes above R3 changed. Nothing in the research or in the first draft of
   this plan treated R1/R2 stability as load-bearing, and nothing currently
   enforces it.
9. **`num_ctx` is a second ceiling with no error path.** §8.3.7. The research
   costed the prompt against hive's own budget and never against the server's
   window; ollama's 4096 default truncates from the head, which removes the FIM
   sentinel and returns HTTP 200.
10. **The measurements are laptop-CPU measurements.** Every latency figure in
    §8.3.1 comes from a machine with no discrete GPU (`size_vram=0`). The defaults
    that follow from them are correct here and wrong on a GPU box; §8.3.4 gives
    the alternate tier and the procedure to re-derive it. This is the one section
    of this plan that is expected to be re-run rather than trusted.

### 16.2 What the research had that this plan must not lose

Each of these is a finding that would cost real debugging time to rediscover, and
each is cited at its point of use above rather than left in a general appendix:

- The nine-line doc-comment block above `M.request` is **outside** the
  `function_declaration` node, and the blank-line guard is what stops the walk
  running away. (§6.4)
- `node:type():find("function")` finds lambdas. (§6.3)
- `get_node()` on an unparsed tree is documented to return a wrong node. (§6.1)
- `locals.scm` is unreachable for Lua on this machine, for three independent
  reasons. (§7.2)
- `(identifier) @local.reference` matches field names; 7 of 8 free references in
  `M.request` are fields of `vim`. (§7.2)
- Default extmark gravity is correct for provenance and the intuitive choice is
  not. (§10.1)
- `overlap = true` or provenance queries fail everywhere except the first byte.
  (§10.1)
- A reload re-points extmarks instead of invalidating them. (§10.1)
- Only `let &undolevels=&undolevels` separates undo blocks. (§10.3)
- No diff granularity preserves a mark inside a rewritten hunk; re-stamp instead.
  (§10.4)
- `--data-binary @-` on stdin is already the best available body transport; do
  not switch to a temp file, and do not add `--retry`. (§9.2)
- `vim.system` throws, and an unguarded throw in a coroutine is a silent hang.
  (§9.3)
- `text = true` is ignored when `stdout` is a function. (§9.5)

### 16.3 Findings the research carries that this design retires

- **`vim.lsp.inline_completion` is not the substrate.** [R§11.11] advised checking
  it before building a context builder, on the grounds that fronting the model as
  a language server would let core handle sync, rendering, staleness and
  cancellation. That is sound advice for a ghost-text completion plugin and wrong
  for this one: the workbench's whole value is the *hand-assembled* three-region
  prompt, which no `textDocument/inlineCompletion` request can express. Core's
  module is still the reference for the `on_accept` seam (§10.2) and for what an
  accept path looks like, and nothing more.
- **Incremental sync, framing, long-lived peers.** [R§3, §5] and the shape-2
  material describe keeping a model process alive with length-prefixed or NDJSON
  framing. v1 is one-shot HTTP per request; none of it applies until hive hosts a
  process, which is not on this roadmap.
- **Streaming and partial-result rendering.** [R§9.4–§9.6] is deferred wholesale
  to §9.5.
- **Fuzzy diff repair.** [R§9.8]'s five-tier match ladder and `fix_diff` exist
  because a model is asked to emit a diff. Hive asks for *code*, in a FIM hole,
  and computes the diff itself — so the entire problem class is designed out.
