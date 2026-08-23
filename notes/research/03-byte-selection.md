# Selecting which bytes to send — §11

Part of the `hive.nvim` research notes — index: [`PLAN.md`](../../PLAN.md).
Section numbers are unchanged by the split; a `§n` cross-reference still resolves
via the section map in the index.

---

## 11. Selecting which bytes to send

### 11.1 Three layers, and what each cannot do

| Layer | Answers | Cannot answer | Latency |
| --- | --- | --- | --- |
| **treesitter** | where does this construct start and end | what is this identifier, where else is it used | sync, sub-millisecond |
| **LSP** | what is related to this, across files | anything, while the server is still indexing | one round trip, **async only** |

**LSP has no synchronous mode.** That is why `IMPLEMENTATION.md` §7.1 gives the
`documentSymbol` request a hard timeout and degrades region 2 to empty rather
than delaying a refresh.

*Retired:* a third row for "vimscript lists" — `getbufinfo().lastused`,
`getjumplist()`, `getchangelist()`, gitsigns hunks — as a recency signal. Cheap
and high-value for a completion prompt, but the workbench's context comes from
region 1 and the target cursor, so recency has no place in v1.

### 11.2 Treesitter: the boundary layer

Four core calls do the whole enclosing-construct walk: `vim.treesitter.get_node()`
(`treesitter.lua:394`), `node:parent()`, `vim.treesitter.get_node_text()`
(`:232`), and `vim.treesitter.select('parent')` (`:520`) if a user-driven "widen"
is ever wanted.

**Two traps, both silent.**

**`get_node()` on an unparsed tree returns a wrong node, and core says so.** The
docstring at `treesitter.lua:383` reads *"Calling this on an unparsed tree can
yield an invalid node"* and points at `get_parser(bufnr):parse(range)`. Nothing
guarantees the highlighter has run for the current tick, so the parse must be
explicit. Per §11.5 it costs 0.09 ms.

**Do not match node types by substring.** `while n:type():find('function')` is the
obvious walk and it stops at the first lambda. Measured with the cursor on
`lua/hive/curl.lua:125`, inside the `vim.schedule(function()` callback at `:123`:
it returns a `function_definition` starting at row 122 with no name and
`prev_named_sibling() == nil`, so §11.3's doc-comment walk then indexes `nil`.
Match an explicit per-language declaration type.

**The signature slice needs no per-language table** — but `body` is an *optional*
field, and this is the correction that matters most for a FIM plugin. Measured:

| Source | `body` |
| --- | --- |
| `lua`: `function M.f()` + `return 1` + `end` | `block` |
| `lua`: `function M.f() end` | **`nil`** |
| `lua`: `function M.f()` + `end` (two lines) | **`nil`** |
| `lua`: body of whitespace only | **`nil`** |
| `lua`: body of one comment only | **`nil`** |
| `python`: `def f():` + `pass`, or `...` | `block` |
| `typescript`: `function f() {}` | `statement_block` |
| `c`: `int f(void) {}` | `compound_statement` |

**Languages whose block is delimited by tokens (`{}`) always emit the body node
even when it is empty. Languages whose block is a bare statement list — Lua's
`block` between `)` and `end` — omit the field entirely when there is nothing in
it.** Ruby (`def f` … `end`) and the Erlang/Elixir family are the same shape and
should be assumed to behave the same way until measured.

The consequence is specific and severe for this plugin: **"I have written the
signature, fill in the body" is the central FIM use case, and it is exactly the
case where `field('body')` is `nil`.** A walk conditioned on
`node:field('body')[1] and DECL_TYPES[node:type()]` climbs straight past a
freshly-written empty function and falls back to a line window, silently. Test the
declaration *type* first and treat `body` as optional.

When `body` is present the slice is `node:start()` → `body:start()`; measured on
`function M.request` (`curl.lua:119`), `block` spans rows 119–148 so the slice is
row 118 alone — `function M.request(req, callback)`. When `body` is absent, fall
back to the end of the `parameters` node — the branch an empty Lua function
actually takes, since Lua's `function_declaration` does carry `parameters` — and
when that too is absent, to the declaration's own end row. Re-measured
2026-08-21: that last branch is unreached for every measured language. C lacks
the fields (see below) but its `function_definition` always carries a
`compound_statement` body, even for `{}` — a prototype is a `declaration` node,
a different type — so the body branch always fires for C; the end-row fallback
guards unmeasured grammars only.

**`field('parameters')` is missing on C as well**, not just `field('name')`: both
live inside `declarator`. Measured `params=false` for `int f(void) {}`.

The *declaration type* does need a table. Re-verified here for the five parsers
installed (`lua` `function_declaration`/`block`; `python`
`function_definition`/`block`; `typescript` and `tsx`
`function_declaration`/`statement_block`; `c` `function_definition`/
`compound_statement`), carried over from the earlier pass for `javascript`,
`rust` (`function_item`), `go`, `cpp`, `java`/`c_sharp` (`method_declaration`),
`ruby` (`method`/`body_statement`). **C and C++ have no `name` field** — the name
lives inside `declarator` — so anything keying on `name` breaks there. Verified
for `c`.

Use `get_node_text` rather than `nvim_buf_get_text` directly: its
`buf_range_get_text` helper (`treesitter.lua:203`) carries the `end_col == 0`
newline fixup at `:205`.

**Third trap: the declaration is often not a direct child of the root.** Measured
by walking the ancestor chain from a cursor in the body, per language:

| Source | node picked by "first ancestor with a `body` field" | its `prev_named_sibling()` |
| --- | --- | --- |
| `lua`: `function M.add(a, b)` | `function_declaration` | `comment` ✓ |
| `c`: `static inline int add(…)` | `function_definition` | `comment` ✓ |
| `typescript`: `function add(…)` | `function_declaration` | `comment` ✓ |
| `typescript`: **`export` function add(…)`** | `function_declaration` | **`nil`** |
| `typescript`: `export const add = (…) => {}` | **`arrow_function`** | `identifier` |
| `tsx`: `export const Button = (…) => {}` | **`arrow_function`** | `identifier` |
| `python`: `@app.route(…)` + `def handler(…)` | `function_definition` | **`decorator`** |

Three distinct structural facts, each of which breaks a naive walk:

1. **Wrapper nodes.** In TS/JS the declaration is a child of `export_statement`;
   in Python a decorated `def` is a child of `decorated_definition`. The chain is
   `function_declaration < export_statement < program`. So `prev_named_sibling()`
   on the declaration is `nil` — **the doc comment is a sibling of the wrapper,
   not of the declaration.** §11.3's walk silently finds nothing for every
   exported function in TS/JS, which is most of them.
2. **Value-position functions.** `export const add = (a, b) => {}` gives
   `arrow_function < variable_declarator < lexical_declaration < export_statement`.
   The `arrow_function` carries `body` but has **no `name` field** — the name is
   on `variable_declarator`. It is also not a "declaration" type, so a
   type-matched walk climbs straight past it and finds nothing. In modern TS and
   in every React codebase this is the common form, not an edge case.
3. **Non-comment preludes.** Python decorators are `decorator` siblings; Rust
   attributes (`#[derive(…)]`) and C#/Java annotations are the same shape. A walk
   that accepts only `comment` stops at the first one and drops it — and
   `@app.route("/x")` is frequently the single most informative line about what a
   function *is*.

The fix is two small per-language sets rather than one: **unwrap** node types to
climb through before deciding, and **prelude** node types to accept in §11.3's
walk alongside `comment`. `IMPLEMENTATION.md` §6.3 and §6.4 carry them.

### 11.2.1 Import and include sections

Measured node types at the top level, for the parsers installed here:

| Language | Import node types | Notes |
| --- | --- | --- |
| `python` | `import_statement`, `import_from_statement`, `future_import_statement` | three distinct types, all direct children of the root |
| `typescript` / `tsx` / `javascript` | `import_statement`, **plus `export_statement` that has a `source` field** | `import type {…}` and bare `import "./x.css"` are both `import_statement`. Re-exports (`export {bar} from "./bar"`, `export * from "./all"`) are `export_statement`; the `source` field is what distinguishes them from `export function f(){}` — verified true and false respectively |
| `c` / `cpp` | `preproc_include` | ranges have **`end_col == 0` and `end_row` = the following row**, so a slice must use `end_row` rather than `end_row + 1` — the same newline fixup class as §11.2's `get_node_text` note |
| **`lua`** | **none** | `local Config = require("hive.config")` is an ordinary `variable_declaration`, structurally identical to `local M = {}` and `local api = vim.api`. The grammar does not distinguish an import from any other local binding |

Reasoned from grammar shape, not measured here (no parser installed): `rust`
`use_declaration`; `go` `import_declaration`; `java` `import_declaration`;
`c_sharp` `using_directive`; `ruby` — same problem as Lua, `require` is a method
call.

**For languages with no import node, the portable substitute is the file
prologue**: every top-level node before the first node whose type is in
`DECL_TYPES`. Measured, it collects the right thing in all four cases:

```
lua          local api = vim.api | local Config = require("hive.config") | local M = {}
python       <module docstring> | import os | from flask import Flask | CONST = 1
typescript   import fs from "node:fs" | export { bar } from "./bar" | const K = 1
c            #include <stdio.h> | #define MAX 10 | typedef int myint;
```

Note it deliberately over-collects relative to a strict import list — `local api =
vim.api` is an alias rather than an import, `CONST = 1` is module state, `#define`
and `typedef` are neither — and that is the right call for a FIM prompt, because
all of them are names the completion may need to use. **The prologue boundary must
be keyed on `DECL_TYPES`, not on `field('body')`**, for the reason in §11.2: an
empty-bodied Lua function has no `body` field, so a body-keyed scan runs past it
and swallows the rest of the file.

### 11.3 Doc comments are siblings, not children

**The finding worth acting on first, because it fails silently.**

`function M.request` starts at `lua/hive/curl.lua:119`. Its LuaCATS block — nine
lines carrying every parameter and return type — occupies lines 110–118 and is
**not inside the `function_declaration` node**. A cut of the node range drops the
most information-dense text in the file and the prompt still looks fine.

```lua
local first = fn:start()
local n = fn
while true do
  local prev = n:prev_named_sibling()
  if not prev or prev:type() ~= 'comment' then break end
  local _, _, prev_end = prev:range()
  if prev_end < first - 1 then break end   -- blank line: not attached
  first, n = prev:start(), prev
end
```

The `prev_end < first - 1` guard is the whole trick; without it the walk keeps
climbing through unrelated comments further up the file. Re-measured against the
current `curl.lua`: consumes exactly 9 comments and stops at row 109.

**Python is the exception.** A docstring is the first statement *of the body*, so
it is inside the node and this walk must be skipped — two opposite bugs from one
naive implementation.

**LSP disagrees, by specification.** `lsp.DocumentSymbol.range` is *"the range
enclosing this symbol not including leading/trailing whitespace but everything
else like comments"* (`lsp/_meta/protocol.lua:1336`; the "comments and code"
wording belongs to `CallHierarchyItem.range`, `:212`). So treesitter and
LSP put the start of a function in different places. Normalize to one convention
before mixing them in a prompt.

### 11.4 Injected languages — the hazard that became a feature

`LanguageTree:language_for_range` (`languagetree.lua:1444`) gives the real
language at a position. Measured on a markdown buffer with a fenced Lua block:

| Row | Content | `language_for_range` |
| --- | --- | --- |
| 0 | `# t` | `markdown` |
| 3 | `local x = 1` inside a ` ```lua ` fence | `lua` |
| 6 | plain prose | `markdown_inline` |

**`parse()` alone is not enough.** Injections only exist after `parse(true)`,
which parses the child trees too; without it every row above reports `markdown`.
That is a third silent-wrong-answer case alongside §11.2's two.

Two consequences. The enclosing node must come from the *injected* tree, via
`tree_for_range` (`:1394`) or `node_for_range` (`:1421`), not the root parser.
And the output is a **parser** name, not a language name — row 6's
`markdown_inline` shows why it must be mapped before going in a prompt.

`IMPLEMENTATION.md` §3.3 turns this mechanism into the reason the session buffer
is markdown: prose regions get `markdown_inline`, fenced regions get the target
language, so region 2 and region 3 highlight correctly and are parseable as real
code with no extra work.

### 11.5 Parse cost is not a reason to avoid any of this

Re-measured on `lua/hive/curl.lua`, 152 lines, best of repeated runs:

| Operation | Measured |
| --- | --- |
| `get_parser()`, parser already loaded in-process, `lua` | 0.004–0.009 ms |
| `get_parser()`, already loaded, `python` (not runtime-bundled) | 0.051–0.077 ms |
| `get_parser()`, genuinely cold first call in a fresh process | ~3 ms `lua`, ~6–10 ms `python` |
| first `parse()` | 0.47–0.50 ms |
| `parse()` with no edit since | 0.0006 ms |
| `parse()` after a one-character insert | **0.090 ms** median |

An earlier pass recorded 22 ms for `get_parser()`; that does not reproduce — the
`.so` is `dlopen`ed, not compiled. Re-measured 2026-08-21: a genuinely cold
first call is ~3 ms (`lua`) / ~6–10 ms (`python`), so the sub-0.1 ms rows are
the warm path, and bundled-vs-site is ~2× cold rather than ~10×. Still an order
of magnitude under the retracted number, and it happens once per buffer.

**The number that matters is 0.090 ms.** There is no budget argument for keeping a
stale tree, debouncing the parse, or pre-loading a parser.

### 11.6 Query supply

Core ships queries for seven languages only (`c`, `lua`, `markdown`,
`markdown_inline`, `query`, `vim`, `vimdoc`). Counts of language directories
carrying each query **on disk**:

| Query | Core | nvim-treesitter | tree-sitter-manager |
| --- | --- | --- | --- |
| `folds` | 5 | 224 | 225 |
| `locals` | 0 | 151 | 153 |
| `textobjects` | **0** | **0** | **0** |

**`textobjects.scm` is not here.** `@function.outer` and `@class.outer` are the
obvious cross-language way to name constructs and nothing on this machine supplies
them, including tree-sitter-manager's 332-language bundle. Using them means adding
a dependency, not using what is present. §11.2's declaration-type table (five
languages measured, the rest reasoned) is the cheap substitute.

Read queries through core — `vim.treesitter.query.get(lang, name)`
(`treesitter/query.lua:290`, memoized) resolves from the rtp, so both plugins are
just files and hive imports neither Lua API. **But read §11.6.1 before relying on
the non-core columns above.**

### 11.6.1 The correction: those queries are not on the rtp

**The most implementation-relevant finding in §11.** The table above counts files
on disk. What `query.get` can load is much smaller, and it does **not** include
`locals` for Lua — the language hive is written in.

```
queries[lua]         highlights=true folds=true indents=false locals=false textobjects=false
queries[python]      highlights=true folds=true indents=true  locals=true  textobjects=false
queries[typescript]  highlights=true folds=true indents=true  locals=true  textobjects=false
queries[c]           highlights=true folds=true indents=true  locals=true  textobjects=false
```

`nvim_get_runtime_file('queries/lua/locals.scm', true)` returns `{}`;
`queries/lua/folds.scm` resolves to exactly one path, and it is core's.

Three independent reasons:

1. **Both plugins keep queries under `<plugin>/runtime/queries/`, not
   `<plugin>/queries/`.** lazy.nvim puts `<plugin>` on the rtp, so the search path
   becomes `<plugin>/queries/<lang>/<name>.scm`, which does not exist. Both plugin
   roots are on the rtp and neither contributes a single query file.
2. **`<plugin>/runtime/queries/` is an installer's *source*.** nvim-treesitter
   copies out of it into `install_dir`, defaulting to `stdpath('data')/site`
   (`config.lua:10`) — already on the rtp, which is why `setup()`'s rtp line
   (`config.lua:19`) only matters for a custom path. Nothing was installed through
   it here because this config declares it `lazy = false` with **no `config`,
   `opts` or `setup()` call at all**. It is on the rtp and inert — and archived
   upstream, so it will not grow a fix.
3. **tree-sitter-manager supplies queries per installed language, by symlink.**
   `installer.lua:22` `copy_queries()` symlinks
   `<plugin>/runtime/queries/<lang>` into `stdpath('data')/site/queries/<lang>`.
   Today that is 8 symlinks — `c`, `ecma`, `html`, `html_tags`, `jsx`, `python`,
   `tsx`, `typescript` — matching the 5 installed parsers plus shared includes.

**`lua` is absent because the Lua parser ships with the runtime**, so it was never
installed through the manager and nothing created the symlink. That is the trap:
*the language whose parser is most certainly present has the thinnest query
supply.*

**The fix hive ships: vendor the `.scm` files.** Verified — dropping a copy into a
`queries/lua/` directory on the rtp makes `query.get('lua', 'locals')` resolve to
it, and lazy.nvim already puts hive's root on the rtp, so no code is required.
`query.get` is memoized, so a query added mid-session needs
`vim.treesitter.query.get:clear()` (which is exactly what tree-sitter-manager
calls at `installer.lua:150` after an install).

**`vim.treesitter.query.get(lang, name) == nil` is a normal runtime state, not an
install error.** Every call site needs a nil branch.

### 11.7 `folds.scm` is the free language-agnostic chunker

The reachable count is core's 5 languages, not the 224 on disk — but `folds` is
the one non-trivial query reachable for Lua at all, it comes from core, and it
needs no plugin API.

Core's Lua `folds.scm` captures `do_statement`, `while_statement`,
`repeat_statement`, `if_statement`, `for_statement`, `function_declaration`,
`function_definition`, `parameters`, `arguments` and `table_constructor` as
`@fold`. Measured on `curl.lua`: **55 captures, 13 spanning more than three
lines.** Coarser than textobjects — `parameters` and `arguments` are
structurally uninteresting, and there is no capture name to tell a function from a
loop — but good enough to answer *"give me the next-largest complete construct"*.
(v1 later cut `folds` from region 3's strategy ladder — the fold-as-unit step
was never fully specified — so this survives as `IMPLEMENTATION.md` §7.3's R2
chunker only; revisit for the ML/homoiconic families.)

### 11.8 `locals.scm` is the discovery trigger

The interesting question for region 2 is not "what is near the cursor" but "what
does this code use that is defined somewhere else". `locals.scm` answers it with
no language server: collect `@local.scope` and `@local.definition.*`, then any
`@local.reference` with no matching definition in an enclosing scope is a
candidate.

Measured on `curl.lua` (query loaded by hand, per §11.6.1): 16 scopes, 24
distinct definitions, 151 `@local.reference` matches — those three counts are
file-wide. Restricting the *references* to `M.request`'s rows while resolving
bindings file-wide gives this free-reference set:

```
executable, fn, schedule, stdin, system, text, vim, wait
```

**Eight names, of which seven are fields of `vim`.** Both `lua/locals.scm:54` and
`python/locals.scm:124` are a bare `(identifier) @local.reference`, so every
identifier matches, field names included. Excluding identifiers that are the
`field` child of a `dot_index_expression` **or `method_index_expression`** —
`:wait()` is a method field, missed by the dot rule alone — (or `attribute` in
Python) leaves
`stdin, text, vim` — the right order of magnitude for a ranking key. The
field-side set here is `body, build_args, executable, fn, request, schedule,
system, timeout`.

There is no local reference implementation to copy: the earlier pass cited
`lua/arborist/locals.lua` and arborist is no longer installed;
tree-sitter-manager is an installer with no scope-resolution API. The query plus
the walk above is the whole of it.

### 11.9 What LSP adds, and what it costs

| Want | Method | Core wrapper |
| --- | --- | --- |
| file outline, nearby signatures | `textDocument/documentSymbol` | `lsp/buf.lua:918` |
| resolve a free identifier | `textDocument/definition`, `textDocument/hover` | `lsp/buf.lua:343`, `:75` |
| callers and callees | `callHierarchy/incomingCalls`, `outgoingCalls` | `lsp/buf.lua:1020`, `:1027` |

`DocumentSymbol.detail` is specified as *"More detail for this symbol, e.g the
signature of a function"* (`lsp/_meta/protocol.lua:1320`). That is a rendered
signature for every symbol in the file, hierarchical, for one request, with no
per-language query to maintain — **the best tokens-per-round-trip available**, and
what `IMPLEMENTATION.md` §7.1 uses.

**`detail` is optional in the spec and most servers do not populate it.**
Measured on three servers over equivalent files, plus `clangd` (22.x,
mason-installed and auto-enabled here) in the 2026-08-21 verification pass — the
C row the original survey missed:

| Server | `detail` | kinds | `offset_encoding` |
| --- | --- | --- | --- |
| `lua_ls` | `"function (req)"` — but **omits the name** | very noisy: every local, table element, and `for`/`if` block, the last two typed `Package` | utf-16 |
| `pyright` | **`nil` for every symbol** | clean: `Function`, `Class`, `Method`, `Variable` | utf-16 |
| `tsgo` | **`nil` for every symbol** | clean, but an arrow function assigned to a `const` is **`Variable`**, not `Function` | **utf-8** |
| `clangd` | populated but **omits the name**: `"int (int)"`, `"const int"` | clean and shallow; a `const` global is **`Variable`**, never `Constant` | **utf-8** |

Three consequences, none of which the original survey anticipated:

1. **Do not build stubs from `detail`.** Two of four servers return nothing, and
   the two that populate it (lua_ls, clangd) omit the symbol's name. Any
   renderer that pattern-matches lua_ls's `"function (…)"` shape produces empty
   output everywhere else.
2. **`kind` is not a portable filter for "is this callable".** On `tsgo`,
   `export const mul = (a, b) => …` is `Variable`. A filter of
   `Function|Method|Class|…` drops most of a modern TS codebase. Constants are
   just as unportable: lua_ls types plain locals by *value* (`local CONST = 42`
   is `Number`, strings `String`, tables `Object`) and clangd's `const` globals
   are `Variable`, never `Constant`.
3. **`offset_encoding` is per-client, not global** — lua_ls and pyright utf-16,
   clangd and tsgo utf-8. Read it off the client that answered, never assume
   (§4, §9.1).

**`textDocument/hover` is the portable signature source.** Same three files:

```
python  def helper       -> "```python\n(function) def helper(value: int) -> int\n```"
ts      const mul arrow  -> "```typescript\nconst mul: (a: number, b: number) => number\n```\nMultiplies."
ts      function add     -> "```typescript\nfunction add(a: number, b: number): number\n```\nAdds two numbers."
```

Clean, fenced, and on TS it carries the doc comment too. clangd is the shape
exception: heading-first markdown (`### function ...`) with the fenced signature
**last**, and fenced as `cpp` even for C — so extract the fenced block wherever
it sits, never "first line after the fence". The cost is one request
per symbol instead of one per file, which is why `IMPLEMENTATION.md` §7.1 uses
`documentSymbol` only as an *inventory* (what exists, where, what kind) and gets
the signature from either a treesitter slice (same file, free) or `hover`
(cross-file, capped and cached per `changedtick`).

Call hierarchy is the strongest cross-file signal and the most expensive: two
requests, and the results are positions that then have to be read. Cache per
`changedtick`, and never on a keystroke path.

*Retired:* `textDocument/selectionRange` as a semantic widen. §11.2's treesitter
walk covers the workbench's needs synchronously.

### 11.10 Recency signals — *retired*

See the note under §11.1.

### 11.11 `vim.lsp.inline_completion` — the `on_accept` seam only

`$VIMRUNTIME/lua/vim/lsp/inline_completion.lua` (499 lines, 15,110 bytes) ships
the LSP 3.18 `textDocument/inlineCompletion` feature as overlay text, with a
Copilot quickstart in its module docs at `:9`.

The earlier pass advised checking it *before* building a context builder, on the
grounds that fronting the model as a language server would let core handle buffer
sync, rendering, staleness and cancellation. **That advice is retired for this
design.** The workbench's entire value is a hand-assembled three-region prompt,
which no `textDocument/inlineCompletion` request can express, and
`IMPLEMENTATION.md` §0.2 declares it a non-goal.

What survives is the file as a reference for two things: `on_accept` as the
extension seam (§12.1), and `lcp()` at `:111` as the longest-common-prefix
helper for skipping text the user has already typed — both reused in
`IMPLEMENTATION.md` §10.2.

### 11.12 nvim-treesitter-context, aerial.nvim, textobjects — *retired*

Not installed here, and §11.2's declaration table plus §11.7's `folds.scm` cover
what they would have supplied.

### 11.13 Build order — *retired*

Superseded by `IMPLEMENTATION.md` §15.

