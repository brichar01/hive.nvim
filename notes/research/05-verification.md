# Verification — how to reproduce every claim

Part of the `hive.nvim` research notes — index: [`PLAN.md`](../../PLAN.md).
Section numbers are unchanged by the split; a `§n` cross-reference still resolves
via the section map in the index.

---

## Verification

Reading confirmation and measurement, not tests — nothing here modifies the
plugin. `make test` and `:checkhealth hive` are unaffected.

**§1 — line endings.** On a buffer with `:set noeol nofixeol`, and again with
`:set fileformat=dos`:

```vim
:lua =vim.inspect(vim.lsp._buf_get_full_text(0))
:lua =vim.inspect(vim.api.nvim_buf_get_lines(0,0,-1,true))
```

The difference between those two outputs is the entire §1 argument. Then check a
filter is byte-exact, and watch it fail with the table form:

```lua
:lua local t = vim.lsp._buf_get_full_text(0)
     print(vim.system({'cat'}, { stdin = t, text = true }):wait().stdout == t)
```

**§11.2/§11.3 — the node walk.** Cursor inside a doc-commented function, Lua
buffer:

```lua
:lua local n = (vim.treesitter.get_parser(0):parse() and vim.treesitter.get_node())
     while n and n:type() ~= 'function_declaration' do n = n:parent() end
     local prev = n and n:prev_named_sibling()
     print(n:start(), prev and prev:type(), prev and prev:start())
```

On `lua/hive/curl.lua:131` this prints `118  comment  117`. Move the cursor to
`:125` and swap the condition for `n:type():find('function')` to reproduce the
lambda trap. Then the signature slice:

```lua
:lua local body = n:field('body')[1]
     print(vim.inspect(vim.api.nvim_buf_get_lines(0, n:start(), body:start(), false)))
```

gives `{ "function M.request(req, callback)" }`.

**§11.4 — injections.** In a markdown buffer with a fenced Lua block:

```lua
:lua local r = vim.fn.line('.') - 1
     local p = vim.treesitter.get_parser(0); p:parse(true)
     print(p:language_for_range({r,0,r,0}):lang())
```

Drop the `true` and every row reports `markdown`.

**§11.5 — parse cost.** In a *fresh* `nvim`, so the timer covers a cold load:

```lua
:lua local t = vim.uv.hrtime(); local ps = vim.treesitter.get_parser(0)
     print(('get_parser %.3f ms'):format((vim.uv.hrtime()-t)/1e6))
     t = vim.uv.hrtime(); ps:parse()
     print(('first parse %.3f ms'):format((vim.uv.hrtime()-t)/1e6))
```

~3 ms cold (sub-0.01 ms once loaded) and ~0.5 ms. If you measure 22 ms, the
timer is wrong.

**§11.6.1 — query supply.** In a **Lua** buffer:

```lua
:lua for _, q in ipairs({'highlights','folds','indents','locals','textobjects'}) do
       print(q, vim.treesitter.query.get(vim.bo.filetype, q) ~= nil) end
```

Expected: `highlights true`, `folds true`, and `indents`/`locals`/`textobjects`
all `false`. Then confirm *why*, which is the part that is easy to misdiagnose:

```lua
:lua =vim.api.nvim_get_runtime_file('queries/lua/locals.scm', true)   -- {}
:lua =vim.api.nvim_get_runtime_file('queries/lua/folds.scm', true)    -- core only
:lua =vim.treesitter.query.get('python', 'locals') ~= nil             -- true
:lua =vim.uv.fs_readlink(vim.fn.stdpath('data')..'/site/queries/python')
```

**§12.4 — the overlap trap.**

```lua
:lua local b=vim.api.nvim_create_buf(false,true)
     vim.api.nvim_buf_set_lines(b,0,-1,false,{'AAA generated ZZZ'})
     local ns=vim.api.nvim_create_namespace('t')
     vim.api.nvim_buf_set_extmark(b,ns,0,4,{end_row=0,end_col=13})
     print(#vim.api.nvim_buf_get_extmarks(b,ns,{0,8},{0,8},{}))              -- 0
     print(#vim.api.nvim_buf_get_extmarks(b,ns,{0,8},{0,8},{overlap=true}))  -- 1
```

**§12.6 — the undo break.**

```lua
:lua vim.cmd('enew!') vim.bo.undolevels=1000
     vim.api.nvim_buf_set_lines(0,0,-1,false,{''})
     for i=1,3 do
       vim.cmd('let &undolevels=&undolevels')   -- comment out to see it collapse
       local l=vim.api.nvim_get_current_line()
       vim.api.nvim_buf_set_text(0,0,#l,0,#l,{'w'..i..' '})
     end
     vim.cmd('undo') print(vim.inspect(vim.api.nvim_get_current_line()))
```

With the break: `"w1 w2 "`. Without it: `""`.

**§12.5 — the reload trap.** Place a mark, change the file on disk so a line is
*prepended*, `:edit!`, then read the text the mark now covers. It will be the
wrong line, and the mark will still report valid.

**§8.3.4 — the remote GPU server.** Measured 2026-08-24 against
`192.168.50.133:8181` — `llama-server` build `b10217`,
`Qwen2.5-Coder-7B-Instruct` Q4_K_M, on an **RTX 2060 with 6 GB VRAM**, one slot
of 4096. Record the card, the slot count, *and* whether the model is actually
resident on the card: the first pass at this section recorded the first two and
not the third, and published decode figures ~3x too slow as a result (§8.3.4's
correction note). The harness is
[`scripts/measure/prefill.lua`](../../scripts/measure/prefill.lua), and
`make measure-prefill` runs all of it:

```sh
S=http://192.168.50.133:8181
nvim -l scripts/measure/prefill.lua prefill     $S  # the tok/s curve
nvim -l scripts/measure/prefill.lua decode      $S  # decode, ignore_eos
nvim -l scripts/measure/prefill.lua decompose   $S  # WHERE the decode time goes
nvim -l scripts/measure/prefill.lua concurrency $S  # does the server batch?
nvim -l scripts/measure/prefill.lua cache       $S  # cold/append/identical/front-edit
nvim -l scripts/measure/prefill.lua bpt         $S  # exact bytes/token
nvim -l scripts/measure/prefill.lua overflow    $S  # the 400
```

It detects llama.cpp or ollama from `/props` versus `/api/version` and uses the
native raw path of whichever answers, so the same harness re-derives §8.3.1
against the local ollama (`nvim -l scripts/measure/prefill.lua all`, no url).

Expected: prefill plateaus at ~1410–1500 tok/s from 800 tokens up (**not**
degrading, which is the whole difference from §8.3.1); decode 44.0 tok/s at a
200-token prompt falling only to 42.6 at 3200; `bpt` converging on 4.07;
`overflow` returning HTTP 400 `exceed_context_size_error`. If `prefill` reports
3000+ tok/s or a *rising* curve past 1600, the prefix cache is not defeated —
check that both the unique marker and `cache_prompt: false` are in the request.

**Run `decompose` first on any server, before believing any other number from
it.** It is the only mode that says *where* the time goes rather than how much of
it there is, and it is the one that catches a server that is not using the GPU
you think it is:

```
step = 22.56 ms + 0.3123 ms per 1000 ctx tokens   (r2 0.9846)
  intercept -> weight read at   207 GB/s
  slope     -> KV read     at   184 GB/s
```

A 2060 is a 336 GB/s card, so both terms are at 55–62% of spec — which is what a
memory-bound kernel actually achieves, and therefore what a correctly resident
model looks like from the client. **The failing case, for comparison**: the same
fit on this server before it was reconfigured gave `69.1 ms + 5.87 ms/1000`, i.e.
68 GB/s and 10 GB/s. Those are host-memory and PCIe numbers. If you see them,
stop and fix the server — do not write the tier down first.

Two traps that pass a plausibility check and are still wrong:

- **Reproducibility is not validity.** Those 68 GB/s figures were stable to three
  significant figures across two server restarts. All that established was that
  the misconfiguration was stable.
- **Numeric agreement is not mechanism.** VRAM overcommit (896 MiB of KV on a
  6 GB card) predicted that `--parallel 1`, which frees 672 MiB, would fix it,
  and the arithmetic matched to within 5%. Measured after that restart:
  intercept 69.13 ms, slope 5.87. Unchanged. The cause was elsewhere.
- **Spec bandwidth over-predicts by ~1.6x.** 4.36 GiB of weights against the
  2060's 336 GB/s says ~70 tok/s; the measurement is 44. Size a decode budget
  from ~60% of spec, not spec.

`concurrency` needs `--parallel 2` or more to say anything about batching. This
server now runs one slot, so it reports per-stream 44.1 tok/s flat and aggregate
32.6 / 37.7 / 37.5 tok/s at 1 / 2 / 4 streams — that is requests queueing, not
batching, and concurrent submits therefore serialise. Note this mode **cannot**
diagnose what bottlenecks decode: flat aggregate is what both a non-batching
server and a queueing one produce, regardless of cause. Use `decompose`.

The three claims that are one curl each, and worth re-checking before trusting
any of the above:

```sh
# the window that actually binds — per slot, not per server, not n_ctx_train
curl -s $S/props | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["default_generation_settings"]["n_ctx"], d["total_slots"], d["model_alias"])'
# 4096 1 Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M

# an exact tokenizer exists here, unlike ollama (§8.3.5)
curl -s $S/tokenize -d '{"content":"local x = 1\n"}' -H 'Content-Type: application/json'

# prompt_n counts what was PREFILLED; usage.prompt_tokens counts the prompt.
# Run this twice — the second run reports prompt_n 1 and prompt_tokens unchanged.
curl -s $S/v1/completions -H 'Content-Type: application/json' \
  -d '{"prompt":"-- fixed marker\nlocal function add(a, b)\n  return a + b\nend\n","max_tokens":1,"temperature":0}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["usage"], d["timings"]["prompt_n"])'
```

FIM on the instruct build, which the tier depends on and which an instruct tag is
the natural place to doubt:

```sh
curl -s $S/completion -H 'Content-Type: application/json' \
  -d '{"prompt":"<|fim_prefix|>local function add(a, b)\n  return <|fim_suffix|>\nend\n<|fim_middle|>","n_predict":8,"temperature":0}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["content"])'
# "a + b\nend\n\nlocal function" — correct, and note it does NOT stop at `end`.
```

**Machine facts**, if this is ever re-read elsewhere:

```sh
nvim --version | head -1                       # NVIM v0.12.4
nvim --headless -c 'lua io.write(vim.env.VIMRUNTIME)' -c q
ls ~/.local/share/nvim/site/parser/            # c html python tsx typescript
ls -l ~/.local/share/nvim/site/queries/        # 8 symlinks into tree-sitter-manager
ls /usr/share/nvim/runtime/parser/             # the 7 bundled parsers
curl -s localhost:11434/api/version            # the local model server
curl -s 192.168.50.133:8181/health              # the §8.3.4 remote server
curl -s 192.168.50.133:8181/props | head -c 200 # ...and what it is serving
```

If `site/queries/` is empty or the symlinks point elsewhere, §11.6.1 is the
section to re-derive first — §11.7, §11.8 and `IMPLEMENTATION.md` §7.2 all hang
off it.
