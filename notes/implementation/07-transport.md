# Transport — §9

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 9. Transport

### 9.1 Two profiles, and why `/v1/completions` is not enough

The existing `hive.api` speaks `POST /v1/completions` with `{ model, prompt,
max_tokens, stream = false }`. Measured against the server actually running here
(ollama 0.32.5), that path **cannot carry this design**:

| Probe | Result |
| --- | --- |
| `/v1/completions`, plain | 200, but `text = ""` with `finish_reason = "length"` and `completion_tokens = 120` |
| where the tokens went | native `/api/generate` shows them in a `thinking` field; the compat layer maps only `response` |
| `"think": false` on `/v1/completions` | **silently ignored**, text still `""` |
| `"suffix"` on `/v1/completions` | HTTP 400 `"<model> does not support insert"` — model-gated |
| is `prompt` templated? | **yes.** `prompt = "x"` reports `prompt_tokens = 11`; ~10 tokens of chat wrapper |
| `/api/generate` + `raw: true`, `prompt = "x"` | `prompt_eval_count = 1` — genuinely raw |
| `/api/generate` + `raw: true` + `think: false` | `"def add(a, b):\n    return"` → `" a + b\n\nprint(…)"` |
| `/api/generate` + `raw: true` + hand-rolled FIM sentinels | works; 21 prompt tokens, stops on the stop token |
| `/api/generate` + `raw: true` + `suffix` | still 400, model-gated |

Three consequences, each of which would have cost a day to discover during
implementation:

1. **A thinking model returns an empty completion through the OpenAI-compatible
   endpoint, with a successful status and a plausible token count.** `parse_completion`
   currently accepts `choices[1].text == ""` as success. It must not (§9.4).
2. **Templating rules out hand-assembled FIM prompts on `/v1/completions`.** §8.2's
   layout would be wrapped in chat markup.
3. `suffix` — the clean, server-side FIM path — is gated on the model's template,
   so it cannot be relied on even when the endpoint accepts the field.

Hence two profiles:

- **`ollama_raw`** — `POST /api/generate`, body `{ model, prompt, raw = true,
  think = false, stream = false, options = { num_predict, stop, num_ctx } }`.
  Response text is `.response`; prompt tokens are `.prompt_eval_count`. This is
  the path that works here and the default after probing. **`num_ctx` is not
  optional** — omit it and ollama silently applies its 4096 default and truncates
  the prompt from the head, taking the FIM sentinel with it (§8.3.7).
- **`openai`** — `POST /v1/completions`, body `{ model, prompt, max_tokens, stop,
  stream = false }`. Correct for `llama-server`, vLLM and LM Studio, which do not
  template `prompt`. Response text is `.choices[1].text`. This body **has nowhere
  to put `num_ctx`**, so §8.3.7's ceiling has to be checked and refused rather
  than enforced.

`transport = "auto"` probes once per Neovim session and caches the result:
`GET {base_url}/api/version` succeeding ⇒ `ollama_raw`, otherwise `openai`. The
probe is also a health check (§13).

Re-verified 2026-08-21, later pass: every row in the probe table reproduces on
qwen3.5:0.8b. Since the original measurement, `qwen2.5-coder:3b` was installed
locally — it carries ollama's `insert` capability, so `suffix` on
`/v1/completions` returns 200 with real text *for that model*. Nothing
structural changes — `suffix` is still model-gated and `/v1/completions` still
templates `prompt`, so `ollama_raw` with hand-rolled sentinels remains the
default — but FIM is now testable end-to-end on this machine.

### 9.2 Do not "upgrade" the body transport

`hive.curl` already sends the body on curl's stdin via `--data-binary @-`, and
[R§9.3] measured that this beats every alternative found in the wild: no
`E2BIG` on a large prompt, no `-d`-strips-CRLF trap, no API key on disk, nothing
to clean up on failure. codecompanion and avante both write a temp file and both
pay for it. **Leave it alone.** Likewise: do not add `--retry` to the POST
[R§9.3] — a non-idempotent completion must not be re-issued.

### 9.3 The transport fixes

Three fixes from [R§10] plus one keep, all in `lua/hive/curl.lua`. ([R§10]'s
fourth gap — no buffer→bytes function exists anywhere in `lua/hive/` — is closed
by §6's extraction, not here.)

1. **`pcall` around `vim.system`** at `:141` and `:144`. `vim.system` throws when
   the binary or cwd is bad; the `executable("curl")` check at `:120` does not
   cover it. Unguarded, a throw inside a coroutine becomes a silent hang.
   ```lua
   local ok, obj = pcall(vim.system, cmd, opts, on_exit)
   if not ok then return on_exit({ code = 125, signal = 0, stdout = "", stderr = tostring(obj) }) end
   ```
2. **Return the `SystemObj`** so `M.request` has a cancellation handle. Required
   for I4: a refresh on `CursorHold` must supersede the in-flight request. Store
   it per session buffer and `obj:kill("sigterm")` before starting a new one.
3. **Interruptible blocking wait.** Replace `:wait()` with
   `vim.wait(remaining, done_flag, 5)` so the event loop keeps turning and `<C-c>`
   works, distinguishing `wait_reason == -1` (timeout) from interruption.
4. Keep the existing 5 s headroom over curl's `--max-time` so timeouts surface as
   exit code 28 rather than a SIGTERM.

Cancellation uses a **generation counter as well as the kill**, because a killed
process's callback may already be queued: increment `state.generation` on each
submit and drop any response whose generation is stale. Belt and braces, and it
is the pattern telescope uses [R§8.4].

### 9.4 Response validation

`api.parse_completion` gains, before returning success:

```lua
if completion.text == "" then
  local hint = ""
  if decoded.usage and (decoded.usage.completion_tokens or 0) > 0 then
    hint = " (server generated " .. decoded.usage.completion_tokens ..
           " tokens but returned no text — a thinking model on an endpoint that " ..
           "drops the reasoning channel? try transport = \"ollama_raw\")"
  end
  return "model returned an empty completion" .. hint
end
```

This is the single most valuable error message in the plugin: it is the exact
failure measured in §9.1, and without the hint it presents as "hive does nothing".

`M.infill_request(parts, opts)` and `M.infill(parts, opts, cb)` mirror the
existing `completions_request` / `completions` pair, so the existing tests'
structure carries over.

### 9.5 If streaming is added later

Not in v1. When it is, four things from [R§2, §9.4] apply and are already
verified here:

- SSE framing on this server is standard: `data: {…}` per event, one JSON object
  with `choices[1].text` as the delta. Verified.
- `vim.system` with a *function* `stdout` handler **ignores `text = true`** and
  hands raw byte chunks, so partial-line carry becomes hive's problem. Nobody
  gets it free outside plenary's Job.
- Handle `[DONE]` explicitly rather than letting it fail a JSON decode.
- Accumulate into a table joined once; every NDJSON implementation surveyed is
  quadratic.
- Render partial output as **virtual text only**, writing real text on completion
  [R§9.6]. That sidesteps the staleness problem entirely.

### 9.6 When the server is not on this machine

§8.3.4's remote GPU tier is reached in practice by pointing `base_url` at another
machine, not by buying a GPU for this one — and as of 2026-08-24 that is how it
was measured: `llama-server` on `192.168.50.133:8181`, reached over the LAN, on
the `openai` profile. That is a supported move — `base_url` is already the only
coupling point, and `openai` is already the correct profile for `llama-server`,
vLLM and LM Studio (§9.1) — but three assumptions in the transport are **loopback
assumptions**, and each fails quietly rather than loudly once there is a network
in between.

**1. A dead remote host stalls for the whole `timeout`, not instantly.**
Measured 2026-08-23, curl 8.21.0:

| target | outcome | elapsed |
| --- | --- | --- |
| `127.0.0.1:9`, nothing listening | exit 7, connection refused | **0 s** |
| `192.0.2.77:8080` (TEST-NET-1, blackholed), `--max-time 3` | exit 28 | **3 s — the full budget** |
| same, `--connect-timeout 1 --max-time 3` | exit 28 | **1 s** |

Loopback cannot produce the middle row: nothing listening means an immediate
ECONNREFUSED. A remote host that is asleep, or behind a firewall that DROPs
rather than REJECTs, produces exactly it — so the 60 s `timeout` becomes a 60 s
freeze on the blocking path, and `:checkhealth` a 2 s one. **`connect_timeout`
is not a tuning knob; it is what makes a wrong `base_url` diagnosable.**

**2. Credentials on the argv are world-readable.** Headers are built onto the
command line (`curl.lua` `build_args`), so a bearer token added through the
existing `headers` option is visible in `/proc/<pid>/cmdline` to every process on
the box for the life of the request. The fix that does **not** reintroduce the
temp-file problems §9.2 rejects is curl's own indirection:

```
--variable %HIVE_TOKEN --expand-header 'Authorization: Bearer {{HIVE_TOKEN}}'
```

with the value placed in curl's environment by `vim.system`'s `env` (which
extends the parent environment rather than replacing it). The token then exists
only in Neovim's memory and curl's environment — never in an argv, never on
disk. Verified present on curl 8.21.0 here; the pair landed in **curl 8.3.0**, so
it is version-gated, with a plain `--header` fallback and a `:checkhealth` warning
that says why. Note `--location` is already safe with credentials: curl does not
forward `--header` auth across a host change without `--location-trusted`.

**3. TLS has no configuration surface.** `https://` works today with no code
change *only* if the server's certificate is already trusted, which a LAN box
rarely is; hence `tls.cacert`. `tls.insecure` exists because people will
otherwise reach for `http://`, but it makes the channel encrypted and
unauthenticated, which is worse than plaintext for being harder to notice.
`CURL_ERRORS` also gains 35/60/77 (and 5, 47) — without them a certificate
failure reads as `curl exited with code 60`.

**Weigh TLS against the process-per-request design.** Each request is a fresh
curl, so no connection is reused and every request pays a full handshake. Over
plain HTTP on a LAN that is one sub-millisecond RTT; over TLS it is two RTTs plus
handshake crypto **on every completion**. On a trusted segment, plain HTTP is the
defensible choice and the warning in §13 check 2b says so rather than insisting.

#### What this changes elsewhere in the plan

- **§13 check 8 does not work off-box.** `GET /api/ps` is an ollama endpoint. A
  remote `llama-server` or vLLM has no equivalent, so `budget.total_tokens`
  cannot be checked against the server's real window — and §8.3.7's silent
  head-truncation is *still* the failure mode, now undetectable. On the `openai`
  profile against a non-ollama server the ceiling has to be asserted by the
  operator (`llama-server --ctx-size`, vLLM `--max-model-len`) and recorded in
  config, not discovered. **This is an open gap, not a solved one.**
- **§13 gains a model check.** Every server names its models differently and
  `model` defaults to the placeholder `"default"`, so moving the server is
  exactly when it drifts. `GET /v1/models` already returns the list; comparing
  `Config.model` against it turns an HTTP 400 at submit time into a
  `:checkhealth` error naming what *is* served. Cheapest high-value check here.
- **§8.3's numbers must be re-measured on the remote machine**, per §8.3.4 —
  they are properties of the inference host, not of hive.
- **`transport` should be set explicitly to `"openai"`** for a non-ollama remote
  rather than left on `"auto"`. The probe would fall back correctly (`/api/version`
  404s), but it costs a round trip on first use, and §9.1 does not say the cached
  result is keyed by `base_url` — so changing servers mid-session keeps a stale
  transport. Key the cache by `base_url`.
- **The `ollama_raw` rationale weakens off-box.** §9.1's two defects — `prompt`
  being chat-templated, and a thinking model's tokens vanishing — are *ollama
  compatibility-layer* defects. `llama-server`, vLLM and LM Studio do not
  template `prompt`, so a remote one makes §8.2's hand-assembled FIM prompts work
  on `/v1/completions` directly. Keep §9.4's empty-text check regardless: it
  costs nothing and it is the one error message that explains itself.
- **`base_url`'s default stays `http://localhost:8080` for now.** §2's block
  proposes `http://localhost:11434`, but adopting that ahead of §9.1's two-profile
  work would point the shipped default at ollama's `/v1/completions` — the exact
  path §9.1 measured as broken. The two land together in build-order step 2.

