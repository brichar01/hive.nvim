#!/usr/bin/env -S nvim -l
--
-- Measures what §8.3.1 and §8.3.4 (notes/implementation/06-prompt-assembly.md)
-- are built on: what a prompt token costs, what a decoded token costs, what the
-- prefix cache is worth, how many bytes a token is, and what the server does
-- when the prompt does not fit.
--
--   nvim -l scripts/measure/prefill.lua [mode] [url]
--   HIVE_MEASURE_URL=http://192.168.50.133:8181 nvim -l scripts/measure/prefill.lua
--
-- Modes: prefill | decode | decompose | concurrency | cache | bpt | overflow |
--        all (default).
-- Default url: $HIVE_MEASURE_URL, else http://localhost:11434.
--
-- Self-contained: curl and this repo's own Lua as the corpus, nothing else.
-- Detects llama.cpp (`/props`) or ollama (`/api/version`) and uses the native
-- raw-completion path of whichever answers — no chat template, because a
-- template would measure the wrapper (§9.1).
--
-- **Every request carries a unique leading marker**, and on llama.cpp also
-- `cache_prompt: false`. Both where both exist; ollama has no such option, so
-- there the marker is the only defence. A first attempt at §8.3.1 made each
-- prompt a byte prefix of the next and measured the cache instead of the model,
-- reporting ~3x faster than the truth; on the §8.3.4 server the same mistake is
-- worth ~15x.
--
-- `all` against a CPU-only server takes 20+ minutes — the 3900-token prefill row
-- alone is ~70 s per repetition. Run single modes there.
--
-- `decompose` is the one that diagnoses rather than reports: decode step time is
-- linear in context, so fitting it separates the context-independent weight read
-- from the context-dependent KV read. That is what caught §8.3.4's server serving
-- its weights from host memory rather than VRAM, which no aggregate tok/s figure
-- and no concurrency test could have shown -- but only after a tier had already
-- been published from the bad numbers. **Run `decompose` first and read the
-- implied bandwidths before recording any figure from a new server.** Numbers in
-- the 10-70 GB/s range where VRAM was expected mean the result describes a
-- misconfiguration, not the hardware, and reproducibility will not tell you so:
-- the wrong figures were stable to three significant figures across restarts.
--
-- The 2026-08-24 baselines this reproduces are in notes/research/05-verification.md.

local MODE = arg[1] or "all"
local URL = (arg[2] or vim.env.HIVE_MEASURE_URL or "http://localhost:11434"):gsub("/$", "")

local function out(...)
  io.stdout:write(string.format(...), "\n")
  io.stdout:flush()
end

local function die(...)
  io.stderr:write(string.format(...), "\n")
  os.exit(1)
end

---@return table|nil body, integer status
local function post(path, body)
  local r = vim
    .system({
      "curl",
      "-s",
      "-w",
      "\n%{http_code}",
      "--max-time",
      "600",
      "-H",
      "Content-Type: application/json",
      "-d",
      vim.json.encode(body),
      URL .. path,
    }, { text = true })
    :wait()
  local text, status = r.stdout:match("^(.*)\n(%d+)$")
  local ok, decoded = pcall(vim.json.decode, text or "")
  return ok and decoded or nil, tonumber(status) or 0
end

local function get(path)
  local r = vim.system({ "curl", "-s", "--max-time", "10", URL .. path }, { text = true }):wait()
  local ok, decoded = pcall(vim.json.decode, r.stdout)
  return ok and decoded or nil
end

-- server flavour ------------------------------------------------------------

local props = get("/props")
local API = props and "llamacpp" or (get("/api/version") and "ollama" or nil)
if not API then
  die("no llama.cpp or ollama server answered at %s", URL)
end

local MODEL = vim.env.HIVE_MEASURE_MODEL or "qwen2.5-coder:3b"
local WEIGHT_BYTES = nil
if API == "llamacpp" then
  MODEL = props.model_alias or MODEL
  local models = get("/v1/models")
  local first = models and models.data and models.data[1]
  WEIGHT_BYTES = first and first.meta and first.meta.size
end

out("server   %s  (%s)", URL, API)
out("model    %s", MODEL)

-- corpus --------------------------------------------------------------------

local CORPUS = (function()
  local parts = {}
  for name, _ in vim.fs.dir("lua/hive") do
    if name:match("%.lua$") then
      parts[#parts + 1] = name
    end
  end
  table.sort(parts)
  local buf = {}
  for _, name in ipairs(parts) do
    local fd = assert(io.open(vim.fs.joinpath("lua", "hive", name)))
    buf[#buf + 1] = fd:read("a")
    fd:close()
  end
  return table.concat(buf)
end)()

local seq = 0
local function marker()
  seq = seq + 1
  return ("-- run-%d-%d unique-marker\n"):format(vim.uv.hrtime() % 1e9, seq)
end

-- token counting: exact on llama.cpp, absent on ollama (§8.3.5) -------------

local function ntok(text)
  if API ~= "llamacpp" then
    return nil
  end
  local body = post("/tokenize", { content = text })
  return body and #body.tokens or nil
end

--- One raw completion. Returns prefill ms, prefilled tokens, decode ms,
--- decoded tokens — normalised across the two APIs.
local function complete(prompt, n_predict, opts)
  opts = opts or {}
  local body, status
  if API == "llamacpp" then
    body, status = post("/completion", {
      prompt = prompt,
      n_predict = n_predict,
      cache_prompt = opts.cache or false,
      ignore_eos = opts.ignore_eos or false,
      temperature = 0,
      top_k = 1,
      seed = 1,
    })
    if status ~= 200 then
      return nil, status, body
    end
    local t = body.timings
    return {
      prefill_ms = t.prompt_ms,
      prefill_n = t.prompt_n,
      prompt_n = body.tokens_evaluated,
      decode_ms = t.predicted_ms,
      decode_n = t.predicted_n,
    }
  end
  body, status = post("/api/generate", {
    model = MODEL,
    prompt = prompt,
    raw = true,
    stream = false,
    options = { num_predict = n_predict, temperature = 0, top_k = 1, seed = 1 },
  })
  if status ~= 200 then
    return nil, status, body
  end
  return {
    prefill_ms = (body.prompt_eval_duration or 0) / 1e6,
    prefill_n = body.prompt_eval_count,
    prompt_n = body.prompt_eval_count,
    decode_ms = (body.eval_duration or 0) / 1e6,
    decode_n = body.eval_count,
  }
end

-- Warm the model before anything is timed — §8.3.4 step 1 asks for it, and on
-- ollama it is load-bearing for a second reason: `/api/ps` returns an empty
-- `models` list until something is resident, so the window cannot be read at all
-- until a request has set it. That is §8.3.7's trap seen from the client side.
do
  local warm = complete(marker() .. "local x = 1\n", 1)
  if not warm then
    die("the warm-up request failed — is %s serving %s?", URL, MODEL)
  end
  if API == "llamacpp" then
    out("window   %d per slot x %d slots", props.default_generation_settings.n_ctx, props.total_slots)
    out("weights  %.2f GiB", (WEIGHT_BYTES or 0) / 2 ^ 30)
  else
    local m = (get("/api/ps") or {}).models
    m = m and m[1]
    if m then
      WEIGHT_BYTES = m.size
      out("window   %s (/api/ps, i.e. the live num_ctx — not /api/show; §8.3.7)", m.context_length or "?")
      out(
        "weights  %.2f GiB, of which %.2f GiB in VRAM%s",
        (m.size or 0) / 2 ^ 30,
        (m.size_vram or 0) / 2 ^ 30,
        (m.size_vram or 0) == 0 and "  <- CPU-only, the §8.3.1 baseline" or ""
      )
    else
      out("window   ? — /api/ps reported no loaded model even after a request")
    end
  end
end
out("")

--- A prompt of about `target` tokens, with a unique leading marker.
--- Exact by bisection where a tokenizer exists, else by `bytes_per_token`.
local function build(target)
  local head = marker()
  if API ~= "llamacpp" then
    return head .. CORPUS:sub(1, math.floor(target * 3.9) - #head)
  end
  local lo, hi = 0, #CORPUS
  while lo < hi do
    local mid = math.floor((lo + hi) / 2)
    if (ntok(head .. CORPUS:sub(1, mid)) or 0) < target then
      lo = mid + 1
    else
      hi = mid
    end
  end
  return head .. CORPUS:sub(1, lo)
end

local function median(xs)
  table.sort(xs)
  return xs[math.ceil(#xs / 2)]
end

-- modes ---------------------------------------------------------------------

local M = {}

function M.prefill()
  out("== prefill (unique marker + cache off, median of 3)")
  out("%8s %8s %10s %8s", "target", "tokens", "ms", "tok/s")
  for _, target in ipairs({ 100, 200, 400, 800, 1600, 2400, 3200, 3900 }) do
    local ms, n = {}, nil
    for _ = 1, 3 do
      local r, status, body = complete(build(target), 1)
      if not r then
        out("%8d  HTTP %s %s", target, status, vim.inspect(body):sub(1, 120))
        return
      end
      ms[#ms + 1], n = r.prefill_ms, r.prefill_n
    end
    local m = median(ms)
    out("%8d %8d %10.0f %8.0f", target, n, m, n / (m / 1000))
  end
  out("\nA curve that *rises* past 1600, or 3000+ tok/s, means the cache won.")
end

function M.decode()
  out("\n== decode (ignore_eos, so the full n_predict is generated)")
  out("%14s %10s %10s %8s", "prompt tokens", "n_predict", "ms", "tok/s")
  for _, case in ipairs({ { 200, 128 }, { 200, 256 }, { 1600, 64 }, { 3200, 64 } }) do
    local prompt, npred = build(case[1]), case[2]
    local ms = {}
    for _ = 1, 3 do
      local r = complete(prompt, npred, { ignore_eos = true })
      ms[#ms + 1] = r.decode_ms
    end
    local m = median(ms)
    out("%14d %10d %10.0f %8.1f", case[1], npred, m, npred / (m / 1000))
  end
  out("\nDecode is bandwidth-bound and prefill is compute-bound: do not assume")
  out("one from the other. Both improve on a GPU, but by different factors --")
  out("§8.3.4 measures ~20x for prefill and ~2.4x for decode. fim.max_tokens")
  out("follows from this number, never from the prefill one.")
end

function M.cache()
  out("\n== prefix cache (cache on; the §8.2 layout exists to hit this)")
  local base = build(1500)
  local tail = CORPUS:sub(#base + 1, #base + 800)
  local function row(label, prompt)
    local r = complete(prompt, 1, { cache = true })
    out("%-14s prefilled %5d of %5s  %8.0f ms", label, r.prefill_n, r.prompt_n or "?", r.prefill_ms)
  end
  row("cold", base)
  row("append tail", base .. tail)
  row("identical", base .. tail)
  row("front edit", "-- one line added at the very front\n" .. base .. tail)
  out("\n`prefilled` is timings.prompt_n and it is NOT the prompt length: never")
  out("reconcile bytes_per_token against it (§8.3.5).")
end

function M.bpt()
  if API ~= "llamacpp" then
    out("\n== bytes/token: skipped, ollama has no tokenizer endpoint (§8.3.5)")
    return
  end
  out("\n== bytes/token, exact, over lua/hive/*.lua")
  out("%9s %8s %13s", "bytes", "tokens", "bytes/token")
  for _, b in ipairs({ 800, 1600, 3200, 6400, 12800, #CORPUS }) do
    local s = CORPUS:sub(1, b)
    local t = ntok(s)
    out("%9d %8d %13.3f", #s, t, #s / t)
  end
end

function M.overflow()
  out("\n== over the window (§8.3.7)")
  local prompt = build(4000) .. CORPUS:sub(1, 3000)
  local n = ntok(prompt)
  local r, status, body = complete(prompt, 8)
  if r then
    out("HTTP 200 with %s prompt tokens — check whether it TRUNCATED", n or "?")
    out("  prefilled %d, decoded %d", r.prefill_n, r.decode_n or 0)
    out("  ollama truncates from the head and beheads the FIM sentinel: §8.3.7")
  else
    out("HTTP %d for %s prompt tokens — a loud failure, which is the good case", status, n or "?")
    out("  %s", vim.inspect(body):gsub("%s+", " "):sub(1, 220))
  end
end

--- Decode step time against context, least-squares fit. The intercept is the
--- weight read (paid once per token, context-independent); the slope is the KV
--- read (grows with history). Both, expressed as bandwidth, say where the
--- working set actually lives — §8.3.4.
function M.decompose()
  out("\n== decode step time vs context (the diagnostic; §8.3.4)")
  out("%9s %11s %8s", "context", "ms/token", "tok/s")
  local pts = {}
  for _, ctx in ipairs({ 20, 200, 800, 1600, 2400, 3200 }) do
    local prompt = build(ctx)
    local ms = {}
    for _ = 1, 3 do
      local r = complete(prompt, 64, { ignore_eos = true })
      ms[#ms + 1] = r.decode_ms / r.decode_n
    end
    local m = median(ms)
    pts[#pts + 1] = { ctx, m }
    out("%9d %11.2f %8.1f", ctx, m, 1000 / m)
  end

  local n = #pts
  local mx, my = 0, 0
  for _, pt in ipairs(pts) do
    mx, my = mx + pt[1] / n, my + pt[2] / n
  end
  local num, den, sst = 0, 0, 0
  for _, pt in ipairs(pts) do
    num = num + (pt[1] - mx) * (pt[2] - my)
    den = den + (pt[1] - mx) ^ 2
    sst = sst + (pt[2] - my) ^ 2
  end
  local slope = num / den
  local icpt = my - slope * mx
  local ssr = 0
  for _, pt in ipairs(pts) do
    ssr = ssr + (pt[2] - (icpt + slope * pt[1])) ^ 2
  end

  out("\nstep = %.2f ms + %.4f ms per 1000 ctx tokens   (r2 %.4f)", icpt, slope * 1000, 1 - ssr / sst)

  -- Interpreting those two numbers as bandwidth needs the weight size (the API
  -- reports it) and the KV size per token (it does not — this is the
  -- Qwen2.5-Coder-7B figure, override for another model).
  local weights = WEIGHT_BYTES
  local kv_per_tok = tonumber(vim.env.HIVE_MEASURE_KV_BYTES or "") or (56 * 1024)
  if not weights then
    out("weight size unknown on this API — skipping the bandwidth reading")
    return
  end
  out("  intercept -> weight read at %5.0f GB/s", weights / (icpt / 1000) / 1e9)
  out(
    "  slope     -> KV read     at %5.0f GB/s  (assuming %d KiB/token)",
    kv_per_tok / (slope / 1000) / 1e9,
    kv_per_tok / 1024
  )
  out("")
  out("Compare against the card's spec bandwidth -- expect 55-65%% of it, not")
  out("all of it. Host-memory or PCIe numbers (10-70 GB/s) where VRAM was")
  out("expected mean the working set is not resident: fix the server before")
  out("recording anything else from this run, however reproducible it looks.")
  out("§8.3.4's correction note is what happens when that step is skipped.")
end

--- Does the server fuse concurrent decodes into one forward pass, or time-slice?
--- Near-linear aggregate scaling means batching; flat means serialisation.
function M.concurrency()
  out("\n== decode under concurrency")
  out("%9s %18s %17s %9s", "streams", "per-stream tok/s", "aggregate tok/s", "scaling")
  local NPRED, base = 64, nil
  for _, streams in ipairs({ 1, 2, 4 }) do
    local prompts = {}
    for _ = 1, streams do
      prompts[#prompts + 1] = build(300) -- built outside the timed region
    end
    local t0 = vim.uv.hrtime()
    local jobs, rates = {}, {}
    for _, prompt in ipairs(prompts) do
      jobs[#jobs + 1] = vim.system({
        "curl",
        "-s",
        "--max-time",
        "600",
        "-H",
        "Content-Type: application/json",
        "-d",
        vim.json.encode({
          prompt = prompt,
          n_predict = NPRED,
          cache_prompt = false,
          ignore_eos = true,
          temperature = 0,
        }),
        URL .. (API == "llamacpp" and "/completion" or "/api/generate"),
      }, { text = true })
    end
    for _, job in ipairs(jobs) do
      local ok, body = pcall(vim.json.decode, job:wait().stdout)
      if ok and body.timings then
        rates[#rates + 1] = body.timings.predicted_per_second
      end
    end
    local wall = (vim.uv.hrtime() - t0) / 1e9
    local agg = streams * NPRED / wall
    base = base or agg
    out("%9d %18.1f %17.1f %8.2fx", streams, median(rates), agg, agg / base)
  end
  out("\n~4x aggregate at 4 streams means real batching; ~1x means the slots")
  out("time-slice, concurrent submits serialise, and this test cannot be used")
  out("to diagnose *what* is bottlenecking decode — use `decompose` for that.")
end

function M.all()
  M.prefill()
  M.decode()
  M.decompose()
  M.concurrency()
  M.cache()
  M.bpt()
  M.overflow()
end

local run = M[MODE] or die("unknown mode %q — prefill|decode|decompose|concurrency|cache|bpt|overflow|all", MODE)
run()
