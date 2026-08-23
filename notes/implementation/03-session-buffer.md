# The session buffer, regions and target tracking — §3–§5

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 3. The session buffer

### 3.1 It is a real file, not a scratch buffer

**Decision:** `buftype = ""`, backed by a real path. Reasons:

- R1 is the user's intellectual work and must survive a restart (I2). Extmarks do
  not persist and nothing in Neovim persists them [R§12.10]; a real file is the
  only substrate that round-trips.
- `:w` then means what the user expects, with no `BufWriteCmd` shim.
- Measured: `buftype = ""` on a named buffer with `filetype = markdown` gives
  working treesitter injections (§3.3), which a `nofile` buffer with no name does
  not reliably get a filetype for.

Path: `<session.dir>/<slug>.hive.md`, where `slug` is derived from the target's
git root basename plus the target file's stem, e.g. `hive.nvim__curl.hive.md`.
`vim.fn.mkdir(dir, "p")` on first open.

### 3.2 Buffer-local options set on open

```lua
vim.bo[buf].filetype   = "markdown"
vim.bo[buf].swapfile   = false
vim.bo[buf].bufhidden  = "hide"
vim.wo[win].wrap       = true
vim.wo[win].linebreak  = true
vim.wo[win].conceallevel = 2   -- lets the fences be concealed later if wanted
vim.b[buf].hive_session = true -- the marker every autocmd and command tests
```

Do **not** set `modifiable = false` on R2/R3 to protect them. Measured: it blocks
`nvim_buf_set_lines` as well, so hive could not write its own regions. R2 and R3
are user-editable by design; a refresh overwrites them and that is the contract.

### 3.3 Why markdown

Measured on the scaffold below: `language_for_range` after `parse(true)` returns
`markdown_inline` for prose rows, and **`lua` for rows inside the ` ```lua `
fences** — so R2 and R3 get real target-language highlighting for free, via the
injection machinery in [R§11.4]. (The injected parse tree exists too, but
nothing in v1 consumes it — §6.5; the feature is the highlighting.) The
`parse(true)` requirement is the trap noted there: without it every row
reports `markdown`.

### 3.4 The scaffold

Written verbatim on first open of a new session file:

```markdown
# hive: notes

<!-- Your plan. What are you changing and why? hive never edits this section. -->


# hive: context

# hive: code
```

Region bodies are wrapped in fences when written by hive (§4.3). R1 is never
fenced.

---

## 4. The region model

### 4.1 Regions are located by scanning for the header lines

**Decision: no extmarks for region boundaries.** Measured three candidate designs:

| Design | Result |
| --- | --- |
| Two boundary extmarks, `right_gravity = true` | **Broken.** Replacing R2 with `set_lines(r2, r3, …)` deletes the span both marks sit on; both are pushed to the end, R2 collapses to empty and R1 swallows it. |
| Header-row extmarks, replace interior only | Works. |
| **Scan for the header lines** | Works, *and* detects the unrecoverable case instead of corrupting it. |

The scan wins on two counts the anchored-extmark version cannot match: it is
immune to [R§12.5] (a reload silently re-points extmarks at unrelated text, and
this buffer is a real file that will be reloaded), and when the user deletes the
scaffold the scan returns `nil` — a detectable, repairable state (§4.4) — where
extmarks would have returned confident nonsense. Cost is one `nvim_buf_get_lines`
per call, which for a few hundred lines is not worth caching.

### 4.2 `region.lua` API

```lua
---@class Hive.Region  { name, header_row, first, last }  -- 0-indexed; body is [first,last]
---@return Hive.Region?, Hive.Region?, Hive.Region?   notes, context, code
function M.locate(buf)
```

`locate` returns `nil` if any header is missing **or duplicated**. Duplication is
the case a naive first-match scan gets wrong: the user yanks a block containing
`# hive: code` and the scan silently picks the wrong one. Count matches; more than
one is a repair condition.

```lua
function M.read(buf, region)          --> string[]  body lines, fences stripped, blanks trimmed
function M.write(buf, region, lines)  --  replace the body; header untouched (I1)
function M.write_fenced(buf, region, lines, lang)
```

`write` computes `set_lines(header_row + 1, next_header_row, lines)`. Because the
header row itself is never in the replaced span, no boundary can be consumed.

Fence stripping in `read` is a two-rule filter, verified deterministic: drop lines
matching `^```` and trim leading/trailing blank lines. The rules are total and
deterministic but not lossless — measured, a body line that itself starts with
a fence (markdown inside a string literal) is dropped, and deliberate blank edge
lines are trimmed. Both are acceptable for generated R2/R3 bodies; nothing else
reads back differently from what was written.

### 4.3 Writing R2 and R3

Both are written fenced. **The fence label must be the treesitter parser name,
not the filetype** — `vim.treesitter.language.get_lang(ft)`. The *function* is
core's, but (verified) the mappings below are registered by nvim-treesitter's
and tree-sitter-manager's `plugin/filetypes.lua`; core's own default table maps
only `help`/`checkhealth`→`vimdoc`, so without either plugin on the rtp
`get_lang` returns every filetype unchanged and the fences carry filetype names.
Measured differences that matter: `sh`→`bash`, `cs`→`c_sharp`, `tex`→`latex`,
`ps1`→`powershell`, `jsx`/`javascriptreact`→`javascript`,
`typescriptreact`→**`tsx`**. `get_lang` returns the filetype unchanged when there
is no mapping, so it is always the right call. [R§11.4] flagged this as "the
output is a parser name and not a language name — map it before putting it in a
prompt"; this is that mapping, and it is also what makes §3.3's injection hold:

```
```lua
<body>
```
```

### 4.4 Repair

If `locate` returns `nil`, hive does **not** guess. `M.repair(buf)`:

1. If no header is present at all → append the §3.4 scaffold below whatever the
   buffer holds, treating the existing content as R1.
2. If some headers are present and unique → insert the missing ones, in canonical
   order, immediately before the first header that should follow them.
3. If any header is duplicated → notify with the line numbers and do nothing.
   This is the only unrecoverable case and it needs a human.

Every entry point (`refresh`, `submit`, `accept`, `transplant`) calls `locate`,
and on `nil` calls `repair` then `locate` once more. A second failure aborts with an error
notification. This is invariant I7.

---

## 5. Target tracking

R3 mirrors "the relevant code around current cursor location" — but when the user
is *in* the session buffer, the cursor is not in any code. The target must
therefore be remembered, not read.

`target.lua` keeps one record per session buffer:

```lua
---@class Hive.Target
---@field bufnr integer
---@field path string          -- absolute, for reopening if the buffer is wiped
---@field row integer          -- 0-indexed
---@field col integer          -- byte column
---@field changedtick integer  -- of bufnr when captured
---@field filetype string
```

Capture rules, implemented as one autocmd group:

- `WinLeave` / `BufLeave` on any buffer where `vim.b.hive_session` is unset and
  `buftype == ""` → update the target for every open session buffer. This is the
  "last real code position you were at" semantics, which is what the workflow
  wants: you look at code, you switch to the workbench, the workbench is about
  the code you just left.
- `M.set(session_buf, target)` for the explicit `:Hive target` command.
- On `refresh`, if `target.bufnr` is no longer valid, reopen `target.path` with
  `vim.fn.bufadd` + `bufload` and re-resolve. If the path is gone, abort the
  refresh with a notification.

`target.changedtick` is compared on refresh; it is *not* a reason to abort (the
target legitimately changes) but it is recorded in the session buffer's
provenance so a stale R3 is identifiable.

