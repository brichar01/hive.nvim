# Gaps found while writing this — §16

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 16. Gaps found while writing this

Recorded because the review of `PLAN.md` turned on them.

### 16.1 What the research did not cover, and had to be measured

1. **The FIM protocol.** `PLAN.md` had nothing on how a fill-in-the-middle
   request is expressed. The research's conclusion that hive's
   `/v1/completions` transport was "the best of the five" was a finding about
   *the HTTP body* and said nothing about *the endpoint*, which is where every
   FIM decision actually lives: whether the prompt is templated, whether the
   sentinels survive tokenization, and what stops a generation. §9.1 and §9.7
   measure all three.
2. **The empty-completion trap.** A server can return HTTP 200,
   `finish_reason = "length"`, non-zero `completion_tokens`, and `text = ""`.
   Nothing in the research anticipated a successful-looking empty response, and
   `parse_completion` accepts it today.
3. **Token accounting, and the cost of a token.** The research costed context in
   *tokens* and never in *seconds*. §8.3.1 measures the latter for the first
   time, and the result reorders the whole budget: prefill is nearly free and
   **decode is 5.6 s of a 7.1 s cold submit**, so `fim.max_tokens` is the
   expensive knob and `total_tokens` is not. That is what invalidated the
   original 4096 default, and it is not visible from a token count.
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
9. **The server's window is a second ceiling the research never costed.**
   §8.3.7. The research costed the prompt against hive's own budget and never
   against the window the server enforces. Measured 2026-08-25, `llama-server`
   refuses an over-long prompt with a typed HTTP 400 carrying both
   `n_prompt_tokens` and `n_ctx`, and exposes the window on `/props`, so the
   check is enforceable rather than merely documentable. The residual hazard is
   the *other* overrun: a prompt that fits with a completion that does not
   returns HTTP 200 and a `stop_type` no different from a normal cap, which is
   why §9.4 compares the token counts.
10. **A latency budget that folds prefill and decode into one number cannot be
    tuned.** The first budget in this plan assumed one factor covers both, so
    raising `fim.max_tokens` looked free. The two move together in direction but
    not in magnitude, because they are bound by different resources: decode reads
    the whole weight set **once per token** and is bandwidth-bound, while prefill
    reads it once per **batch of hundreds** and is compute-bound. §8.3.1 and
    §8.3.4 measure both separately on two different servers, and on both of them
    decode is what makes a submit slow: 5.6 s of a 7.1 s cold submit here, 6.0 s
    of 8.0 s there. `fim.max_tokens = 256` rests on that measurement, not on an
    inference from the prefill figure.

    **What is still unmeasured** is the third resource the same mistake hides:
    §8.3.8 shows a server whose aggregate tok/s looked healthy while a quarter of
    the weights sat in host memory, and only the decode *step decomposition*
    exposed it. Any new server needs that run before its numbers are recorded.

    The corollary is a measurement rule: an aggregate tok/s figure diagnoses
    nothing. Decode step time is *linear in context*, so fitting it across context
    lengths splits the context-independent weight read from the context-dependent
    KV read, and reading each as a bandwidth says whether the model is where you
    think it is. `scripts/measure/prefill.lua decompose` is that fit. Related: a
    datasheet bandwidth figure over-predicts decode by ~1.6x, so size from ~60% of
    spec.

11. **A published performance figure was wrong, and the process that produced it
    is the gap.** §8.3.4 was written up once from measurements taken while the
    remote server was not serving the model from its GPU. Decode read 11.4–14.3
    tok/s against the true 42.6–44.4, and the section concluded — in this file, in
    `IMPLEMENTATION.md`'s headline, and in a config comment warning the reader off
    `fim.max_tokens = 256` — that a GPU makes decode *worse* than a laptop CPU.
    The figures were real; the system they described was not the one anyone
    intended to describe. Three failures compounded:

    - **Reproducibility was read as validity.** The bad numbers were stable to
      three significant figures across two server restarts, and that stability
      raised confidence in them. It should not have: it established only that the
      misconfiguration was stable. Reproducibility says you are measuring
      *something* consistently, never that it is the right something.
    - **The surprising conclusion got a lower bar rather than a higher one.** "A
      GPU makes decode slower" contradicts how the hardware works, and that was
      the moment to stop and check the configuration rather than to write it up as
      a finding. Surprise is evidence of a broken assumption *somewhere*, and the
      measurement apparatus is a likelier place than the physics.
    - **Numeric agreement was taken for mechanism.** It was inferred that ~15% of
      the weights (≈0.64 GiB) had been evicted from a 6 GB card by a 896 MiB KV
      allocation — an inference whose arithmetic matched the 672 MiB that
      `--parallel 1` frees to within 5%. The server was restarted with
      `--parallel 1` and the step time did not move by a millisecond. The
      agreement was coincidence. Only changing an input and watching the output
      move is evidence for a mechanism.

    What partly saved it: the decomposition was run, and it correctly reported the
    weights being read at 68 GB/s — host-memory speed on a 336 GB/s card. The
    diagnosis was *present in the document* and was written up as an open question
    alongside a tier presented as shippable. The rule that follows is that this
    combination is not allowed: a measurement whose own diagnostics say the system
    is misconfigured is not a caveat on a result, it is a blocker on publishing
    one. §8.3.4 carries the correction note; §8.3.4's reproduction procedure now
    has "run the decomposition and read the implied bandwidths" as a numbered step
    before any figure is recorded.

12. **Call hierarchy, and what a "consumer" costs.** [R§11.9] listed
    `callHierarchy/incomingCalls` as the strongest cross-file signal and priced
    it at two requests. Measured 2026-08-23, the price is not the problem:
    `lua_ls` does not implement the method at all (`-32601`), and
    `CallHierarchyItem.range` means the caller's whole body on tsgo and the
    caller's bare name on pyright and clangd, so it cannot slice the caller
    anywhere portably. §7.4 is the new section that follows —
    `textDocument/references` instead, one request, all four servers — and it is
    the first thing in R2 that has to read a file hive did not already have open.

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
- `lua_ls` answers `-32601` to `prepareCallHierarchy`, and `from.range` is the
  caller's whole body on one server and its bare name on two others. (§7.4)
- Both `references` and `incomingCalls` see a caller that exists only in a
  modified, unwritten buffer — but only if that buffer is open and attached to
  the same client. (§7.4)
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
