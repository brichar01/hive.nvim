# Building R2 — the context region — §7

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 7. Building R2 — the context region

`discover.lua`. Input: the target and R3's extracted slice. Output: stub lines.

### 7.1 LSP path (`context.source == "lsp"`)

One request: `textDocument/documentSymbol`. It is the best tokens-per-round-trip
of the options in [R§11.9] because `DocumentSymbol.detail` is specified as a
rendered signature.

Measured against `lua-language-server` on `lua/hive/curl.lua` — it works, and it
is **far noisier than [R§11.9] implies**, which is the gap this section closes:

```
M.build_args      kind=Function   detail="function (req)"        rows 39-72
  req             kind=Constant   detail=""
  timeout         kind=Variable   detail=""
  cmd             kind=Array      detail='["curl", "--silent", …]'
    [1]           kind=String     detail='"curl"'
    …
  for             kind=Package    detail=" for _, name in"
  if              kind=Package    detail="if req.body then"
MARKER            kind=String     detail="[[\n__hive_status__:]]"
CURL_ERRORS       kind=Object     detail="{[3], [6], [7], …}"
```

Every local, every table element, and every `for`/`if` block arrives as a symbol,
`if` and `for` typed as `Package`. Unfiltered this is dozens of useless symbols
for a 152-line file and would consume the entire R2 budget on string literals.

So the filter is not optional:

1. Keep only symbols whose `SymbolKind` name is in `context.kinds`.
2. Descend `children` at most `context.max_depth` levels (default 1), and never
   descend into a `Function`/`Method` — its children are its locals.
3. Drop symbols whose range is *inside* R3's own slice; R3 already shows them.
4. Rank the remainder and take `max_symbols`: symbols referenced by R3's free
   identifiers (§7.2) first, then by proximity to the target row.

**`documentSymbol` supplies the inventory, never the signature.** Measured on
four servers [R§11.9], `detail` is `nil` on pyright and tsgo, and populated but
*name-omitting* on lua_ls (`"function (req)"`) and clangd (`"int (int)"`) — it
is optional in the spec and no two servers agree on its shape. So a stub
renderer built on `detail` produces empty or nameless output on most of the
ecosystem. Two portable sources instead, in order of cost:

1. **Same-file symbols: slice the signature with treesitter.** For each kept
   symbol, take its `range.start`, find the node there, and cut
   `node:start()` → `body:start()` exactly as §6.3 does. Free, no request, and it
   is byte-identical to what the user would read in the file.
2. **Cross-file symbols: `textDocument/hover`.** Verified portable — pyright gives
   ``` ```python\n(function) def helper(value: int) -> int\n``` ```, tsgo gives
   ``` ```typescript\nconst mul: (a: number, b: number) => number\n``` ``` plus
   the doc comment. clangd differs in *shape*: heading-first markdown with the
   fenced signature **last**, fenced as `cpp` even for C. So the rule is:
   extract the fenced block wherever it sits and keep its signature line (plus
   the doc paragraph when present) — never "strip the fence, keep the first
   line". Cost is one request per symbol, so cap it at `max_symbols`, run it off
   the keystroke path, and cache per `changedtick` [R§11.9].

**The kind filter is not portable either.** Measured on tsgo,
`export const mul = (a, b) => …` comes back as **`Variable`**, not `Function`. A
filter of `Function|Method|Class|…` therefore drops most of a modern TS codebase —
the same blind spot §6.3's `VALUE_FN` set fixes on the treesitter side. So
`context.kinds` must include `Variable` and `Constant`, and a second test decides
callability. Measured (2026-08-21): the node at the symbol's range **never**
carries the `body` field itself — tsgo's range for `export const mul` spans
identifier→expression and lands on `variable_declarator` (`body` absent); the
`body` lives one level down, on the declarator's *value child*
(`arrow_function`). So the check is: from the node at `range.start`, climb to
the enclosing §6.3 `NAME_HOLDER` node, then test its value-side child for a
`body` field (with §6.3's caveat that `body` is absent for an empty body). Still
one bounded treesitter lookup per candidate, and exact where the kind is a
guess. Two further kind wrinkles from the same pass: lua_ls types plain locals
by *value* (`local CONST = 42` is `Number`, strings `String`, tables `Object`),
so no kind filter sees lua_ls constants at all; and clangd reports `const`
globals as `Variable`, never `Constant`.

**`offset_encoding` is per-client.** Measured: lua_ls and pyright negotiate
utf-16, tsgo negotiates **utf-8**. Read it off the client that answered the
request — never a global, never an assumption. Every range must go through
`vim.str_byteindex` before it touches a buffer position [R§4]. This is the exact
bug [R§9.1] documents in copilot.lua, where a tautology collapsed the encoding to
utf-8 and every edit after a non-ASCII character landed in the wrong column.
Convert once, at the boundary, in `discover.lua`.

The request is fire-and-forget with a timeout: `client:request` with a
`vim.defer_fn` guard at `context.lsp_timeout`. **A slow or unindexed server must
degrade R2 to empty, never delay the refresh** — LSP has no synchronous mode
[R§11.1], and a refresh that waits on it would stall on every `CursorHold`.

### 7.2 Free identifiers, and the vendored queries

Ranking (step 4) needs to know which symbols R3 actually refers to. That is
`locals.scm`: collect `@local.reference`, drop those with a matching
`@local.definition` in an enclosing `@local.scope`, and the remainder is what R3
depends on from outside itself.

**This does not work out of the box and the plan must ship the fix.** Measured
[R§11.6.1]: `vim.treesitter.query.get("lua", "locals")` returns `nil` on this
machine. Core ships `locals.scm` for zero languages; `nvim-treesitter` is
installed but archived, never `setup()`-ed, and keeps its queries one directory
below where the rtp search looks; `tree-sitter-manager` supplies queries only for
languages installed through it, and Lua's parser is runtime-bundled so it never
was. **The language hive is written in has the thinnest query supply of any.**

So: vendor `queries/lua/locals.scm` and `queries/python/locals.scm` into the
plugin. Verified — dropping a `locals.scm` into a `queries/lua/` directory on the
rtp makes `query.get("lua", "locals")` resolve to it, and lazy.nvim already puts
hive's root on the rtp, so no code is needed. Two gotchas:

- `query.get` is memoized, so a query added mid-session needs
  `vim.treesitter.query.get:clear()`. Only relevant during development.
- **Filter the results.** `lua/locals.scm:54` and `python/locals.scm:124` are a
  bare `(identifier) @local.reference`, so every identifier matches, field names
  included. Measured on `M.request`: 8 free references, of which 7 are fields of
  `vim` — `executable, fn, schedule, stdin, system, text, vim, wait`. Excluding
  identifiers that are the `field` child of a `dot_index_expression` **or
  `method_index_expression`** (`:wait()` is a method field, missed by the dot
  rule alone — or `attribute` in Python) leaves `stdin, text, vim`, which is the
  right order of magnitude for a ranking key.

`query.get` returning `nil` is a normal runtime state for any language hive has
not vendored [R§11.6.1]. Every call site branches on it; the fallback is
proximity-only ranking.

### 7.3 Treesitter path (`context.source == "treesitter"`)

No LSP. Take the enclosing scope's other children that have a `body` field, and
slice each `start()` → `body:start()`. That is the signature of every sibling
function, with no query and no server, and it is fully synchronous. Weaker than
the LSP path — same-file only — but it has no failure mode.

`folds.scm` is the fallback chunker when no declaration is found: it is reachable
from core for Lua, C and markdown, covering `function_declaration`,
`function_definition`, `if_statement`, `for_statement` and others as `@fold`.
Measured on `curl.lua`: 55 captures, 13 over three lines. Filter to > 3 lines and
take the ones nearest the target.

