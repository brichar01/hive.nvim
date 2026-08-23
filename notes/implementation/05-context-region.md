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


### 7.4 Consumers — what calls the target

§7.1–§7.3 answer *what the target's code refers to*. They do not answer the
inverse — **what refers to the target** — and for a FIM plugin that is the
stronger of the two signals: a call site fixes the arity, the argument shapes and
what the return value is used for, which is precisely what a model filling in a
function body otherwise has to guess.

Enabled by `context.consumers.enabled`, capped by `context.consumers.max`. It
applies only when §6.3 found an enclosing declaration — strategy `unit`. Under
`whole` there is nothing to be a consumer *of* that is not already on screen, and
under `lines` there is no named unit to ask about.

**The request is `textDocument/references`, not `callHierarchy/incomingCalls`.**
Measured 2026-08-23 by `scripts/measure/consumers.lua` against the four servers
of [R§11.9]:

| Server | prepare + incomingCalls | `from.range` | references | sees an unsaved caller |
| --- | --- | --- | --- | --- |
| `lua_ls` 3.18.2-dev | **`-32601` method not found** | — | 205 ms | yes |
| `pyright` 1.1.411 | 6 + 1 ms | name only | 18 ms | yes |
| `tsgo` 7.0.0-dev | 1 + 1 ms | **full body** | 1 ms | yes |
| `clangd` 22.1.6 | 1 + 1 ms | name only | 1 ms | yes |

Three results decide it:

1. **`lua_ls` does not implement call hierarchy at all.** `callHierarchyProvider`
   is absent from its capabilities and `prepareCallHierarchy` answers `-32601`.
   This is §7.2's pattern again — the language hive is written in is the one that
   cannot — and it is disqualifying on its own. `references` works there, and
   everywhere.
2. **`CallHierarchyItem.range` is not a portable way to slice the caller.** The
   spec calls it "the range enclosing this symbol", which reads as the caller's
   whole body, and tsgo does return that. pyright and clangd return the caller's
   *name identifier only* — byte-identical to `selectionRange`. A renderer built
   on `from.range` prints a whole function on TypeScript and a bare word on
   Python and C. This is `DocumentSymbol.detail` all over again (§7.1): an
   optional-shaped field that no two servers agree on.
3. **Only `fromRanges` — the call site — is consistent across all three servers
   that answer**, and the call site is what we wanted. `references` returns
   exactly those positions in **one** round trip instead of two.

What `incomingCalls` buys over `references` is the caller's *identity*
(`from.name`, with several call sites grouped under one caller) and a filter that
drops non-call references — pyright's `references` includes the
`from helper import helper` line; `incomingCalls` does not. Both are real, and
neither is worth a second round trip plus a capability check that a quarter of
the measured ecosystem fails. Keep it as an optional upgrade behind
`caps.callHierarchyProvider` if the caller's name ever proves worth rendering;
`references` is the path that ships.

**The position to ask about is already computed.** §6.3 ends holding `inner`, the
enclosing declaration, and its name node is what `field("name")` — or
`NAME_HOLDER`, for the value-position case — already resolves for every measured
grammar. Ask at the *name*, never at the cursor: the cursor is inside the body,
where the answer is the enclosing scope rather than the function. §7.1's
per-client `offset_encoding` rule applies unchanged in both directions — the
position sent is converted from a byte column, and every returned range is
converted back through `vim.str_byteindex` against the *caller's* file before it
touches a buffer position.

**Unsaved buffers work, and that matters more than it sounds.** Appending a new
caller to a modified, never-written buffer moved lua_ls's reference count 2 → 3,
tsgo's 1 → 2, pyright's 3 → 5 and clangd's 2 → 4, with the file on disk unchanged
throughout. The requirement is that the caller buffer be **open and attached to
the same client**; an unopened file is served from the server's own index, which
reflects disk — correct, because an unopened file cannot have been modified. No
special handling is needed for this, but the reader below must respect the same
split.

> Measured wrong once, recorded so it is not re-measured wrong: the first pass
> appended a call to a symbol that was never imported into the caller file,
> measured zero consumers on two servers, and nearly concluded that unsaved
> buffers do not participate at all. The appended call must reference a symbol
> already in scope there. `scripts/measure/consumers.lua` carries the fixture
> that gets this right.

**Reading the caller.** This is the one genuinely new mechanism — nothing in
§7.1–§7.3 reads a file it did not already have. Per result:

- If the URI resolves to a **loaded** buffer, read its lines with
  `nvim_buf_get_lines`. Reading disk there would render a call site that no
  longer exists at that row.
- Otherwise read from disk. Do **not** `bufadd`/`bufload` it: loading a buffer to
  read three lines attaches every autocmd and language server in the user's
  config to it, and R2 is rebuilt on `CursorHold`.

**Widening one position into a snippet.** A `fromRange` covers the callee's
identifier inside the call, so the start line alone truncates any call whose
arguments wrap. In order:

1. If a treesitter parser exists for the caller's filetype, parse it and take the
   smallest ancestor of the position whose type is a call — `call`,
   `call_expression`, `function_call`. Free, exact, and it handles the wrapped
   case by construction.
2. Otherwise take the start line plus following lines until brackets balance,
   capped at `consumers.max_lines`. Crude, but it is only reached for a language
   with no parser — which is a language R3 is already handling at Tier 4 (§6.7).

Prepend the enclosing caller's own signature line only when it is free: when path
1 was taken and an ancestor is in §6.3's `DECL_TYPES`, slice it with
`signature_end`. That is what `incomingCalls`' `from.name` would have given, at
no extra request.

**Filtering, in this order:**

1. Drop results whose range is inside R3's own slice. Recursive calls and the
   declaration itself are already in the prompt — the same rule as §7.1 step 3,
   and what makes `includeDeclaration = false` a first pass rather than the whole
   filter.
2. Drop import and re-export lines. §6.8's `imports` extractor already knows
   these shapes per language; reuse its discriminator rather than writing a
   second one. This is the noise `incomingCalls` would have filtered for us.
3. **Sort by `(uri, line, character)`.** Neither request promises a stable result
   order, and §8.3.1 measures a 6x prefill penalty when anything above R3 changes
   between submits. An unsorted consumer list is exactly the "reordered symbol
   list" that section forbids.
4. Take the first `consumers.max`.

**Budget.** A widened call site is one to three lines — roughly 10–30 tokens
against a `reserve.context` of 269 at the default budget (§8.3.3). Three
consumers is 11–33% of R2, taken from ranked stubs, which is why it needs its own
cap rather than sharing `max_symbols`. §8.3.6 places it in the trim order and
§8.2 in the layout.

**It returns nothing more often than it returns something.** A function with no
callers yet has no consumers — measured 0 on both tsgo and pyright for a freshly
written declaration in an unsaved buffer. So this contributes nothing in the
write-a-new-function case and everything in the fill-in-an-existing-one case.
That asymmetry is acceptable, but it must not read as a failure: report consumers
as *absent*, never as an error, and never let the request hold up a refresh.
§7.1's fire-and-forget rule applies unchanged — one request, `context.lsp_timeout`,
degrade to empty.

**No LSP (`context.source == "treesitter"`).** Same-file consumers need neither a
query nor a server: walk the tree for call nodes whose function identifier
matches the target's name, then widen and render exactly as above. Cross-file
consumers are out of reach, which is the limitation §7.3 already accepts for the
whole treesitter path.
