# Building R3 — the code region — §6

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 6. Building R3 — the code region

`extract.lua`. Input: a `Hive.Target`. Output:
`{ prefix_lines, suffix_lines, hole_row, hole_col, lang, strategy }`.

`strategy` is one of `"whole"`, `"unit"`, `"lines"` and is reported to
the user (§6.7) — a silently-degraded slice is the main way this component can be
wrong without looking wrong.

### 6.1 Parse explicitly

```lua
local parser = vim.treesitter.get_parser(target.bufnr)
if not parser then return nil, "no treesitter parser for " .. target.filetype end
parser:parse()
```

The explicit `parse()` is mandatory: `get_node()` on an unparsed tree returns a
wrong node and core documents it as such [R§11.2]. Cost is 0.09 ms for a
one-character edit and 0.5 ms cold [R§11.5], so there is nothing to debounce and
no reason to skip it.

Note the parser is needed only for strategy `unit`. `whole` (§6.2) and `lines`
need none, so a missing parser is not fatal — it caps the ladder.

### 6.2 The decision ladder — short files go in whole

Try in order, take the first that applies:

| # | Strategy | Condition |
| --- | --- | --- |
| 0 | **`whole`** | `code.whole_file.enabled` and the file is within *both* `max_lines` and `max_bytes` |
| 1 | `unit` | a parser exists, and §6.3 finds an enclosing declaration |
| 2 | `lines` | always |

(`folds` was cut from the R3 ladder for v1: which fold wins and where the hole
goes was never specified, and no test covered it. `folds.scm` survives as
§7.3's R2 fallback chunker; revisit for §6.7's ML/homoiconic families if line
windows prove too crude there.)

**Sending a short file whole is the biggest simplification available**, and it is
worth taking first because it makes every language-specific mechanism below
irrelevant for the files it covers:

- No `DECL_TYPES` entry needed, so it works at Tier 4 (§6.7) — Clojure, Haskell,
  JSON, YAML, a shell script.
- No doc-comment walk, so §6.3's wrapper and §6.4's prelude sets do not matter.
- No import extraction, because the imports are already in the payload (§6.8).
- No elision marker, so the model sees a file exactly as it is on disk, which is
  the distribution FIM training data is drawn from.

**Deriving the default.** Measured over 41 real Lua files (this repo plus the
user's Neovim config): median 17 lines, mean 35, p90 79, and **~30 bytes/line**.
At §8.3.1's measured 3.9 bytes/token that is ~7.7 tokens per line, so — against
`reserve.code` = **493 tokens** at the default budget (§8.3.3):

| Threshold | ≈ bytes | ≈ tokens | share of `reserve.code` (493) | corpus covered |
| --- | --- | --- | --- | --- |
| 24 lines | 720 | 185 | 38% | 54% |
| **60 lines** | **1800** | **462** | **94%** | **78%** |
| 80 lines | 2400 | 615 | 125% | 90% |
| 150 lines | 4500 | 1154 | 234% | 98% |

60 lines is the default: it is "a standard page" in the typesetting sense, it
covers most of a real corpus, and it is the **largest rung that still fits inside
`reserve.code`** on the §8.3.1 baseline. That the fit is 94% rather than 33% is
the whole difference between this budget and the 4096-token one it replaced —
here the ladder is genuinely bounded by the budget, and 80 lines would already
overflow it.

This rung needs no headroom for anything else: the whole-file path skips the
import block entirely (the imports are already in the payload), so it is the one
rung allowed to spend the code reserve down to the last token.

**On a GPU (§8.3.4), `reserve.code` is 2112 tokens and every rung in the table
fits.** There, 80 or even 150 lines becomes a free choice governed by context
quality rather than by the budget, and §8.3.4 raises `whole_file.max_bytes`
accordingly.

**Both limits must pass, and `max_bytes` is the real guard.** A 60-line file of
minified JavaScript, generated code, or long data literals can be hundreds of
kilobytes. Line count bounds *structure*; only bytes bound the *payload*. Compute
the byte count with `nvim_buf_get_offset(buf, line_count)` — it is O(1) and needs
no concatenation. Two measured skews, both harmless at a 4096-byte threshold: it
counts a phantom trailing newline on a `noeol` buffer (+1, conservative), and it
counts every EOL as one byte even under `fileformat=dos` (−1 per line versus the
CRLF payload).

```lua
local lines = api.nvim_buf_line_count(target.bufnr)
local bytes = api.nvim_buf_get_offset(target.bufnr, lines)
local w = Config.code.whole_file
if w.enabled and lines <= w.max_lines and bytes <= w.max_bytes then
  -- strategy = "whole": prefix is everything before the cursor, suffix after
end
```

Two details that make `whole` correct rather than merely convenient:

- **The hole still goes at the target cursor.** `whole` changes *what is
  included*, not where the model writes. `prefix_lines` is the file up to the
  cursor and `suffix_lines` is the rest, exactly as §6.5 splits a slice.
- **`whole` is reported, not silent.** It is a strictly better outcome than
  `unit`, but the user should know why R3 shows their entire file.

### 6.3 Find the enclosing unit

Only for strategy `unit`. For `code.unit == "function"`:

```lua
local node = vim.treesitter.get_node({ bufnr = target.bufnr, pos = { target.row, target.col } })
while node do
  if DECL_TYPES[lang][node:type()] then break end        -- type FIRST, see below
  if VALUE_FN[lang] and VALUE_FN[lang][node:type()] then
    -- bounded widen: every measured chain reaches NAME_HOLDER within two
    -- parents (variable_declarator/pair are direct parents; Lua's
    -- assignment_statement is two away, through expression_list). Unbounded,
    -- a callback nested inside `local cmd = {…}` would wrongly widen to the
    -- whole declaration.
    local holder = node:parent()
    if holder and not (NAME_HOLDER[lang] or {})[holder:type()] then holder = holder:parent() end
    if holder and (NAME_HOLDER[lang] or {})[holder:type()] then
      node = holder; break                               -- named value-position fn
    end
    -- no NAME_HOLDER within the bound: genuine anonymous lambda, keep climbing
  end
  node = node:parent()
end
```

**Test the declaration type first; `body` is optional.** This is the correction
that matters most for a FIM plugin [R§11.2]. Measured: in Lua, `field('body')` is
**`nil`** for `function M.f() end`, for a two-line empty body, for a
whitespace-only body, *and* for a comment-only body — because Lua's `block` is a
bare statement list, not a token-delimited region. C, TypeScript and Python all
emit the body node even when empty, because `{}` and an indented `pass` are still
nodes.

So a condition of `node:field("body")[1] and DECL_TYPES[...]` **climbs straight
past a freshly written empty function** and silently falls through to a line
window — and "I have written the signature, fill in the body" is precisely this
plugin's central use case. In Lua, which is also the language hive itself is
written in and the language its own test fixtures target.

The signature slice therefore needs a three-step fallback:

```lua
local function signature_end(node)
  local body = node:field("body")[1]
  if body then return body:start() end                       -- normal case
  local params = node:field("parameters")[1]
  if params then local _, _, er = params:range(); return er + 1 end
  local _, _, er = node:range(); return er + 1               -- unreached for measured langs; guards unmeasured grammars
end
```

`field('parameters')` is missing on C as well as `field('name')` — both live
inside `declarator`, measured `params=false` for `int f(void) {}`. But C never
*reaches* either fallback: its `function_definition` always carries a
`compound_statement` body, even for `{}` (a prototype is a `declaration` node, a
different type), so the body branch always fires for C. The branch an empty Lua
function takes is the second — Lua's `function_declaration` does carry
`parameters`. Measured 2026-08-21: the third branch is dead for every language
verified here; it stays as a guard for unmeasured grammars.

**Two more per-language sets are required, and without them TS/JS and Python are
broken** [R§11.2]:

```lua
-- climb through these before deciding; the declaration is their child.
-- lexical_declaration/variable_declaration: the widened unit for
-- `export const f = …` is a variable_declarator, whose path to the
-- export_statement runs through them (see the measured chains below)
local UNWRAP = {
  typescript = { export_statement = true, ambient_declaration = true,
                 lexical_declaration = true, variable_declaration = true },
  tsx        = { export_statement = true, lexical_declaration = true,
                 variable_declaration = true },
  javascript = { export_statement = true, lexical_declaration = true,
                 variable_declaration = true },
  python     = { decorated_definition = true },
  rust       = {}, go = {}, lua = {}, c = {},
}

-- a body-bearing node that is NOT a declaration, but IS the unit the user means;
-- its name lives on an ancestor, so the ancestor is what we slice from
local VALUE_FN = {
  typescript = { arrow_function = true, function_expression = true },
  tsx        = { arrow_function = true, function_expression = true },
  javascript = { arrow_function = true, function_expression = true },
  lua        = { function_definition = true },   -- only when named, see below
}
local NAME_HOLDER = {   -- ancestor to widen to, when a VALUE_FN was picked
  typescript = { variable_declarator = true, pair = true, public_field_definition = true },
  tsx        = { variable_declarator = true, pair = true, public_field_definition = true },
  javascript = { variable_declarator = true, pair = true },
  lua        = { assignment_statement = true, variable_declaration = true },
}
```

Measured nuance, accepted as-is: for `local f = function() end` the chain is
`function_definition < expression_list < assignment_statement <
variable_declaration`, and the widen stops at the inner `assignment_statement` —
the slice reads `f = function() end`, dropping only the `local` keyword. The
name is captured, which is what matters; `variable_declaration` stays in the
table for grammars where it is the first holder reached.

The walk becomes: climb ancestors testing the *type*, never the `body` field —
the pseudocode above is normative, per the correction just stated. The first
ancestor whose type is in `DECL_TYPES` is the unit; an ancestor whose type is in
`VALUE_FN` widens to a `NAME_HOLDER` ancestor **at most two parents up** (and if
there is none within that bound, it is a genuine anonymous lambda — keep
climbing, per [R§11.2]'s lambda trap). Then one explicit second step from the
chosen node:

```lua
local inner = node                 -- what §6.5 slices the body of
local outer = inner                -- what §6.4 walks siblings from
while outer:parent() and (UNWRAP[lang] or {})[outer:parent():type()] do
  outer = outer:parent()
end
```

**`outer` is what §6.4 walks siblings from**, and `inner` is what §6.5 slices
the body of.

Measured chains this is written against [R§11.2]:

| Source | first body-bearing ancestor | chosen unit | walk siblings from |
| --- | --- | --- | --- |
| `function add(…)` | `function_declaration` | same | itself |
| `export function add(…)` | `function_declaration` | same | `export_statement` |
| `export const add = (…) => {}` | `arrow_function` | `variable_declarator` | `export_statement` |
| `@route def handler(…)` | `function_definition` | same | `decorated_definition` |

Skipping the `UNWRAP` step is not a degradation, it is a silent wrong answer:
`prev_named_sibling()` on an exported declaration is `nil`, so §6.4 finds no doc
comment and reports success.

If no enclosing unit is found (top-level code, an unlisted filetype, or a language
with no `body`-bearing declaration node at all — see §6.7), fall back to
`code.unit == "lines"`: `lines_before` / `lines_after` around the cursor. That is
a *declared* degradation, and §6.7 requires it be reported.

### 6.4 Extend upward over attached doc comments

Only when `code.include_doc_comments`. This is [R§11.3] verbatim, and the
blank-line guard is the whole trick:

The walk starts from the **unwrapped outer node** of §6.3, not the declaration,
and accepts a per-language *prelude* set, not just `comment`:

```lua
local PRELUDE = {
  lua        = { comment = true },
  c          = { comment = true },
  cpp        = { comment = true, attribute_declaration = true },
  go         = { comment = true },
  python     = { comment = true, decorator = true },
  rust       = { line_comment = true, block_comment = true, attribute_item = true },
  typescript = { comment = true, decorator = true },
  tsx        = { comment = true, decorator = true },
  javascript = { comment = true, decorator = true },
  java       = { line_comment = true, block_comment = true, marker_annotation = true, annotation = true },
  c_sharp    = { comment = true, attribute_list = true },
}

local accept = PRELUDE[lang] or { comment = true }
local first = outer:start()
local n = outer
while true do
  local prev = n:prev_named_sibling()
  if not prev or not accept[prev:type()] then break end
  local _, _, prev_end = prev:range()
  if prev_end < first - 1 then break end  -- a blank line means "not attached"
  first, n = prev:start(), prev
end
```

Two things this buys. **Rust's `///` doc comments are `line_comment`, not
`comment`** — a hardcoded `"comment"` test finds nothing on Rust. And a Python
`@app.route("/x")` is frequently the single most informative line about what a
function *is*; measured, `prev_named_sibling()` of a decorated `function_definition`
is `decorator`, so a comment-only test stops there and drops both the decorators
and any comment above them. (`java`/`c_sharp`/`cpp` rows are reasoned from grammar
shape, not measured here — no parser installed. §6.7 marks them Tier 3.)

Measured on `lua/hive/curl.lua`: consumes exactly the nine LuaCATS lines above
`M.request` and stops at row 109. Without this, a cut of the node range drops the
most information-dense text in the file and the prompt still looks fine.

**Python is the opposite case** [R§11.3]: the docstring is the first statement
*inside* the body, so it is already included and this walk must be skipped.
Gate on `target.filetype ~= "python"`.

### 6.5 Place the hole

The hole is the target cursor, expressed relative to the extracted slice:

```lua
hole_row = target.row - first
hole_col = target.col
```

Extract with `nvim_buf_get_lines(bufnr, first, last + 1, true)` — `strict_indexing = true`,
per [R§1]. Split at the hole:

- `prefix_lines` = slice rows `[0, hole_row)` plus `line[hole_row]:sub(1, hole_col)`
- `suffix_lines` = `line[hole_row]:sub(hole_col + 1)` plus rows `(hole_row, end]`

R3's rendered body is `prefix .. HOLE_MARKER .. suffix`. The marker is what §10.1
replaces with the model output, and being a comment keeps R3 reading — and
highlighting — as plain code. Nothing in v1 consumes R3's injected parse tree
(§3.3), so this is cosmetic, not load-bearing. Build it from `'commentstring'`,
never a hardcoded leader:

```lua
local cs = vim.bo[target.bufnr].commentstring
local marker = (cs ~= "" and cs:find("%%s"))
  and cs:format("<hive:hole>")     -- "-- <hive:hole>", "# …", "<!-- … -->"
  or  "<hive:hole>"                -- no comment syntax: bare sentinel
```

Measured across 28 filetypes: `commentstring` is correct for every mainstream
language (`lua` `-- %s`, `python`/`ruby`/`sh`/`yaml`/`nix` `# %s`, the C family
`// %s`, `html` `<!-- %s -->`, `css` `/* %s */`, `ocaml` `(* %s *)`, `erlang`
`% %s`, `clojure` `; %s`, `vim` `"%s`) — but it is **empty for `json`**, which has
no comment syntax at all, and empty for a buffer whose filetype is literally
`tsx` — a parser name, not a filetype: no `ftplugin/tsx.*` exists anywhere on
the rtp, while a real `.tsx` file gets filetype `typescriptreact` and `// %s`.
Hence the bare-sentinel fallback. A bare sentinel merely degrades R3's
highlighting for that request; §7.3's signature slicing runs against the
*target* buffer, never R3, so nothing functional is lost.

### 6.6 Byte-exactness

When R3 is later transplanted back (§10.4), the text must round-trip. Follow
[R§1] and take the line ending from the *target* buffer, not `\n`:

```lua
local ENDINGS = { unix = "\n", dos = "\r\n", mac = "\r" }
local eol = ENDINGS[vim.bo[target.bufnr].fileformat]
```

The session buffer itself is always `unix`. R3's body is stored LF-joined and
re-joined with `eol` only at transplant time. `'endofline'` and `'bomb'` are
irrelevant here because R3 is a mid-file slice, never a whole file — this is the
one place [R§1]'s full ceremony is *not* needed, and the reason is worth writing
in a comment so nobody "fixes" it.

---

### 6.7 Language support is tiered, and the tier must be visible

The architecture is **not** language-agnostic, and pretending otherwise is how it
would ship silently-degraded output. It rests on one structural assumption:

> the thing the user is editing is enclosed by a *named declaration node with a
> `body` field*, and its documentation is a *preceding sibling* of that node or of
> a known wrapper around it.

That is true of block-structured, statement-oriented languages and false of
several whole families. So support is tiered, `code.unit` degrades in a defined
order, and **the active tier is reported** — in `:checkhealth hive` and once per
session in the session buffer's `# hive: code` header.

| Tier | What works | Requires |
| --- | --- | --- |
| **1 — full** | enclosing declaration, doc/prelude capture, signature slice, sibling signatures, free-identifier ranking | a `DECL_TYPES` entry, a `PRELUDE` entry, and a vendored or installed `locals.scm` |
| **2 — structural** | enclosing declaration + signature slice; prelude falls back to `comment`; ranking falls back to proximity | a `DECL_TYPES` entry and a parser |
| **3 — folds (R2 only in v1)** | R3 uses a `lines` window; `folds.scm` still chunks the treesitter R2 path (§7.3) | a parser and a reachable `folds.scm` |
| **4 — lines** | `lines_before`/`lines_after` window around the cursor | a parser, or nothing at all |

Tier 4 is never an error. A plain-text or JSON buffer is a legitimate target and
a line window plus R1's prose is still a usable FIM prompt — it is just not
*structured* context, and the user should know which they are getting.

**§6.2's `whole` strategy is orthogonal to the tier and outranks all of it.** A
60-line Clojure, Haskell or YAML file is sent complete and correct at Tier 4,
because no language-specific mechanism is involved — the file *is* the context.
Measured against a real corpus, that covers 78% of files (§6.2), so for a large
class of projects the tier below never comes up. **Tier only describes what
happens to files too big to send whole.** Report both: `strategy=whole` alongside
`tier=4` is a good outcome, not a contradiction.

The import block (§6.8) sits between the two: strategy A needs an `IMPORT_TYPES`
entry, but strategy B — the prologue — needs only a `DECL_TYPES` entry to find its
boundary, so any Tier 2 language gets imports. A Tier 3/4 language gets none, and
that is the sharpest practical cost of a low tier.

**Verified Tier 1 on this machine:** `lua`, `python`, `typescript`, `tsx`, `c` —
these are the five parsers installed here, and every table entry for them in
§6.3, §6.4 and §7.1 was measured. `python` needs its two special cases (docstring
inside the body, decorators in the prelude) and both are implemented.

**Tier 2 by construction:** `javascript`, `rust`, `go`, `cpp`, `java`, `c_sharp`,
`ruby` — `DECL_TYPES` and `PRELUDE` entries are written for all of them, from
grammar shape rather than measurement. Promote each to Tier 1 by installing the
parser and re-running `tests/extract_spec.lua`'s fixture for it; the fixtures are
written so that a missing parser skips rather than fails.

**Known Tier 3 or worse, and why** — these are not gaps to close later, they are
languages where the central assumption does not hold:

- **Expression-oriented / ML-family** — Haskell, OCaml, F#, Elm, Nix, PureScript.
  A definition is an equation or a `let` binding, often several clauses that are
  siblings of each other, with no single node spanning "the function". `folds.scm`
  is the honest unit here.
- **Homoiconic** — Clojure, Fennel, Scheme, Common Lisp. Everything is a list;
  `(defn foo [] …)` has no `body` field because the grammar does not distinguish
  a definition from any other call. Tier 3, and `folds.scm` happens to work well
  because a top-level form *is* the fold.
- **Macro-defined definitions** — Elixir (`def foo do … end` is a macro call, so
  the node is `call` with a `do_block`), and Rust items inside `macro_rules!`.
  A `DECL_TYPES` entry can be written for Elixir's specific shape; the general
  case cannot.
- **Clause-per-line** — Erlang, Prolog. Same problem as the ML family.
- **Markup and data** — HTML, CSS, JSON, YAML, TOML, Markdown. No functions.
  Tier 3 via `folds.scm` where it exists (HTML/CSS do), Tier 4 otherwise. JSON
  additionally has no comment syntax, so §6.5's bare-sentinel fallback applies.

**Template and multi-language files are a separate axis and are Tier 3 at best.**
Vue, Svelte, Astro, JSX-in-Markdown, ERB/EEx, Django templates, and Rust with
inline SQL all mean the target cursor may sit in an *injected* language. Per
[R§11.4] the enclosing node must then come from `tree_for_range` /
`node_for_range` on the injected tree, not the root parser — but two things do not
follow:

1. **The LSP is attached to the host file, not the injection.** `documentSymbol`
   for a `.vue` file will not describe the `<script>` block the way a `.ts` file's
   would, so §7.1's inventory is weaker or empty.
2. **The FIM prompt has two plausible language tags** — the host's and the
   injection's — and the model conditions on whichever it is given. §8.2 uses the
   injected language via `language_for_range`, because that is the language the
   hole is in, and records the host in the `<|file_sep|>` filename so the model
   still sees `Component.vue`.

For v1 the rule is: **detect the injection, use it, and report Tier 3.** Do not
attempt to merge host and injection context.

**What this means for `context.source`.** The LSP path (§7.1) is orthogonal to the
tier — it needs only a server that answers `documentSymbol`, and per §7.1 the
signature comes from `hover` or a treesitter slice rather than from `detail`, so
it works wherever an LSP does. A language can therefore be Tier 4 for R3 and
still have a rich R2, and vice versa. The two are reported separately.

### 6.8 The import / include block

Only for strategies `unit` and `lines` — a `whole` file already contains its
imports, and prepending them again would duplicate them.

The imports are what tells the model which names are in scope and under what
alias. Without them, a FIM completion inside a function will invent
`require("hive.util")` when the file already has `local Util = require("hive.util")`
three lines from the top, or reach for `os.path` in a file that imported
`from pathlib import Path`. It is the highest value-per-token context available
after the enclosing unit itself.

#### 6.8.1 Two collection strategies

**A — named import nodes**, where the grammar has them. Measured [R§11.2.1]:

```lua
local IMPORT_TYPES = {
  python     = { import_statement = true, import_from_statement = true,
                 future_import_statement = true },
  typescript = { import_statement = true },
  tsx        = { import_statement = true },
  javascript = { import_statement = true },
  c          = { preproc_include = true },
  cpp        = { preproc_include = true },
  -- reasoned from grammar shape, not measured here:
  rust       = { use_declaration = true },
  go         = { import_declaration = true },
  java       = { import_declaration = true },
  c_sharp    = { using_directive = true },
}
```

Two measured caveats:

- **TS/JS re-exports are `export_statement`, not `import_statement`** — but so is
  every ordinary `export function f(){}`. The discriminator is the `source` field:
  verified present on `export {bar} from "./bar"`, `export * from "./all"` and
  `export type {T} from "./t"`, and absent on `export function f(){}` and
  `export const x = 1`. So the rule is `IMPORT_TYPES[lang][t]` **or**
  (`t == "export_statement"` and `node:field("source")[1]`).
- **`preproc_include` ranges end at `end_col == 0` on the *following* row.**
  Measured `[0,0)-[1,0)` for `#include <stdio.h>`. Slicing with `end_row + 1`
  swallows the next line; use `end_row` when `end_col == 0`. Same newline fixup
  class as [R§11.2]'s `get_node_text` note.

**B — the file prologue**, for languages with no import node. **Lua is one of
them**, which matters because it is hive's own language: `local Config =
require("hive.config")` is an ordinary `variable_declaration`, structurally
identical to `local M = {}`. Ruby is the same shape.

The prologue is every top-level node before the first node whose type is in
`DECL_TYPES`:

```lua
local last = nil
-- unwrap(n): descend while n's type is in §6.3's UNWRAP, taking the wrapped
-- child (export_statement → its declaration) — the downward mirror of §6.3's
-- upward climb
for node in root:iter_children() do
  if node:named() then
    local inner = unwrap(node)
    if DECL_TYPES[lang][inner:type()] then break end
    local _, _, er, ec = node:range()
    last = (ec == 0) and er or er + 1
  end
end
```

**The boundary must be keyed on `DECL_TYPES`, not on `field("body")`.** Per §6.3,
an empty-bodied Lua function has no `body` field, so a body-keyed scan runs past
it and swallows the rest of the file — measured, that is exactly what happens.

Measured output, and it collects the right thing in all four languages:

```
lua          local api = vim.api | local Config = require("hive.config") | local M = {}
python       <module docstring> | import os | from flask import Flask | CONST = 1
typescript   import fs from "node:fs" | export { bar } from "./bar" | const K = 1
c            #include <stdio.h> | #define MAX 10 | typedef int myint;
```

It deliberately over-collects relative to a strict import list — `local api =
vim.api` is an alias, `CONST = 1` is module state, `#define` and `typedef` are
neither — and that is correct here, because every one of them is a name the
completion may need to use. Strategy A is preferred where available only because
it is tighter, not because the prologue is wrong.

**Prefer A, fall back to B.** If `IMPORT_TYPES[lang]` exists, use it; if it yields
nothing *and* the file has a prologue, use the prologue anyway — a Python file
whose first import sits below a large `if TYPE_CHECKING:` block is better served
by B.

#### 6.8.2 Where it goes, and the elision marker

The import block is prepended to R3's **prefix**, because it is part of the same
file and that is where a FIM prefix expects it. Between it and the slice goes a
one-line elision marker, so the model is not told that the imports are adjacent
to the function:

```
<imports, up to code.imports.max_lines>
<comment leader> ... <N> lines elided ...
<the §6.3 slice, including its §6.4 prelude>
<HOLE_MARKER>
<suffix>
```

The marker uses the same `commentstring` mechanism as §6.5's hole marker, with the
same bare-sentinel fallback for `json` and friends. It is emitted **only when the
import block does not run straight into the slice** — if the enclosing unit begins
on the line after the prologue ends, there is nothing elided and the marker would
be a lie.

Over `code.imports.max_lines` (default 20 — retuned from 40 in §8.3.3 so the
block fits inside `reserve.code`), keep the **first** N lines and note
the count in the marker. First rather than last, because import blocks are
conventionally ordered stdlib → third-party → local, and the local ones a
completion is most likely to need are usually also the ones already visible near
the slice.

#### 6.8.3 Interaction with the budget

The import block is charged to `reserve.code` and is trimmed **before** the R3
slice, never after — §8.3.6's rule that the prefix nearest the hole is never
trimmed still holds, and imports are the furthest thing from it. If the imports
alone would exceed half the code reserve, drop them entirely and say so: a
half-truncated import block is actively misleading, because the model will read
the absence of an import as "that name is not available".

Concretely at the default budget: `reserve.code` is 493 tokens, so the drop
threshold is 246, and a 20-line block costs ~154 — it survives. This is only true
because §8.3.3 retuned `imports.max_lines` from 40 to 20; at 40 lines the block
costs ~308 tokens, clears the threshold on every submit, and `imports.enabled`
becomes a silent no-op on the non-whole-file path. If you raise the slice or the
import limit, re-check this inequality.

