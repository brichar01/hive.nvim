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
  is the one derived below.
- **the server's window** — `n_ctx` per slot, which `llama-server` both reports
  and enforces. Exceed it and the request is refused with a typed error rather
  than answered from a truncated prompt. §8.3.7.

#### 8.3.1 What a prompt token costs

**Measured 2026-08-25 on this machine**, against `llama-server` on
`localhost:8080` serving `Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q6_K` (3.40B
parameters, 2.60 GiB on disk, `n_ctx_train` 32768) on an **RTX 3050 Ti Mobile,
4 GB VRAM**, started as:

```
llama serve -hf Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q6_K --port 8080 \
            -ngl all -c 4096 --parallel 1
```

llama.cpp version `0.2.0-dev`, build 10612, commit `758443071`. Method:
`/completion` with a raw `prompt`, `cache_prompt: false`, `n_predict: 1`, median
of three. This is the configuration §2's defaults are derived from, and
§8.3.8 is what has to be checked before trusting any figure taken from a
different one.

**Every run used a unique leading marker, *and* `cache_prompt: false`.** Both,
not either: the marker defeats a prefix match and the flag defeats the slot's
retained KV. An early measurement made each prompt a byte prefix of the next and
reported ~3x faster than the truth, because it measured the cache.

**Prefill:**

| prompt tokens | prefill | tok/s |
| --- | --- | --- |
| 100 | 0.06 s | 1583 |
| 200 | 0.11 s | 1747 |
| 400 | 0.22 s | 1800 |
| 800 | 0.41 s | 1948 |
| 1600 | 0.82 s | 1961 |
| 2400 | 1.25 s | 1919 |
| 3200 | 1.69 s | 1898 |
| 3900 | 2.10 s | 1858 |

Throughput **rises to a plateau and stays there** — ~1860-1960 tok/s from 800
tokens up — so cost is linear at ~0.53 ms/token across the range that matters.
Below ~400 tokens a fixed per-request overhead of ~30 ms dominates, which is the
only reason the short rows look slow. Prefill does not bind anything in this
document.

**Decode is 46.7 tok/s at 200 tokens of context and 45.7 at 3200**, a 2%
degradation across the whole window, measured with `ignore_eos: true` so the full
`n_predict` is generated. Run-to-run spread is 0.4%. **Decode is what
`fim.max_tokens` costs**, and it does not follow from the prefill figure: the two
are bound by different limits, prefill by compute and decode by memory bandwidth,
so each needs its own measurement on each server.

**The step decomposition, and the bandwidth check.** Decode step time is linear
in context, so measuring it at six context lengths separates the
context-*independent* cost (the weight read, paid once per token) from the
context-*dependent* one (the KV read, which grows with history). Contexts
20 / 200 / 800 / 1600 / 2400 / 3200, `n_predict: 64`, `ignore_eos`, median of
three:

> **`step = 21.244 ms + 0.266 ms per 1000 context tokens`** (r² = 0.936)

| term | measured | implied bandwidth | vs. the card |
| --- | --- | --- | --- |
| intercept, weight read | 21.244 ms | **131 GB/s** | 68% of the 3050 Ti's 192 GB/s |
| slope, KV read | 0.266 ms / 1000 ctx | **139 GB/s** | 72% of spec |

KV per token is 36,864 bytes: 36 blocks, 2 KV heads, head dimension 128, f16, K
and V. Both terms land at the 55-65% of spec bandwidth a memory-bound kernel
actually achieves, so the working set is on the card. **This is the check to run
on any server before recording a figure from it** (§8.3.8). Note the gap between
achieved and spec: sizing a decode budget by dividing weight size into a
datasheet figure over-predicts by ~1.5x, so use ~60% of spec.

The r² is lower than it looks it should be only because the slope is now small
enough that run-to-run noise is a visible share of it, which is itself the
result: at 0.266 ms per 1000 tokens, context costs decode almost nothing.

**Prefix caching is worth ~6x on a warm re-submit, and it is directional:**

| request | tokens | prefill |
| --- | --- | --- |
| cold | 1486 | 0.76 s |
| +196 tokens appended to the cached prefix | 1682 | **0.13 s** |
| same content, one edit *at the front* | 1688 | 0.87 s, full re-prefill |

§8.2's layout already puts R1 and R2 ahead of R3 in the FIM prefix, so a submit
that changed only the code around the hole re-prefills only the tail. It matters
less here than it would on a slower server, because 0.76 s of cold prefill is
already small against decode, but it costs nothing to keep: **if R1/R2 rendering
is not byte-stable across submits, every submit pays the cold price.** Anything
that varies per-submit — a timestamp, a reordered symbol list, a re-wrapped
comment — must not be emitted above R3.

#### 8.3.2 Deriving `total_tokens`

Four ceilings apply. The lowest wins.

| Ceiling | Value | Status here |
| --- | --- | --- |
| Model capability — in-distribution FIM | ~8192 | not binding. Qwen2.5-Coder trains file-level FIM at 8192 and extends to 32768 only for repo-level FIM. |
| Diminishing, then negative, returns | ~2000–4000 | **binds.** Repository-level completion studies agree that added context plateaus and then hurts: top-5 retrieved chunks outscore top-20 (0.66 vs 0.61); retrieval helps ~20% of instances and *harms* another ~20%; hierarchical pruning from 50K to ~8K tokens **improves** accuracy. |
| Latency | 2816 prompt tokens prefill in 1.48 s | not binding — decode sets the floor |
| Server window (`n_ctx` per slot) | **4096** for prompt + completion | **binds** |

Quality and the window agree, so **`total_tokens = 3072` with
`fim.max_tokens = 256`**, leaving a 2816-token prompt ceiling:

- cold prefill 2816 at ~1900 tok/s ≈ **1.5 s**
- worst-case decode 256 tokens at the 45.4 tok/s the step model predicts for that
  context ≈ **5.6 s**, so a cold submit is ~**7.1 s**
- warm re-submit with stable R1/R2 and a ~200-token tail → prefill **0.13 s**, so
  it is decode and essentially nothing else
- 3072 against a 4096 window leaves 1024 of slack, which is what keeps §8.3.7's
  trap from firing

**Not 4096.** A 3840-token prompt plus 256 predicted fills the window exactly,
and this server does not forgive an overrun (§8.3.7). Set `total_tokens` lower if
7 s is too slow, and spend the saving on `fim.max_tokens` first, since that is
where the seconds are. Do not go below the 512 floor in §2's validation table.

**Decode, not prefill, is the constraint.** 5.6 s of the 7.1 s cold submit is
decode, and the whole 2816-token prompt is 1.5 s of it. Raising `total_tokens`
buys context cheaply; raising `fim.max_tokens` costs 22 ms per token and is the
knob to measure before touching.

#### 8.3.3 Deriving `reserve`

The split is anchored on §6.2's existing corpus result rather than chosen. At
`total_tokens - fim.max_tokens` = 2816:

| region | share | tokens | what that buys |
| --- | --- | --- | --- |
| `code` | **0.55** | 1549 | 6304 bytes at §8.3.5's 4.07 B/tok. §6.2's 60-line whole-file rung is 462 tokens, so it fits with room to spare, and 150 lines (~1106 tokens) is affordable too — which makes the whole-file limit a context-quality choice rather than a budget one. |
| `context` | **0.30** | 845 | a filtered stub line costs ~15 tokens → ~56 stubs, so `max_symbols = 40` (600 tokens) leaves room for §7.4's consumers |
| `notes` | **0.15** | 422 | ~320 words of prose — a task statement, not an essay |

This replaces `{ notes = 0.25, context = 0.35, code = 0.40 }`, which was
underived and gave freeform user prose a quarter of the window for the region the
ladder below ranks last to spend and first to trim. The same ratios hold at
§8.3.4's remote tier, so one split serves both.

**Consequences for the R3 knobs.** With `reserve.code` = 1549, the
non-whole-file path must fit slice *plus* import block inside it. At ~7.7
tokens/line a 40+20 slice is 462 tokens and a 40-line import block is 308,
totalling 770 — half the reserve, with 50% headroom left. The import block also
stays well under §8.3.6's half-reserve drop rule (774), so `imports.enabled` is
not silently a no-op, which it would be at a tighter budget.

**Consequences for R2.** `max_symbols = 40` is 600 tokens of 845, leaving 245 for
consumers. At 10-30 tokens per widened call site, `consumers.max = 6` is 60-180
tokens: a tight fit but inside, and §8.3.6 trims consumers before the last stubs
if it is not.

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
800, the same shape as §8.3.1 at ~0.75x the rate on a model twice the size.
Below ~400 tokens fixed per-request overhead (~30 ms) dominates, which is the
only reason the short rows look slow.

**Decode**, measured with `ignore_eos: true` so the full `n_predict` is
generated, is **44.0 tok/s** against a 200-token prompt and **42.6 at 3200**: it
degrades slightly with context, and the degradation is small enough to ignore
when budgeting. Run-to-run spread on the medians is ~1%.

**Prefill and decode do not move together, and neither can be inferred from the
other.** This server is a 7b on a 6 GB card and §8.3.1's is a 3b on a 4 GB one,
yet prefill differs by 0.75x and decode by 0.94x — the model is twice the size
and decode barely moved, because the 2060 has 1.75x the bandwidth of the 3050 Ti
to pay for it. Decode reads the whole weight set once per token and is
bandwidth-bound; prefill reads it once per batch of hundreds and is
compute-bound. That is why `fim.max_tokens` needs its own measurement on every
server rather than a share of the prefill figure.

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

**The window binds here too, and for the same reason.** §8.3.2's fourth ceiling
is the server's own window, which on this machine is also **4096 tokens per
slot** — `/props` → `default_generation_settings.n_ctx`, `/v1/models` →
`meta.n_ctx` and every entry in `/slots` all report 4096. §8.3.7's rule applies
unchanged; the number is 4096, not the model's 131072.

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

| | §8.3.1, 3b | this server, 7b |
| --- | --- | --- |
| `model` | the served 3b | `qwen2.5-coder:7b` — the served model |
| `budget.total_tokens` | 3072 | **3072** — estimate said 4096 |
| `budget.bytes_per_token` | 4.07 | **4.07**, exact via `/tokenize` (§8.3.5) |
| `fim.max_tokens` | 256 | **256** — 6.0 s of decode, which the 15 s target affords |
| `budget.reserve` | 0.55 / 0.30 / 0.15 | unchanged → code 1549, context 845, notes 422 |
| every derived knob in §8.3.3 | as shipped | **unchanged** |
| expected cold submit | ~7.1 s | **~8.0 s** — estimate said ~2–4 s |

**The two configurations land on the same tier**, and not because the hardware is
alike. Both are held to 3072 by a 4096-token window and by the quality plateau,
neither by speed, so a 7b on a 6 GB card across a LAN and a 3b on a 4 GB card on
loopback ship the same `defaults` table. Raising `--ctx-size` is what would
separate them, and §8.3.2's quality ceiling is what says not to.

The estimate this section replaced was directionally right about prefill and
about the shape of the budget, and wrong about the magnitudes on both sides of
it. Note what did *not* change: §8.3.3's reserve ratios hold, and §6.2's
whole-file ladder fits at every rung.

**Reproducing this**, here or on any other server — the procedure the estimate
asked for, with the traps now named:

1. Warm the model, then send prompts of ~200/400/800/1600/3200 tokens with a
   **unique leading marker per request** *and* `cache_prompt: false`. Both, not
   either: the marker defeats a prefix match, `cache_prompt: false` defeats the
   slot's retained KV. Getting this wrong is worth ~15x here and ~6x on the
   §8.3.1 server.
2. Read `timings.prompt_n` and `timings.prompt_ms`.
3. **Measure decode separately, with `ignore_eos: true`, at a short *and* a long
   prompt.** Do not assume it scales with prefill — here it improved 8x less, and
   it is what sets `fim.max_tokens`.
4. **Run the step decomposition and read the implied bandwidths** before trusting
   any of it. It is the only mode that says whether the model is where you think
   it is; see the correction below for what happens if you skip it.
5. Read the server's window (§8.3.7) before choosing `total_tokens`. It is the
   one ceiling that has nothing to do with the model.
6. Re-derive `bytes_per_token` exactly, via `/tokenize` (§8.3.5), and re-check
   §6.2's table against the new `reserve.code`.

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


#### 8.3.5 Counting tokens, and reconciling

**`llama-server` has an exact tokenizer, so the budget is not an estimate.**
`POST /tokenize` and `/detokenize` answer 200, and the count they return is the
count the model will see.

- **Measured 2026-08-25** over 34.4 KB of `lua/hive/*.lua`: 8448 tokens =
  **4.067 bytes/token**, converging from 4.55 at 800 bytes to 4.03–4.07 from
  6.4 KB up. Per file it ranges 3.87 (`curl.lua`) to 4.83 (`types.lua`), so the
  spread within one language is ~25% — an argument for the rolling correction
  below, not against the constant. The same corpus gives the same figure on the
  §8.3.4 server, because the 3b and the 7b share a tokenizer.
- **`bytes_per_token` is still worth keeping**, because §6 has to decide *what to
  put in R3* before it has a string to tokenize, and a round trip per candidate
  slice is not affordable inside a debounce window. Use the constant to size the
  slice, then tokenize the assembled prompt once and trim against the exact count
  (§8.3.6).
- **Reconcile:** every response carries `usage.prompt_tokens`. After each request,
  update a rolling bytes-per-token for the session and use it for the next
  estimate. Log the discrepancy at DEBUG.
- **Which field, though — the prefix cache poisons the obvious one.** Measured
  2026-08-24, a 1373-token prompt whose first 1200 tokens were already cached
  reports `timings.prompt_n = 173`: that field counts tokens *actually
  prefilled*, not tokens in the prompt. Feeding it to a rolling bytes-per-token
  would drive the constant toward infinity over a warm session — exactly the loop
  §8.2's cache-friendly layout is designed to produce. The cache-immune fields,
  same request: `tokens_evaluated = 1373` on the native path and
  `usage.prompt_tokens = 1373` (with `usage.prompt_tokens_details.cached_tokens
  = 1200`) on the OpenAI path. **Reconcile against those two, never against
  `timings.prompt_n`.** This is what makes the ex-ante constant a starting point
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

#### 8.3.7 The server's window, and the two ways to overrun it

Staying inside `budget.total_tokens` is necessary but not sufficient. The server
has its own window, and it is **per slot** rather than per server:
`--ctx-size` divided by `--parallel`. A user who raised `--ctx-size` and also
raised `--parallel` gains nothing.

The window is discoverable on every path, which is what makes this a check rather
than a guess:

| endpoint | field | value here |
| --- | --- | --- |
| `GET /props` | `default_generation_settings.n_ctx` | **4096** — read this one |
| `GET /v1/models` | `data[].meta.n_ctx` | 4096, agrees |
| `GET /slots` | per-slot `n_ctx` | 4096, agrees |
| `GET /v1/models` | `data[].meta.n_ctx_train` | 32768 — the **architectural maximum**, not the window |

`n_ctx_train` is the trap in that table. It is what the model was trained to
handle, `llama-server` will happily report it, and using it to size a budget
licenses a prompt the server refuses.

**Overrunning it fails in two different ways, and only one of them is loud.**
Measured 2026-08-25 on build 10612 against the §8.3.1 server:

| request | outcome |
| --- | --- |
| prompt 4778, window 4096 | **HTTP 400** before any tokens are generated |
| prompt 4090 + `n_predict` 64, window 4096 | **HTTP 200**, `tokens_predicted = 6`, `stop_type = "limit"` |

The first is the good case, and it is the same typed error on the native path and
on `/v1/completions`:

```json
{"error":{"code":400,"type":"exceed_context_size_error",
          "message":"request (4778 tokens) exceeds the available context size (4096 tokens), try increasing it",
          "n_prompt_tokens":4778,"n_ctx":4096}}
```

Both numbers, in a typed error, before any work is done. hive can report that
verbatim and the user knows exactly what to change.

**The second case is the one to guard against.** When the prompt fits and the
completion does not, the server generates up to the window and stops. `stop_type`
is `"limit"`, which is the same value a legitimate `n_predict` cap produces, so
nothing in the response distinguishes a completion the caller asked to end from
one the window cut off. **Compare `tokens_predicted` against the requested
`n_predict`**: fewer, with `stop_type = "limit"`, means the window truncated it.
On the OpenAI path the equivalent is `usage.completion_tokens` against
`max_tokens` with `finish_reason = "length"`. Warn rather than fail — the text
returned is real and usable — but say so, because [R§8.10] forbids a silent cap.

So the rule, enforced at submit time:

> `budget.total_tokens` must be ≤ the window `/props` reports for the loaded
> model, and **not** `n_ctx_train`. Leave room for the completion inside it:
> `total_tokens` counts prompt *plus* completion, and filling the window exactly
> is what produces the silent case above.

§8.3.2's `total_tokens = 3072` against a 4096 window is what keeps both cases out
of reach, with 1024 tokens of slack. The trap is only reachable by a user who
raises the budget, which is why §13's check compares the two rather than trusting
the default.

#### 8.3.8 Verify the configuration before recording a figure

Every number in §8.3.1 is a property of a *configuration*, not of a card. Two
settings on this machine were each worth more than a hardware change, and neither
announces itself in any HTTP field the server serves.

**1. The stock `llama serve` defaults do not fit a 4 GB card.** Before §8.3.1's
run, this machine served `Q8_0` under those defaults: `-ngl auto`, `--fit` on
with a 1024 MiB per-device margin, `--parallel 4`. Q8_0 is 3.36 GiB and four
slots reserve four times the KV, so `--fit` left about a quarter of the weights
in host memory. Same card, same power state, same harness:

| | defaults, Q8_0, 4 slots | `-ngl all`, Q6_K, 1 slot |
| --- | --- | --- |
| prefill plateau | 1520-1590 tok/s | **1860-1960 tok/s** |
| decode @ 200 ctx | 22.0 tok/s | **46.7 tok/s** |
| decode @ 3200 ctx | 11.6 tok/s | **45.7 tok/s** |
| step | 42.79 ms + 14.07 ms/1000 | **21.24 ms + 0.266 ms/1000** |
| implied weight read | 84 GB/s, 44% of spec | 131 GB/s, 68% of spec |
| implied KV read | 2.6 GB/s, 1.4% of spec | 139 GB/s, 72% of spec |

Two variables moved at once, placement and quantisation, and the decomposition
separates them. **KV is f16 at both quantisations, so the 53x collapse in the
slope is placement alone.** The intercept moved 2.01x, of which 1.295x is the
smaller weight file, leaving ~1.55x for placement.

**The slope is the diagnostic to read.** A model split across the PCIe bus pays
for context at decode time, not only at prefill time, and that is what turned a
2% degradation across the window into a 47% one. An aggregate tok/s figure cannot
show it: 22 tok/s at short context looks like a working server. `/props`,
`/v1/models` and `/slots` report the same window either way, and nothing in the
API says a quarter of the model is in host memory.

The quantisation here is a fit decision rather than a quality preference. Q8_0 at
3.36 GiB does not leave room for KV and the compute buffer beside a display
server on a 4 GB card. Q6_K at 2.60 GiB does, with 2742 MiB resident of 4096.

**2. The ACPI power profile is worth as much as the card.** This is a laptop and
it sits in `low-power` by default. Measured on the Q8_0 configuration above,
moving to `performance` on AC took prefill from 983-1060 to 1520-1590 tok/s
(**1.5x**) and decode from 8.2 to 22.1 tok/s at 200 tokens of context (**2.7x**),
with the decode step intercept falling from 104.7 ms to 42.8 ms. §8.3.1 was
measured on AC in `performance`; the fitted Q6_K configuration has never been run
in `low-power`, so the shipped defaults assume a plugged-in laptop.

**The check, and it costs about ninety seconds.** Run the step decomposition and
read the two implied bandwidths *before* recording anything else from a new
server:

- both terms at 55-65% of the card's spec bandwidth ⇒ the working set is resident
- an intercept implying 10-70 GB/s ⇒ it is in host memory, whatever the aggregate
  tok/s looks like
- a slope two orders below either ⇒ attention is running on host-resident layers,
  and context will cost decode time as well as prefill time

§8.3.4's correction note is what happens when that step is skipped: a tier was
published from a server that was not serving its weights from the card, the
figures were stable to three significant figures across restarts, and
reproducibility was mistaken for validity. **Reproducibility establishes that you
are measuring something stable. It says nothing about whether that something is
the system you meant to measure.**

**One machine fact, corrected.** Earlier revisions of this document described the
host as an "Intel i7-1165G7 (Tiger Lake, 4C/8T), no discrete GPU" whose only
graphics was an Iris Xe iGPU. It is an **Intel i7-12700H, 14C/20T, with an RTX
3050 Ti Mobile**, and the Iris Xe is present alongside it rather than instead of
it. Nothing in this section's numbers depends on the old description, because
every one of them was re-measured on the machine as it actually is.
