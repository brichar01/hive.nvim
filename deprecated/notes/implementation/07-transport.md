# Transport — §9

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 9. Transport

### 9.1 One transport: `POST /v1/completions`

hive speaks `POST /v1/completions` to a `llama-server`, and nothing else. There
is no profile to choose and no probe to run.

```
POST {base_url}/v1/completions
{ "model": …, "prompt": …, "max_tokens": …, "stop": [ … ], "stream": false }
```

Response text is `.choices[1].text`, the cache-immune prompt count is
`usage.prompt_tokens` (§8.3.5), and the stop reason is
`.choices[1].finish_reason`.

**The endpoint carries this design because `llama-server` does not template
`prompt`.** Measured 2026-08-25 on build 10612: `prompt = "x"` reports
`prompt_tokens = 1`, so §8.2's hand-assembled FIM layout arrives at the model
exactly as written, sentinels and all. That is the whole requirement, and it is
why the layout is assembled by hand rather than delegated to a server-side
`suffix` parameter — hive needs R1 and R2 *inside* the FIM prefix, which `suffix`
has nowhere to put. §9.7 has the measurements.

**`model` is a courtesy field here.** This server ignores it and answers from the
single loaded model: a request naming `"default"` came back with
`model: "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q6_K"`. `Config.model` therefore
defaults to a placeholder and exists for servers that serve several, which is why
§13's check compares it against `/v1/models` rather than assuming a 400 will say
so.

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

Two checks, before `api.parse_completion` returns success.

**1. An empty completion is a failure, not a success.** `parse_completion`
currently accepts `choices[1].text == ""`, and a 200 with an empty string and a
plausible token count presents to the user as "hive does nothing".

```lua
if completion.text == "" then
  local hint = ""
  if decoded.usage and (decoded.usage.completion_tokens or 0) > 0 then
    hint = " (server generated " .. decoded.usage.completion_tokens ..
           " tokens but returned no text — check `fim.stop`: a stop string that " ..
           "matches at position 0 consumes the whole completion)"
  end
  return "model returned an empty completion" .. hint
end
```

The hint names the cause that is actually reachable here. §8.1's dialects put
`<|endoftext|>` and `<|file_sep|>` in the stop list, and a model that opens with
one of them returns tokens and no text.

**2. A completion the window truncated must not pass silently.** §8.3.7's second
case: when the prompt fits and the completion does not, the server stops at the
window and reports `finish_reason = "length"` with
`usage.completion_tokens < max_tokens`. That is indistinguishable from a
legitimate cap unless the two are compared.

```lua
local n = (decoded.usage or {}).completion_tokens or 0
if completion.finish_reason == "length" and n > 0 and n < requested_max_tokens then
  -- warn, do not fail: the text is real
end
```

Warn and keep the text. [R§8.10]'s no-silent-caps rule is what makes this a
report rather than a debug log.

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
§9.1's endpoint unchanged. That is a supported move — `base_url` is the only
coupling point, and the request shape is identical either way — but three
assumptions in the transport are **loopback assumptions**, and each fails quietly rather than loudly once there is a network
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

- **§13 check 8 works off-box, and that used to be an open gap.** The window is
  readable from `GET /props` on any `llama-server`, local or remote (§8.3.7), so
  `budget.total_tokens` can be checked against the server's real window wherever
  it runs. Against a different OpenAI-compatible server that serves no `/props` —
  vLLM, LM Studio — the ceiling has to be asserted by the operator
  (`--max-model-len`) and recorded in config, and the check degrades to `info`.
- **§13 gains a model check.** A server that serves several models will 400 on a
  name it does not have, and `model` defaults to a placeholder, so moving the
  server is exactly when it drifts. `GET /v1/models` already returns the list;
  comparing `Config.model` against it turns an HTTP 400 at submit time into a
  `:checkhealth` error naming what *is* served.
- **§8.3's numbers must be re-measured on the remote machine**, per §8.3.4 and
  §8.3.8 — they are properties of the inference host and its configuration, not
  of hive.
- **`base_url` is the only thing that changes.** The same endpoint, the same
  body and the same response fields serve a loopback server and a remote one, so
  pointing hive at another machine is a one-line config change plus the TLS and
  credential handling above.

### 9.7 The server, measured

Measured 2026-08-25 against the server in §8.3.1: `llama-server` build 10612 on
`localhost:8080`, `Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q6_K`, one slot of 4096.
These are the probes §9.1 rests on.

| probe | result |
| --- | --- |
| `/v1/completions`, `prompt = "x"` | `prompt_tokens = 1` — genuinely raw, no chat template |
| `/v1/completions` + hand-rolled FIM sentinels | works, `finish_reason = "stop"` after 5 tokens |
| `/v1/completions` + `suffix` | 200 with real text, server-side FIM works |
| `/infill` | works |
| `/v1/completions`, `model = "default"` | 200, answered from the loaded model |

Each FIM sentinel is one special token: `<|fim_prefix|>` 151659, `<|fim_suffix|>`
151661, `<|fim_middle|>` 151660, `<|file_sep|>` 151664, `<|repo_name|>` 151663.
So §8.2's layout costs five tokens of framing, not five strings of it.

**`fim.stop` is load-bearing, and which build you have decides how much.** The
raw FIM request above terminated on its own after five tokens. The 7b instruct
build on §8.3.4's server, given the same prompt shape, ran past `end` into the
next function. Neither behaviour is a property of the endpoint, so the stop list
is what makes the two behave alike. `suffix` and `/infill` both ran to the token
cap rather than stopping, so the server-side FIM paths need the caller's stop
list too.

**Why not `/infill`.** It works, and it is the endpoint built for this. It also
takes `input_prefix` and `input_suffix` as plain strings and assembles the
sentinels itself, which leaves nowhere to put R1 and R2 inside the FIM prefix
where §8.2 needs them. Hand-assembling on `/v1/completions` costs nothing and
keeps the layout under hive's control.

