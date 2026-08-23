# Prompt assembly — §8

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 8. Prompt assembly

`prompt.lua`. Input: the three region bodies plus R3's split. Output: one string.

### 8.1 FIM dialects

The sentinel set is per model family. Defaults:

```lua
local DIALECTS = {
  qwen = {
    prefix = "<|fim_prefix|>", suffix = "<|fim_suffix|>", middle = "<|fim_middle|>",
    file_sep = "<|file_sep|>", repo_name = "<|repo_name|>",
    stop = { "<|fim_pad|>", "<|endoftext|>", "<|file_sep|>", "<|repo_name|>" },
  },
  -- StarCoder1 and 2 share the FIM triplet but not the metadata tokens
  starcoder  = { prefix = "<fim_prefix>", suffix = "<fim_suffix>", middle = "<fim_middle>",
                 file_sep = "<filename>", repo_name = "<reponame>",
                 stop = { "<|endoftext|>" } },
  starcoder2 = { prefix = "<fim_prefix>", suffix = "<fim_suffix>", middle = "<fim_middle>",
                 file_sep = "<file_sep>", repo_name = "<repo_name>",
                 stop = { "<|endoftext|>", "<file_sep>" } },
  -- FIM exists only in the 7B/13B CodeLlama variants, and the canonical
  -- layout carries meta-spaces: "<PRE> {prefix} <SUF>{suffix} <MID>"
  codellama = { prefix = "<PRE>", suffix = "<SUF>", middle = "<MID>",
                stop = { "<EOT>" } },
  deepseek  = { prefix = "<｜fim▁begin｜>", suffix = "<｜fim▁hole｜>", middle = "<｜fim▁end｜>",
                -- instruct EOS and base EOS; FIM generation emits the latter
                stop = { "<|EOT|>", "<｜end▁of▁sentence｜>" } },
}
```

A user may supply a table with the same keys for an unlisted model.

### 8.2 Layout

Qwen's repo-level convention is the natural fit, because R2 genuinely is "other
files' signatures":

```
<|repo_name|>{repo}
<|file_sep|>hive-notes.md
{R1 body}
<|file_sep|>{context filename}
{R2 body}
<|file_sep|>{target relative path}
<|fim_prefix|>{R3 prefix}<|fim_suffix|>{R3 suffix}<|fim_middle|>
```

Verified end to end against the local server: 32 prompt tokens for a minimal
version of exactly this structure, generation terminating on the dialect stop
tokens. For dialects with no `file_sep`, R1 and R2 are folded into the FIM prefix
as comment blocks in the target language instead.

Putting prose in a FIM prefix is unusual. It is the design intent — R1 is the
motivation the model should condition on — and it is why the prompt is assembled
by hand rather than delegated to a server-side `suffix` parameter (§9.2).

### 8.3 Budget

Two different numbers are in play and conflating them is the failure mode this
section exists to prevent:

- **`budget.total_tokens`** — hive's own ceiling on `prompt + completion`. This
  is the one derived below, and it is set by **latency**, not by model capability.
- **`num_ctx`** — the server-side KV window. Exceed it and ollama does not
  error; it truncates *from the head* and answers anyway. §8.3.7.

#### 8.3.1 What a prompt token costs

Measured 2026-08-23 on the baseline at the top of this document — CPU-only,
`qwen2.5-coder:3b` Q4_K_M, `/api/generate` with `raw: true`, `num_predict: 1`.

**Every run used a unique leading marker.** A first attempt made each prompt a
byte-prefix of the next, and llama.cpp's KV prefix cache made the longer runs
report ~3x faster than they were. Any re-measurement must defeat that cache the
same way, or it will measure the cache.

| prompt tokens | prefill | tok/s |
| --- | --- | --- |
| 220 | 2.4 s | 88.3 |
| 425 | 5.0 s | 84.9 |
| 820 | 10.7 s | 76.0 |
| 1629 | 24.4 s | 66.5 |
| 3288 | 55.5 s | 59.2 |

Throughput **degrades with length** — 88 tok/s at 220 tokens, 59 at 3288 — so
cost is superlinear in the budget, not linear. Decode is **18.5 tok/s**, which is
what makes `fim.max_tokens` expensive in its own right: 256 tokens is a 13.8 s
worst case, 128 is 6.9 s.

**Prefix caching is worth ~6x, and it is directional:**

| request | tokens | prefill |
| --- | --- | --- |
| cold | 1486 | 20.0 s |
| +196 tokens appended to the cached prefix | 1682 | **3.3 s** |
| same content, one edit *at the front* | 1689 | 25.5 s |

§8.2's layout already puts R1 and R2 ahead of R3 in the FIM prefix, so a submit
that changed only the code around the hole re-prefills only the tail. This is the
largest single lever in the design and it is currently unguarded: **if R1/R2
rendering is not byte-stable across submits, every submit pays the cold price.**
Anything that varies per-submit — a timestamp, a reordered symbol list, a
re-wrapped comment — must not be emitted above R3.

**7b on this baseline is not viable.** `qwen2.5-coder:7b` is 7.62B parameters to
the 3b's 3.09B; CPU prefill is compute-bound, so it runs ~2.5x slower — roughly
24–36 tok/s prefill and ~7.5 tok/s decode. Even a 512-token prompt would cost
~19 s. **This is extrapolated from the parameter ratio, not measured** — the 7b
model is not installed on this machine. Hence `model` defaults to `3b` in §2.

#### 8.3.2 Deriving `total_tokens`

Three ceilings apply. The lowest wins.

| Ceiling | Value | Source |
| --- | --- | --- |
| Model capability — in-distribution FIM | ~8192 | Qwen2.5-Coder trains file-level FIM at 8192 and extends to 32768 only for repo-level FIM. Effective context on RULER-style evaluation runs ~50–65% of the advertised 32768, i.e. ~16–21K — far above anything relevant here. |
| Diminishing, then negative, returns | ~2000–4000 | Repository-level completion studies agree that added context plateaus and then hurts: top-5 retrieved chunks outscore top-20 (0.66 vs 0.61); retrieval helps ~20% of instances and *harms* another ~20%; hierarchical pruning from 50K to ~8K tokens **improves** accuracy. |
| **Latency on the §8.3.1 baseline** | **~1100** | ~15 s of cold prefill. |

Latency binds, by about 4x. `total_tokens = 1024` with `fim.max_tokens = 128`
leaves an **896-token prompt ceiling**:

- cold prefill 896 @ ~75 tok/s ≈ **12 s**; worst-case decode 6.9 s → ~19 s
- warm re-submit (stable R1/R2) ≈ **4 s**, which is the loop that matters

Set `total_tokens = 768` if 19 s worst-case is too slow; do not go below the
512 floor in §2's validation table.

Note what this fixes. The previous default of 4096 was **simultaneously too
large to prefill and too large to bind**: 3840 prompt tokens cost ~66 s against a
60 s `timeout`, while the R1/R2/R3 defaults together requested only ~1400 tokens
— so the trimming ladder below never fired and the elaborate machinery in it was
dead code. At 1024 the ladder is load-bearing.

#### 8.3.3 Deriving `reserve`

The split is anchored on §6.2's existing corpus result rather than chosen. At
`total_tokens - fim.max_tokens` = 896:

| region | share | tokens | what that buys |
| --- | --- | --- | --- |
| `code` | **0.55** | 493 | §6.2's 60-line whole-file rung is 462 tokens — it fits, and 80 lines does not. This is the constraint that sets the ratio. |
| `context` | **0.30** | 269 | a filtered stub line costs ~15 tokens → ~17 stubs, hence `max_symbols = 16` |
| `notes` | **0.15** | 134 | ~100 words of prose — a task statement, not an essay |

The same ratios hold at the §8.3.4 GPU budget (code 2112, context 1152, notes
576), so one split serves both tiers.

This replaces `{ notes = 0.25, context = 0.35, code = 0.40 }`, which was
underived and gave freeform user prose a quarter of the window — 1024 tokens at
the old budget, ~750 words — for the region the ladder below ranks last to spend
and first to trim.

**Consequences for the R3 knobs.** With `reserve.code` = 493, the non-whole-file
path must fit slice *plus* import block inside it. At ~7.7 tokens/line: the old
40+20 slice is 462 tokens and the old 40-line import block is 308, totalling 770.
That overflows, and worse, 308 exceeds half the reserve, so the rule below would
**drop the import block on essentially every non-whole-file submit** — silently
making `imports.enabled` a no-op. Retuned to 28+12 lines (308) plus a 20-line
import block (154) = 462, which fits with slack.

#### 8.3.4 The GPU tier — and the obligation to re-measure

**Everything above is hardware-local and wrong for a machine with a dedicated
GPU.** Discrete-GPU prefill for a 7B Q4 model runs in the ~1000–3000 tok/s range,
one to two orders of magnitude above the 59–88 tok/s measured here. That moves
the binding ceiling in §8.3.2 from latency back to context quality, and the
correct defaults change accordingly:

| | CPU baseline (§8.3.1) | Dedicated GPU |
| --- | --- | --- |
| `model` | `qwen2.5-coder:3b` | `qwen2.5-coder:7b` |
| `budget.total_tokens` | 1024 | 4096 |
| `fim.max_tokens` | 128 | 256 |
| `budget.reserve` | 0.55 / 0.30 / 0.15 | unchanged |
| `code.whole_file.max_bytes` | 1920 | 8192 |
| `code.imports.max_lines` | 20 | 40 |
| `code.lines_before` / `lines_after` | 28 / 12 | 40 / 20 |
| `context.max_symbols` | 16 | 40 |
| expected cold submit | ~19 s | ~2–4 s |

4096 rather than 8192 for the GPU tier: the second ceiling in §8.3.2 becomes the
binding one there, and hive's R2 is *ranked* stubs, so extra budget buys
lower-ranked, noisier symbols — exactly the top-20-beats-top-5 failure. 8192 is
the ceiling to raise toward only if R2 grows to span multiple files.

**These GPU figures are estimates from published throughput ranges, not
measurements.** Before adopting them, re-run §8.3.1 on the target machine:

1. Warm the model, then send prompts of ~200/400/800/1600/3200 tokens through
   `/api/generate` with `raw: true`, `num_predict: 1`, and a **unique leading
   marker per request** to defeat the prefix cache.
2. Read `prompt_eval_count` and `prompt_eval_duration` from each response.
3. Pick the largest prompt ceiling whose cold prefill stays inside the latency
   target, then add `fim.max_tokens` back to get `total_tokens`.
4. Re-derive `bytes_per_token` (§8.3.5) on the target machine's corpus, and
   re-check §6.2's table against the new `reserve.code`.

#### 8.3.5 Estimating token counts, and reconciling

There is **no tokenizer endpoint**. Measured: `/api/tokenize` is 404, `/api/embed`
is 501 and `/api/embeddings` is 500 on this server. So the budget is estimated ex ante and
reconciled ex post:

- **Estimate:** `#bytes / budget.bytes_per_token`. Measured in raw mode over
  17.8 KB of this repo's Lua, bytes/token converges to **3.9** (3.63 at 800 bytes,
  3.89–3.92 from 3200 bytes up), which is the default.
- **Correction to an earlier figure.** This section previously claimed 3.61
  bytes/token from `lua/hive/curl.lua` at 4540 bytes → 1256 tokens. Re-measured
  through `/api/generate` with `raw: true`, the same file is **1180 tokens =
  3.85 bytes/token**; the missing 76 tokens were chat-template wrapper, so the
  original figure was taken through a templating path (§9.1) and over-counted by
  ~6.5%. The error was in the safe direction — it over-estimates the prompt — but
  it was not the raw figure it claimed to be.
- **Reconcile:** every response carries `prompt_eval_count` (native) or
  `usage.prompt_tokens` (OpenAI). After each request, update a rolling
  bytes-per-token for the session and use it for the next estimate. Log the
  discrepancy at DEBUG. This is what makes the ex-ante constant a starting point
  rather than a commitment, and it is why a mis-set default self-corrects after
  one submit.

#### 8.3.6 Allocation and trimming

Allocation, in order, against `budget.total_tokens` minus `fim.max_tokens`:

1. **R3 prefix nearest the hole is never trimmed.** It is the only region whose
   loss changes the answer rather than the quality.
2. R3 gets `reserve.code`. Within it, spend in this order and trim in reverse:
   the slice around the hole, then the import block (§6.8), then the far ends.
   Concretely — if the whole-file strategy (§6.2) was chosen, its byte guard has
   already bounded the payload to `whole_file.max_bytes`, so no trimming is
   needed; otherwise, if the import block alone would exceed half the code
   reserve, **drop it entirely rather than truncating it**, because the model
   reads a missing import as "that name is unavailable"; then, if the slice still
   exceeds the reserve, drop whole lines from the *far* end of the prefix and the
   far end of the suffix alternately, keeping the hole centred.
3. R2 gets `reserve.context`; if over, drop the lowest-ranked stubs whole. Never
   truncate a stub mid-line — a half signature is worse than no signature.
4. R1 gets `reserve.notes`; if over, drop from the *top*, keeping the most recent
   prose, and prepend `<!-- …trimmed… -->`.
5. Any region under its reserve donates the remainder to the next in this order:
   code → context → notes.

Trimming is reported once per submit via `Util.info` with the token counts, so
silently sending a truncated prompt is impossible. This is [R§8.10]'s "no silent
caps" rule.

#### 8.3.7 `num_ctx` — the server's window, and the silent truncation it causes

Staying inside `budget.total_tokens` is necessary but not sufficient. The server
has its own window, and **ollama defaults `num_ctx` to 4096 regardless of the
model's architectural maximum**. Send more and it does not reject the request: it
truncates the prompt **from the head** and returns HTTP 200 with a normal
`finish_reason`.

For hive that failure is maximally bad. §8.2 puts the FIM sentinel at the very
front of the prompt, so the first token discarded is `<|fim_prefix|>`. The model
receives a headless, sentinel-less blob, produces confident nonsense, and every
observable signal — status, `finish_reason`, token counts — looks healthy. It is
precisely the silent cap that [R§8.10] forbids, in the one place it is hardest to
diagnose.

The two transports differ in whether they can do anything about it:

- **`ollama_raw`** can. `options.num_ctx` is accepted per request on
  `/api/generate`. **hive must send it**, set to `budget.total_tokens`. This also
  right-sizes the KV allocation instead of reserving ollama's default.
- **`openai`** cannot. The OpenAI schema has no field for it and ollama drops
  unknown keys, so `/v1/completions` is stuck with whatever the server was
  started with (`OLLAMA_CONTEXT_LENGTH`, default 4096).

The effective window **is** discoverable, which is what makes this checkable
rather than merely documentable:

| endpoint | reports | use |
| --- | --- | --- |
| `GET /api/ps` | `context_length` of the **loaded** model — the live `num_ctx` | **this one.** Measured 8192 here after a request set it. |
| `POST /api/show` | `<arch>.context_length` — the model's architectural maximum | not this one. Reports 32768 for `qwen2.5-coder:3b` and would license a budget the server will truncate. |

So the rule, enforced at submit time on both transports:

> `budget.total_tokens` must be ≤ the `context_length` reported by `/api/ps` for
> the loaded model. On `ollama_raw`, send `num_ctx` to guarantee it. On `openai`,
> where it cannot be sent, **refuse the submit with an actionable error** naming
> `OLLAMA_CONTEXT_LENGTH` rather than sending a prompt that will be beheaded.

The default `total_tokens = 1024` is under ollama's 4096 default with room to
spare, so this cannot bite at the shipped settings — but it is exactly the trap a
user raising the budget to the §8.3.4 GPU tier would fall into, since 4096 total
against a 4096 window leaves nothing for the completion.

