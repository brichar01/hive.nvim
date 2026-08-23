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

**Machine facts**, if this is ever re-read elsewhere:

```sh
nvim --version | head -1                       # NVIM v0.12.4
nvim --headless -c 'lua io.write(vim.env.VIMRUNTIME)' -c q
ls ~/.local/share/nvim/site/parser/            # c html python tsx typescript
ls -l ~/.local/share/nvim/site/queries/        # 8 symlinks into tree-sitter-manager
ls /usr/share/nvim/runtime/parser/             # the 7 bundled parsers
curl -s localhost:11434/api/version            # the local model server
```

If `site/queries/` is empty or the symlinks point elsewhere, §11.6.1 is the
section to re-derive first — §11.7, §11.8 and `IMPLEMENTATION.md` §7.2 all hang
off it.
