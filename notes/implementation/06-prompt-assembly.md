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

**§7.4's consumers need no new layout.** A call site from another file genuinely
*is* another file, so each one renders as its own `<|file_sep|>{caller relative
path}` section inside the R2 body, in the sorted order §7.4 step 3 fixes. That is
the convention already in use above, it tells the model which file the example
comes from for free, and it keeps consumers inside `reserve.context` where §8.3.6
trims them. For dialects with no `file_sep`, they fold into the prefix as
comment blocks alongside the stubs, with the path as the comment's first line.

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

The same ratios hold at §8.3.4's measured remote tier (code 1549, context 845,
notes 422), so one split serves both tiers.

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

#### 8.3.4 The remote-server tier — measured

**Measured 2026-08-24 against a second machine**, `192.168.50.133:8181`, running
`llama-server` (llama.cpp, build `b10217`) with
`Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M` — 7.62B parameters, 4.68 GB on disk,
4.36 GiB of weights, `n_ctx_train` 131072 — on an **RTX 2060, 6 GB VRAM**, one
slot of 4096. This replaces the estimated tier that stood here. Method as in
§8.3.1: `/completion` with a raw `prompt`, `cache_prompt: false`, a unique
leading marker per request, median of three runs.

> **Read the correction note at the end of this section before citing any figure
> from it.** An earlier pass measured this same server while it was
> misconfigured, published decode numbers ~3x too slow, and drew a conclusion
> from them — "a GPU does not help decode" — that was an artifact of the
> configuration and not a fact about the hardware. The numbers below are from the
> server as it now runs.

**Prefill:**

| prompt tokens | prefill | tok/s |
| --- | --- | --- |
| 100 | 0.09 s | 1159 |
| 200 | 0.16 s | 1273 |
| 400 | 0.30 s | 1337 |
| 800 | 0.54 s | 1496 |
| 1600 | 1.09 s | 1469 |
| 2400 | 1.66 s | 1445 |
| 3200 | 2.25 s | 1426 |
| 3900 | 2.76 s | 1412 |

The estimate was "~1000–3000 tok/s"; the low end of that range is right.
Throughput **rises to a plateau and stays there** — 1159 tok/s at 100 tokens,
~1410–1500 from 800 up — so cost is essentially **linear** at ~0.7 ms/token above
800, where §8.3.1's CPU curve degraded 88 → 59 tok/s and made cost superlinear in
the budget. Below ~400 tokens fixed per-request overhead (~30 ms) dominates,
which is the only reason the short rows look slow.

**Decode improves too, but by far less than prefill — and that asymmetry is the
load-bearing result:**

| | CPU baseline, 3b (§8.3.1) | this server, 7b |
| --- | --- | --- |
| prefill | 59–88 tok/s | 1412–1496 tok/s — **~20x** |
| decode | 18.5 tok/s | 42.6–44.4 tok/s — **~2.4x** |

Decode, measured with `ignore_eos: true` so the full `n_predict` is generated, is
**44.0 tok/s** against a 200-token prompt and **42.6 at 3200**: it degrades
slightly with context, and the degradation is small enough to ignore when
budgeting. Run-to-run spread on the medians is ~1%.

The asymmetry is the thing to carry away. Prefill went ~20x and decode ~2.4x for
the same move, so **the two do not scale together and neither can be inferred
from the other**. Decode reads the whole weight set once per token and is
bandwidth-bound; prefill reads it once per batch of hundreds and is
compute-bound. Moving to a GPU raises compute far more than it raises bandwidth,
so prompt tokens get dramatically cheaper while completion tokens get only
moderately cheaper — which is why the binding constraint moves from prefill to
**decode** rather than to context quality, and why `fim.max_tokens` needs its own
measurement rather than a share of the prefill speedup.

##### Where the decode time goes

**Decompose the decode step.** Step time is linear in context, so measuring it at
six context lengths separates the context-*independent* cost (the weight read,
paid once per token) from the context-*dependent* one (the KV read, which grows
with history). Contexts 20 / 200 / 800 / 1600 / 2400 / 3200, `n_predict: 64`,
`ignore_eos`, median of three:

> **`step = 22.56 ms + 0.312 ms per 1000 context tokens`** (r² = 0.985)

| term | measured | implied bandwidth | vs. the card |
| --- | --- | --- | --- |
| intercept — weight read | 22.56 ms | **207 GB/s** | 62% of the 2060's 336 GB/s |
| slope — KV read | 0.312 ms / 1000 ctx | **184 GB/s** | 55% of spec |

Both terms land at **VRAM speeds**, at the 55–62% of spec bandwidth that a
memory-bound kernel actually achieves. That is what a fully resident model looks
like from the client, and it is the check worth running on any new server: an
intercept implying 10–70 GB/s means the working set is *not* on the card, however
healthy the aggregate tok/s looks.

Note the gap between achieved and spec: a first pass predicted ~70 tok/s for this
model on this card by dividing weight size into the 336 GB/s spec figure. The
measurement is 44. **Spec bandwidth over-predicts by ~1.6x**; use ~60% of spec
when sizing a decode budget from a datasheet.

**Concurrency.** The server now runs one slot, so concurrent submits queue rather
than batch: per-stream rate is unchanged at 44.1 tok/s and aggregate throughput
is flat at 32.6 / 37.7 / 37.5 tok/s for 1 / 2 / 4 streams. Nothing in hive fires
concurrent submits today and nothing should start. (An earlier measurement at
`--parallel 4` also showed no useful batching, but it was taken under the
misconfiguration described below and is not worth citing.)

**A fourth ceiling, and it binds.** §8.3.2's three ceilings are joined by the
server's own window, which here is **4096 tokens per slot** — `/props` →
`default_generation_settings.n_ctx`, `/v1/models` → `meta.n_ctx` and every entry
in `/slots` all report 4096. §8.3.7's rule applies unchanged; the number is 4096,
not the model's 131072.

| Ceiling | Value | Status here |
| --- | --- | --- |
| Model capability — file-level FIM | ~8192 | not binding |
| Diminishing, then negative, returns | ~2000–4000 | **binds** |
| Latency | ~4000 prompt tokens is 2.8 s, inside a 15 s target | not binding — decode sets the floor |
| Server window (`n_ctx` per slot) | **4096** for prompt + completion | **binds** |

Quality and the window agree, so `total_tokens = 3072` with `fim.max_tokens = 256`:

- prompt ceiling 2816 → cold prefill **2.0 s**
- worst-case decode 256 tokens ≈ **6.0 s** → cold submit ≈ **8.0 s**
- warm re-submit with stable R1/R2 and ~200 new tail tokens → prefill **0.15 s**,
  so a warm submit is decode and essentially nothing else
- 3072 against a 4096 window leaves 1024 of slack, which is what keeps §8.3.7's
  trap from firing

Not 4096: a 3840-token prompt plus 256 predicted fills the window exactly, and
this server does not forgive an overrun (§8.3.7).

**The tier:**

| | CPU baseline (§8.3.1) | this server, measured |
| --- | --- | --- |
| `model` | `qwen2.5-coder:3b` | `qwen2.5-coder:7b` — the served model |
| `budget.total_tokens` | 1024 | **3072** — estimate said 4096 |
| `budget.bytes_per_token` | 3.9 | **4.07**, exact via `/tokenize` (§8.3.5) |
| `fim.max_tokens` | 128 | **256** — 6.0 s of decode, which the 15 s target affords |
| `budget.reserve` | 0.55 / 0.30 / 0.15 | unchanged → code 1549, context 845, notes 422 |
| `code.whole_file.max_bytes` | 1920 | **6144** — 1549 tok × 4.07 B/tok = 6300, rounded down |
| `code.whole_file.max_lines` | 60 | 150 is affordable (4500 B, 1106 tok, 71% of reserve) — a context-quality choice now, not a budget one |
| `code.imports.max_lines` | 20 | **40** — 296 tokens, far under §8.3.6's half-reserve drop rule |
| `code.lines_before` / `lines_after` | 28 / 12 | **40 / 20** — 444 tok; with the import block, 740 of 1549, so 52% headroom remains |
| `context.max_symbols` | 16 | **40** — 600 tok of 845 |
| `context.consumers.max` | 3 | **6** — with 40 stubs that is 780 of 845, a tight fit but inside |
| expected cold submit | ~19 s | **~8.0 s** — estimate said ~2–4 s |

The reserves are shares of `total_tokens - fim.max_tokens` = 2816, so raising
`fim.max_tokens` to 256 costs each region ~4% against the 128-token variant. That
is the trade this tier makes deliberately: a completion that can finish a small
function beats 70 more tokens of context.

The estimate was directionally right about prefill and about the shape of the
budget, and wrong about the magnitudes on both sides of it. Note what did *not*
change: §8.3.3's reserve ratios hold, and §6.2's whole-file ladder fits at every
rung.

**Reproducing this**, here or on any other server — the procedure the estimate
asked for, with the traps now named:

1. Warm the model, then send prompts of ~200/400/800/1600/3200 tokens with a
   **unique leading marker per request** *and* `cache_prompt: false`. Both, not
   either: the marker defeats a prefix match, `cache_prompt: false` defeats the
   slot's retained KV. Getting this wrong is worth 6x on the CPU baseline and
   ~15x here.
2. Read `timings.prompt_n` / `timings.prompt_ms` (llama.cpp) or
   `prompt_eval_count` / `prompt_eval_duration` (ollama).
3. **Measure decode separately, with `ignore_eos: true`, at a short *and* a long
   prompt.** Do not assume it scales with prefill — here it improved 8x less, and
   it is what sets `fim.max_tokens`.
4. **Run the step decomposition and read the implied bandwidths** before trusting
   any of it. It is the only mode that says whether the model is where you think
   it is; see the correction below for what happens if you skip it.
5. Read the server's window (§8.3.7) before choosing `total_tokens`. It is the
   one ceiling that has nothing to do with the model.
6. Re-derive `bytes_per_token` (§8.3.5) — on llama.cpp exactly, via `/tokenize` —
   and re-check §6.2's table against the new `reserve.code`.

##### Correction: the first pass measured a misconfigured server

An earlier revision of this section reported decode at **11.4–14.3 tok/s** on
this machine — *slower* than the 3b on the laptop CPU — with the step decomposing
as `69.1 ms + 5.87 ms/1000 ctx`, i.e. a weight read at 68 GB/s and a KV read at
10 GB/s. Those were real measurements of a real server, and every one of them is
now superseded: the same harness against the same machine measures 22.56 ms and
0.312 ms/1000 ctx. The server had not been serving the model from the card. Once
it was reconfigured to do so, the weight read moved from 68 GB/s to 207 GB/s —
3.1x, which is the whole of the decode difference — and the KV read from 10 to
184 GB/s.

Three things went wrong, and each is worth more than the number it produced.

**A measurement of a broken system is a measurement of the breakage.** The decode
figures were reproducible, low-variance, and survived a server restart, and all
of that made them *more* convincing rather than more suspect. Reproducibility
establishes that you are measuring something stable; it says nothing about
whether that something is the system you meant to measure. The decomposition was
already saying the working set was in host memory — 68 GB/s is dual-channel DDR5
— and that reading was correct and was correctly written down. What did not
happen was treating it as a blocking defect rather than as a caveat.

**The conclusion outran the evidence, and it outran it in the direction of being
interesting.** "A GPU speeds up prefill 16x and makes decode *worse*" is a
genuinely surprising claim, and surprise is exactly when the bar should go up.
Instead it went into the headline of `IMPLEMENTATION.md`, into `fim.max_tokens`,
and into a config comment telling the reader not to raise that value. The true
finding underneath — prefill and decode scale differently, so measure both — is
less dramatic and was available from the same data.

**Numeric agreement is not evidence of mechanism.** The first pass inferred that
~15% of the weights (≈0.64 GiB) had been evicted from a 6 GB card by a 896 MiB KV
allocation, and the arithmetic matched the 672 MiB that `--parallel 1` frees to
within 5%. Restarting with `--parallel 1` changed the step time by less than a
millisecond. A model that predicts the number you already have is cheap; only
changing an input and watching the output move is evidence. That refutation was
performed and recorded correctly — the error was in what stood after it, which was
an open question presented as a shippable tier.

The practical rule that follows, and the reason step 4 above exists: **before
publishing a performance figure, verify the system is in the configuration you
intend to describe.** For a local inference server that is one decomposition run
and a bandwidth sanity check, and it costs about ninety seconds.

**Still unmeasured on this server.** The 3b is not served there, so the model
choice at this tier rests on the 7b being affordable rather than on a measured
3b-versus-7b comparison; and output *quality* is not a timing question and was
not assessed. FIM *capability* is confirmed: the raw `<|fim_prefix|>` /
`<|fim_suffix|>` / `<|fim_middle|>` dialect works on the instruct build, each
sentinel tokenizes to one special token (`<|fim_prefix|>` → 151659), and
llama.cpp's native `/infill` answers and stops at EOS. The instruct build does
*not* stop on its own in the raw path — it ran past `end` into the next function
— so §2's `fim.stop` strings are load-bearing there.


#### 8.3.5 Estimating token counts, and reconciling

**ollama has no tokenizer endpoint**. Measured: `/api/tokenize` is 404,
`/api/embed` is 501 and `/api/embeddings` is 500 on the local server. So against
ollama the budget is estimated ex ante and reconciled ex post:

- **Estimate:** `#bytes / budget.bytes_per_token`. Measured in raw mode over
  17.8 KB of this repo's Lua, bytes/token converges to **3.9** (3.63 at 800 bytes,
  3.89–3.92 from 3200 bytes up), which is the default.
- **`llama-server` does have one, and it is exact.** `POST /tokenize` (and
  `/detokenize`) answer 200 on the §8.3.4 server, so there the estimate is not an
  estimate. Measured 2026-08-24 over 34.3 KB of `lua/hive/*.lua`: 8448 tokens =
  **4.07 bytes/token**, converging from 4.55 at 800 bytes to 4.03–4.07 from 6.4 KB
  up. Per file it ranges 3.87 (`curl.lua`) to 4.83 (`types.lua`), so the spread
  within one language is ~25% — an argument for the rolling correction below, not
  against the constant. Note the tokenizer is the *same* for the 3b and the 7b
  (vocab 152064), so 3.9-versus-4.07 is a real ~4% disagreement between the exact
  count and the ollama-derived one, not a model difference. It is in the safe
  direction: 3.9 over-estimates the token count.
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
  discrepancy at DEBUG.
- **Which field, though — the prefix cache poisons the obvious one.** Measured
  2026-08-24 on `llama-server`, a 1373-token prompt whose first 1200 tokens were
  already cached reports `timings.prompt_n = 173`: that field counts tokens
  *actually prefilled*, not tokens in the prompt. Feeding it to a rolling
  bytes-per-token would drive the constant toward infinity over a warm session —
  exactly the loop §8.2's cache-friendly layout is designed to produce. The
  cache-immune fields, same request: `tokens_evaluated = 1373` on the native path
  and `usage.prompt_tokens = 1373` (with `usage.prompt_tokens_details.cached_tokens
  = 1200`) on the OpenAI path. **Reconcile against those two, never against
  `timings.prompt_n`.** ollama's `prompt_eval_count` behaves like `prompt_n`, so
  the same care applies there. This is what makes the ex-ante constant a starting point
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
3. R2 gets `reserve.context`. If over, trim in this order: the lowest-ranked
   stubs down to half of `max_symbols`, then §7.4's consumers from the last, then
   the remaining stubs. Consumers survive the first pass because a real call site
   outweighs the twelfth-ranked signature, and not the last because a signature
   the target *calls* still outweighs a second example of it being *called*.
   Never truncate a stub or a consumer snippet mid-line — a half signature is
   worse than no signature, and half a call site is worse than none.
4. R1 gets `reserve.notes`; if over, drop from the *top*, keeping the most recent
   prose, and prepend `<!-- …trimmed… -->`.
5. Any region under its reserve donates the remainder to the next in this order:
   code → context → notes.

Trimming is reported once per submit via `Util.info` with the token counts, so
silently sending a truncated prompt is impossible. This is [R§8.10]'s "no silent
caps" rule.

#### 8.3.7 The server's window — silent truncation on ollama, a hard 400 on llama.cpp

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

**`llama-server` behaves differently, and better.** Measured 2026-08-24 on the
§8.3.4 server, a 4778-token prompt against a 4096-token slot returns **HTTP 400**:

```json
{"error":{"code":400,"type":"exceed_context_size_error",
          "message":"request (4778 tokens) exceeds the available context size (4096 tokens), try increasing it",
          "n_prompt_tokens":4778,"n_ctx":4096}}
```

Both numbers, in a typed error, before any tokens are generated. So the trap in
this section is **ollama-specific**: llama.cpp fails loudly and hands hive
everything needed to report the problem. Two further differences that matter:

- **The window is discoverable on the OpenAI path**, which it is not on ollama.
  `/v1/models` reports `data[].meta.n_ctx` and `/props` reports
  `default_generation_settings.n_ctx`; both said 4096, and every entry in `/slots`
  agreed. This removes the reason `openai` had to refuse blind.
- **The window is per *slot*, not per server.** The number to check is
  `default_generation_settings.n_ctx`, which is `--ctx-size` divided by
  `--parallel`; a user who raised `--ctx-size` and also raised `--parallel` gains
  nothing. This server has been seen at `total_slots: 4` and at `total_slots: 1`
  and reported a 4096 window both times, so `total_slots` alone tells you
  nothing — read the per-slot `n_ctx`.
- `n_ctx_train` is 131072 and `/props` will happily tell you so. That is the
  §8.3.4 `/api/show` mistake in llama.cpp clothing: it is the architectural
  maximum, not the window.

So the rule, enforced at submit time on both transports:

> `budget.total_tokens` must be ≤ the window the server reports for the loaded
> model — `/api/ps` → `context_length` on ollama, `/props` →
> `default_generation_settings.n_ctx` (or `/v1/models` → `meta.n_ctx`) on
> llama.cpp — and **not** `/api/show` or `n_ctx_train`. On `ollama_raw`, send
> `num_ctx` to guarantee it. Where it cannot be sent and cannot be read, **refuse
> the submit with an actionable error** naming `OLLAMA_CONTEXT_LENGTH` rather than
> sending a prompt that will be beheaded. Against `llama-server` on the `openai`
> profile the window *can* be read, so the check is a real check rather than a
> refusal.

The default `total_tokens = 1024` is under ollama's 4096 default with room to
spare, so this cannot bite at the shipped settings — but it is exactly the trap a
user raising the budget would fall into, and it is why §8.3.4's measured tier
lands on 3072 rather than the 4096 the estimate proposed: 4096 total against a
4096 window leaves nothing for the completion.
