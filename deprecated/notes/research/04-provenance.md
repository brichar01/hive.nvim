# Provenance and partial accept — §12

Part of the `hive.nvim` research notes — index: [`PLAN.md`](../../PLAN.md).
Section numbers are unchanged by the split; a `§n` cross-reference still resolves
via the section map in the index.

---

## 12. Provenance and partial accept

Which bytes in a buffer came from the model, and how to get an accepted — or
partially accepted — suggestion in without lying about either.

**No reference implementation exists.** Not one of the ten plugins surveyed tracks
where generated text came from after it lands; copilot, supermaven, avante and
codecompanion all forget the moment the text is in the buffer. Everything below
was derived from primitives and measured here.

### 12.1 Core's `inline_completion` is the seam, and it has no provenance

Its namespace holds ghost text only: one extmark written in `Completor:show()`
(`:204`, the extmark at `:258`) with `virt_text`/`virt_lines`, and
`Completor:hide()` (`:269`) is
`nvim_buf_clear_namespace(bufnr, namespace, 0, -1)`. `M.get()` calls
`abort()` → `hide()` **before** `accept()` runs (`:477`), so by the time the text
exists in the buffer every trace that a model produced it is gone.

**`on_accept` is the documented extension point and exactly the right shape**
(`:444`):

```
--- You can use it to modify the completion item that is about to be accepted
--- and return it to apply the changes, or return `nil` to prevent the changes
--- from being applied to the buffer so you can implement custom behavior.
---@field on_accept? fun(item: vim.lsp.inline_completion.Item): vim.lsp.inline_completion.Item?
```

An `Item` is `{ insert_text, range, client_id, command, _index }`. Partial accept
is `on_accept` returning an item with a sliced `insert_text`; provenance stamping
is the same callback returning `nil` and doing the write itself.

`Completor:accept()` (`:342`) is `nvim_buf_set_text` when `item.range` is set and
`nvim_paste` otherwise. **There is no `undojoin` and no undo break on either
path** — per §12.6 that means consecutive accepts are not independently undoable.

### 12.2 Extmarks are the primitive, and the *default* gravity is the one you want

Range extmark over `"generated"` (cols 4–13) in `"AAA generated ZZZ"`:

| Edit | default `rg=T, erg=F` | "grow" `rg=F, erg=T` |
| --- | --- | --- |
| insert inside (col 8) | `[4,15)` grows | `[4,15)` grows |
| insert **at start** (col 4) | `[6,15)` — **excluded** | `[4,15)` — **absorbed** |
| insert **at end** (col 13) | `[4,13)` — **excluded** | `[4,15)` — **absorbed** |
| delete 3 inside | `[4,10)` shrinks | `[4,10)` shrinks |
| newline in middle | `[0,4)-[1,5)` splits rows | same |

**Gravity only matters at the two boundaries** — interior edits grow or shrink in
every configuration, free. And the intuitive choice is wrong: the
`right_gravity = false, end_right_gravity = true` "grow" configuration **silently
claims text the user types immediately before or after the generated region.** The
API defaults exclude adjacent typing on both sides, which is the honest answer to
"did the model write this byte".

So: default gravity, and grow the range **explicitly** by re-setting the same `id`
when *you* extend it. Do not let gravity do it.

**Do not bracket an insertion with two point marks.** It looks elegant — an
`rg=false` mark and an `rg=true` mark, insert between them, read the pair as the
range — and it fails the same way: measured, after inserting `pcall(f)` the pair
reads correctly, but typing `ZZ` immediately after pushes the right mark and the
bracket becomes `"pcall(f)ZZ"`. A single range extmark with default gravity
already gets this right.

### 12.3 `invalidate = true` plus the default `undo_restore`

Deleting the entire marked range, then undoing:

| Config | after delete | after undo |
| --- | --- | --- |
| `invalidate=true` (default `undo_restore=true`) | `[4,4)` **INVALID** | `[4,13)` **restored exactly** |
| `invalidate=true, undo_restore=false` | **mark deleted** | still gone |
| no `invalidate` | `[4,4)`, collapsed but *valid* | `[4,13)` restored |

The first row is what provenance wants: while the text is deleted the mark
reports `invalid` in `details` so queries can filter it, and an undo brings the
exact original range back. **Omitting `invalidate` is the trap** — the mark
collapses to zero width but is still reported valid, so a query says "there is
provenance here" pointing at nothing. Reap `invalid` marks on a schedule, not
eagerly; eagerly defeats the undo restore.

### 12.4 `overlap = true` is not optional

```
cursor col 8 (middle of a mark spanning [4,13)), plain : {}
cursor col 8, overlap=true                             : {1}
cursor col 4 (the mark's start), plain                 : {1}
```

`nvim_buf_get_extmarks` over a range returns marks that *begin* inside it; a mark
that **contains** the position is missed entirely. The obvious "what is the
provenance under my cursor" query therefore works at the first byte of a
generated region and returns nothing for every other byte — a bug that presents
as "provenance mostly doesn't work" rather than as a wrong flag. Always pass
`{ details = true, overlap = true }`.

### 12.5 A reload silently re-points marks at unrelated text

**The worst finding here.** Mark on `"GENERATED"` at `[1,6)-[1,15)`, change the
file on disk, `:edit!`:

| Reload | mark | now covers |
| --- | --- | --- |
| file grew at the end | `[1,6)-[1,15)` | `"GENERATED"` — right, by luck |
| a line was **prepended** | `[1,6)-[1,15)` | `"aaa"` |
| every line differs | `[1,6)-[1,15)` | `"ent"` |

**A reload does not delete extmarks. It keeps them at their byte coordinates and
lets whatever text now occupies those coordinates inherit the provenance.** The
mark is still "valid", `invalidate` does not fire, nothing warns. `:bwipeout` and
reopen is the honest failure: new bufnr, zero marks.

Because the session buffer is a real file that *will* be reloaded, the guard is
mandatory. Fail closed — verified to drop the marks to zero:

```lua
api.nvim_create_autocmd({ 'BufReadPost', 'FileChangedShellPost' }, {
  buffer = bufnr,
  callback = function() api.nvim_buf_clear_namespace(bufnr, NS, 0, -1) end,
})
```

Provenance is cheap to regenerate; confidently wrong provenance is worse than
none.

### 12.6 Partial accept: slice the suggestion, and break undo every time

The mechanic is trivial — slice the stored suggestion string, insert the slice,
keep the remainder. Verified accepting `'pcall(require, "hive")'` a word at a time
with the mark extended in place by re-setting the same `id`:

```
accept word 1 (new)       buf={"local x = pcall"}          prov=id1="pcall"
accept word 2 (extended)  buf={"local x = pcall("}         prov=id1="pcall("
accept word 3 (extended)  buf={"local x = pcall(require"}  prov=id1="pcall(require"
```

One mark, not four. **The undo break is the part that is not optional:**

| Between three successive accepts | one undo removes |
| --- | --- |
| nothing | **all three** |
| `vim.wait(10)` | **all three** |
| `sleep 10m` | **all three** |
| `pcall(vim.cmd.undojoin)` | **all three** |
| `vim.cmd('let &undolevels=&undolevels')` | just the last |

Repeated in real insert mode through `nvim_feedkeys` with an accept mapping:
without the break the whole insert session collapses to one undo step; with it
each accept is its own step. `nvim_paste` behaves identically, so neither of
core's two accept paths escapes it.

**Neither the passage of time nor an event-loop turn separates undo blocks.**
copilot.lua's `let &undolevels=&undolevels` (§9.1) is load-bearing, not
stylistic, and conform's `pcall(vim.cmd.undojoin)` is exactly backwards here —
right for a formatter, wrong for an accept. Re-measured: `undojoin` is worse
than no break at all — it merges the accepts into the *preceding* undo block,
so one undo also removed the user's own edit made before the first accept.

### 12.7 Provenance does not survive a rewrite; re-derive it

**Insert path** (a completion accept): the edit is a pure insertion at a known
position, so it is *already* minimal. Use `nvim_buf_set_text`; running
`vim.text.diff` buys nothing and costs what follows.

**Rewrite path** (the model replaces a region): §4 and §8.1's territory. Marks
*outside* the changed hunks survive correctly, including across an inserted row
(`[1,0)` → `[2,0)`), and a whole-buffer `nvim_buf_set_lines(0, -1, …)` destroys
everything and can leave a reversed range (`[3,0)-[0,0)`, INVALID). But:

**Every diff granularity destroys marks inside a rewritten hunk.** Rewriting
`local function f(a)\n  return a` to `f(a, b)\n  return a + b` with a mark on
`"return a"`:

| Strategy | mark |
| --- | --- |
| line-granular hunk, no shrink | **INVALID** |
| + conform's byte prefix/suffix shrink (`runner.lua:92`, `:133`) | **INVALID** |
| `ctxlen=0, linematch=10` | **INVALID** |
| `algorithm='minimal'` | **INVALID** |

All four produce the same hunk `{1, 2, 1, 2}`; the shrink cannot help because the
changed span runs `[0,18)`→`[1,10)`, straight through the mark. Semantically
correct — those bytes were replaced — but it means **provenance is not preserved
through a rewrite, it is re-derived as you apply it.**

The verified recipe: reverse-sort hunks so earlier positions stay valid (§4), one
undo break for the whole rewrite, then apply-and-stamp each hunk immediately.
Measured on a two-hunk rewrite: provenance covers exactly the rewritten regions,
an unrelated mark on an untouched row is undisturbed, and one undo reverts
everything. `IMPLEMENTATION.md` §10.4 is this loop.

### 12.8 The durable model: store the base, recompute the diff

gitsigns' architecture (§8.2) is the design that survives editing, and it is
**not** mark-based: `compare_text` is truth, `get_hunks()` recomputes, every
extmark is display. That inversion buys three things extmarks cannot — immunity
to §12.5 (a reload just changes `buftext`), immunity to §12.7 (a rewrite is just
a new `buftext`), and persistability (§12.10).

The cost is that it answers a slightly different question — *"how does this differ
from what the model produced"* rather than *"which bytes are the model's"* — and
needs a diff per query rather than a lookup.

**The hybrid is what hive builds:** the session file on disk is the durable
record, and extmarks with default gravity, `invalidate = true` and the §12.5
reload guard are the live index for rendering. When they disagree, the file wins.

### 12.9 `on_bytes` if per-byte truth is ever needed

Region marks degrade honestly but coarsely. Measured: accept `"\n  return true"`,
then let the user replace `return` with `error` inside it — the mark now reports
`"\n  error true"` as generated. At region granularity provenance means *"this
region was seeded by the model"*, which is usually the useful claim.

For the stronger claim, `nvim_buf_attach`'s `on_bytes` gives every edit as an
exact byte delta with the `changedtick`:

```
set_text(b, 0, 5, 0, 5, {' there'})   tick=3 start=[0,5]@5 old=(0,0,0) new=(0,6,6)
set_text(b, 0, 0, 0, 5, {'HI'})       tick=4 start=[0,0]@0 old=(0,5,5) new=(0,2,2)
```

Enough to maintain an interval map and attribute each edit to model or user. It is
the most code of any option here and the same feed core uses for incremental
parsing (`languagetree.lua:1247`). Not in v1.

### 12.10 Nothing persists extmarks

Extmarks live for the lifetime of the buffer and no longer — `:bwipeout` and
reopen gives zero marks (§12.5). `:h api-extended-marks` makes no persistence
claim, and grepping `starting.txt` and `undo.txt` for `extmark` returns nothing;
ShaDa stores file marks, uppercase marks, registers and jumplists, not extmarks,
and undo files do not carry them.

**This is why the session buffer is a real file** rather than a scratch buffer
(`IMPLEMENTATION.md` §3.1): text plus a path is the only substrate that
round-trips a restart.

### 12.11 Rendering it

All five presentations work on a single provenance mark, so it is a taste
decision: `hl_group` on the range, `sign_text` + `sign_hl_group`,
`line_hl_group`, `number_hl_group`, or trailing `virt_text` with
`virt_text_pos = 'eol'`.

If provenance highlighting ever gets expensive, avante's decoration-provider
pattern (`diff.lua:439`, `nvim_set_decoration_provider` gated on `changedtick`)
computes only for visible windows at redraw, once per tick — strictly less work
than any autocmd. Start with `hl_group` and only reach for that if a large buffer
shows it.

### 12.12 Build order — *retired*

Superseded by `IMPLEMENTATION.md` §15.

