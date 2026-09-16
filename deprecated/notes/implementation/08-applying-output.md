# Applying the output — §10

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 10. Applying the output

### 10.1 Splicing into R3

The model returns the text for the hole. Applying it is a pure insertion at a
known position — the `HOLE_MARKER` line — so **the minimal edit is already known
and `vim.text.diff` must not be used here.** Measured [R§12.7]: a line-granular
diff of a region rewrite invalidates every provenance mark inside it, under all
four granularity strategies including conform's byte prefix/suffix shrink. Use
`nvim_buf_set_text` over the marker's exact range.

Provenance is stamped as part of the same operation, in a dedicated namespace:

```lua
local NS = vim.api.nvim_create_namespace("hive.prov")
vim.api.nvim_buf_set_extmark(buf, NS, srow, scol, {
  end_row = erow, end_col = ecol,
  invalidate = true,          -- goes "invalid" if the text is deleted
  hl_group = Config.ui.provenance_hl,
})
```

Three settings and one omission, all from [R§12.2, §12.3]:

- **Default gravity.** Leave `right_gravity` and `end_right_gravity` unset.
  Measured: the intuitive `right_gravity = false, end_right_gravity = true`
  "grow" configuration silently claims text the *user* types immediately before
  or after the generated region. The API defaults exclude adjacent typing on both
  sides, which is the honest answer to "did the model write this byte".
- **`invalidate = true`** with the default `undo_restore = true`: the mark reports
  `invalid` while the text is deleted and its exact range returns if the user
  undoes. Omitting `invalidate` is the trap — the mark collapses to zero width but
  still reports *valid*, so a query says "there is provenance here" pointing at
  nothing.
- **Do not use two point marks to bracket the insertion.** Measured: the
  right-hand mark absorbs text typed after the region. A single range extmark
  with default gravity already gets this right.

Every query passes `{ details = true, overlap = true }`. Measured [R§12.4]:
without `overlap`, a query at the *middle* of a marked region returns `{}` — it
works at the first byte and fails at every other, which reads like "provenance
mostly doesn't work" rather than like a missing flag.

Because the session buffer is a real file that will be reloaded, the reload guard
is mandatory [R§12.5] — a reload does not delete extmarks, it keeps them at their
byte coordinates and lets whatever text now occupies those coordinates inherit
the provenance:

```lua
vim.api.nvim_create_autocmd({ "BufReadPost", "FileChangedShellPost" }, {
  buffer = buf, group = Config.augroup,
  callback = function() vim.api.nvim_buf_clear_namespace(buf, NS, 0, -1) end,
})
```

Fail closed. Provenance is cheap to regenerate (the next submit re-stamps) and
confidently wrong provenance is worse than none.

### 10.2 Partial accept

`:Hive accept [word|line|all]`. The mechanic is to slice the *stored suggestion
text*, never the buffer:

```lua
local function slice(text, mode)
  if mode == "all"  then return text end
  if mode == "line" then return text:match("^[^\n]*\n?") or text end
  return text:match("^%s*[%w_]+") or text:match("^%s*%S") or text  -- word
end
```

State per session buffer: `{ remaining = <string>, row, col }`. Each accept
inserts `slice(remaining, mode)`, advances `row`/`col`, and sets
`remaining = remaining:sub(#chunk + 1)`. When `remaining == ""` the state clears.

Provenance is **one growing mark, not one per accept**: if a mark's `end_row`/
`end_col` equals the new insertion point, re-set it by `id` with a new end
instead of creating a second mark. Verified — accepting `pcall(require, "hive")`
a word at a time yields a single `id1` covering `pcall`, then `pcall(`, then
`pcall(require`.

Core's `lcp()` (`inline_completion.lua:105`) is the helper for skipping text the
user has already typed; reuse the idea rather than the private function.

### 10.3 Undo blocks

**`vim.cmd("let &undolevels=&undolevels")` before every accept, and once before
each refresh.** This is not stylistic. Measured [R§12.6]:

| Between three successive accepts | one undo removes |
| --- | --- |
| nothing | **all three** |
| `vim.wait(10)` | **all three** |
| `sleep 10m` | **all three** |
| `pcall(vim.cmd.undojoin)` | **all three** |
| `let &undolevels=&undolevels` | just the last |

Confirmed in real insert mode via `nvim_feedkeys`, and `nvim_paste` behaves the
same, so neither of core's two accept paths escapes it. Neither the passage of
time nor an event-loop turn separates undo blocks. Without the break, five
accepted words are one undo — which defeats the entire point of partial accept
(I6). conform's `pcall(vim.cmd.undojoin)` is exactly backwards for this use —
and measured, worse than no break at all: it merges the accepts into the
*preceding* undo block, taking the user's own prior edit with them. Right for a
formatter, wrong here.

Placement differs by operation:
- **accept** — break *before each* insertion. Each accept is its own undo step.
- **refresh** — one break before the R2+R3 replacement. A refresh is one logical
  act; `set_lines` calls inside it must collapse together.

### 10.4 Transplanting R3 back to the source

`:Hive transplant`. This is the step the workflow implies and it is where the
rewrite machinery in [R§4, §8.1, §12.7] is actually needed, because R3 has
diverged from the source by an unknown amount.

1. **Staleness guard first.** Compare `target.changedtick` against
   `vim.b[target.bufnr].changedtick`. If it moved, abort with a diff preview
   rather than applying — [R§12.7]'s conform-style discard, not gitsigns' retry,
   because the user can re-refresh cheaply. Also handle `changedtick == -1`
   (Vim exiting) by reading `vim.b.last_changedtick`, per conform's
   `util.lua:187`.
2. Read R3's body, strip fences, re-join with the target's `eol` (§6.6).
3. `vim.text.diff(old, new, { result_type = "indices", algorithm = "histogram" })`
   against the original slice.
4. **Reverse-sort the hunks** so earlier positions stay valid, then apply and
   re-stamp provenance per hunk:
   ```lua
   table.sort(hunks, function(a, b) return a[1] > b[1] end)
   vim.cmd("let &undolevels=&undolevels")
   for _, h in ipairs(hunks) do
     local sa, ca, sb, cb = h[1], h[2], h[3], h[4]
     local srow = ca == 0 and sa or sa - 1
     local newtext = cb == 0 and {} or vim.list_slice(new_lines, sb, sb + cb - 1)
     vim.api.nvim_buf_set_lines(target.bufnr, srow, srow + ca, false, newtext)
     if #newtext > 0 then stamp(target.bufnr, srow, 0, srow + #newtext - 1, #newtext[#newtext]) end
   end
   ```
   Verified: provenance ends up covering exactly the rewritten regions, an
   unrelated mark on an untouched row is undisturbed, and one undo reverts the
   whole transplant. **Provenance is re-derived from the diff, not preserved
   through it** — that is the [R§12.7] finding and this loop is its consequence.
5. Never `nvim_buf_set_lines(0, -1, …)` over the whole buffer. Measured: it
   destroys every extmark in the buffer and can leave a reversed range.

