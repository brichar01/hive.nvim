# Plugin precedents, and the transport gaps — §8–§10

Part of the `hive.nvim` research notes — index: [`PLAN.md`](../../PLAN.md).
Section numbers are unchanged by the split; a `§n` cross-reference still resolves
via the section map in the index.

---

## 8. Third-party plugins: what to copy

### 8.1 conform.nvim — the reference implementation

`~/.local/share/nvim/lazy/conform.nvim/lua/conform/runner.lua` is the most
complete buffer→CLI code on this machine and the single best thing to read. What
hive takes:

- **`pcall` around `vim.system`** (`:405`), per §2.
- **Staleness guard** (`:557`) — capture, compare, discard:
  ```lua
  local changedtick = vim.b[bufnr].changedtick
  ...
  if not vim.api.nvim_buf_is_valid(bufnr) or changedtick ~= util.buf_get_changedtick(bufnr) then
    err = { code = errors.ERROR_CODE.CONCURRENT_MODIFICATION, ... }
  ```
  logged at INFO, not ERROR (`errors.lua:19`, `:25`), so a racing edit does not
  spam notifications.
- **The shutdown edge case** at `util.lua:187`, which is not guessable:
  ```lua
  -- changedtick gets set to -1 when vim is exiting. We have an autocmd that should
  -- store it in last_changedtick before it is set to -1.
  if changedtick == -1 then return vim.b[bufnr].last_changedtick or -1
  ```
  fed by a `BufWinLeave` autocmd (`init.lua:177`). Without it, any
  format/apply-on-exit path *always* discards its result.
- **Write-back is a diff, never a full replace** (`:182` `M.apply_format`):
  append `""` to both old and new before diffing because `indices` cannot signal
  an eol-only change (`:199`–`:207`); **abort on suspicious empty output**
  (`:210`, *"black outputs nothing for excluded files"*); diff with
  `histogram` (`:221`); shrink each hunk by common byte prefix/suffix (`:92`,
  `:133`) so marks inside untouched parts of a changed line survive; then
  `pcall(vim.cmd.undojoin)` (`:286`) and `apply_text_edits`.
- **Cancellation by pid stamp** — `vim.b[bufnr].conform_pid` at `:477`, and a new
  run kills the old one with `uv.kill` at `:551`. If a job fails *and* the pid no
  longer matches it reports `INTERRUPTED` rather than `RUNTIME` (`:452`), so the
  error is attributed correctly.
- **Interruptible sync wait** at `:709`, per §2.
- **Per-tool exit codes** (`:402`, checked at `:417`) — many tools exit non-zero
  as *signal*, not failure.
- **Notify debounce** (`errors.lua:6`) so a persistently broken tool notifies once
  and points at a log.

Two things conform does that hive must **not** copy: `pcall(vim.cmd.undojoin)` is
exactly backwards for partial accept (§12.6), and the tempfile mode
(`stdin = false`) is irrelevant.

### 8.2 gitsigns.nvim — the architecture, not just the helper

Two contributions. The first is `util.buf_lines` (`util.lua:128`), the most
complete buffer→bytes function anywhere — `fileformat`, `endofline` *and* `bomb`
(§1).

The second is more important and is the model for §12.8: **gitsigns keeps the
base text as truth and recomputes the diff; extmarks are display only.**
`compare_text` is the cached base (`cache.lua:20`) and `CacheEntry:get_hunks()`
(`cache.lua:295`) is `run_diff(text, buftext, false)`. Every extmark in the
codebase — `signs.lua:113`, `word_diff.lua:84`, `blame.lua`, `preview.lua`,
`deleted_preview.lua` — is rendering. Nothing reads one back as data.

Also worth stealing: every git call goes through one hardened wrapper
(`git/cmd.lua:21`) with `-c gc.auto=0` (`:27`, *"Disable auto-packing which emits
messages to stderr"*) and `LC_ALL=C LANGUAGE=C` at `:44` so **stderr
pattern-matching survives a translated git**. Its staleness guard is a *retry*
rather than a discard (`cache.lua:164`), plus a detach guard — *"the buffer may
have been detached … while an earlier blame was in flight"*.

### 8.3 The tempfile fallback — *retired*

Was: conform's `.conform.$RANDOM.$FILENAME` written next to the real file (not in
`/tmp`) so project-relative config discovery still works, `0700`, cleanup on every
exit path. hive sends on stdin and never needs a temp file (§9.3).

### 8.4 Cancellation: kill *and* a generation counter

From telescope. The job is killed on every keystroke
(`async_job_finder.lua:31`), **and** a monotonic `find_id` generation counter
(minted at `pickers.lua:499`, compared at `:1415`) drops results from a stale
generation. Two layers, because a killed process's callback may already be
queued. neo-tree's variant follows `job:shutdown()` with a hard `kill -9` because
`fd` may ignore SIGTERM.

That belt-and-braces pattern is what `IMPLEMENTATION.md` §9.3 adopts: kill the
in-flight `SystemObj`, and also drop any response whose generation is stale.

### 8.5–8.9 Chunking, incremental stdin, blocking calls, the summary matrix — *retired*

Was: blink.cmp's byte-budget chunker (20 KB sync / 200 KB async / 500 KB total,
soft-min 2000 / hard-max 4000 bytes, whitespace-aligned, `vim.schedule` between
chunks); `uv.spawn` + `new_pipe` for incremental stdin writes (mason, plenary
`Job`); an inventory of plugins that block the editor with `vim.fn.system`; and a
matrix mapping every pattern to every plugin.

Retired: hive's budget is token-based and prompt-shaped, not a buffer-scanning
budget (`IMPLEMENTATION.md` §8.3), and its body is one `stdin` string.

One correction to that framing, from measurement: hive's budget is token-shaped
but **latency-bound**. `IMPLEMENTATION.md` §8.3.1 measures 59–88 tok/s of prefill
on this CPU-only machine, so the ceiling is set by how long a submit may take,
not by what the model can hold — and those figures, and every default derived
from them, must be re-measured on a machine with a dedicated GPU (§8.3.4).

### 8.10 Correctness checklist

The densest useful thing in the original survey. Kept in full because it is a
review checklist, not prose.

- **Trailing newline out:** conform `runner.lua:371` (`vim.bo.eol`); gitsigns
  `util.lua:140` (`endofline`); core `vim/lsp.lua:110`.
- **Trailing newline back:** conform `runner.lua:430` — drop one trailing `""`,
  then re-insert if the array went empty, because *"Vim will never let the lines
  array be empty"*.
- **CRLF / fileformat:** conform writes back with `util.buf_line_ending`, not
  `\n`; telescope strips all CR on read.
- **BOM:** only gitsigns (`util.lua:148`).
- **Cursor / marks / extmarks:** minimal `TextEdit` diffs + `apply_text_edits`,
  never whole-buffer `set_lines`.
- **Undo:** `pcall(vim.cmd.undojoin)` to *merge* (conform `runner.lua:286`);
  `let &undolevels=&undolevels` to *break* (§9.1, §12.6). Choose deliberately.
- **Staleness:** discard (conform) vs retry (gitsigns) vs cache-key (blink) —
  plus conform's `changedtick == -1` shutdown case.
- **Buffer validity / detach:** `nvim_buf_is_valid` on every async return.
- **Cancellation:** pid stamp + `uv.kill`, *and* a generation counter (§8.4).
- **Timeouts:** hive's 5 s head start over curl's `--max-time` is already right.
- **Exit codes:** configurable per tool; non-zero is often a signal, not failure.
- **Error surfacing:** notify debounce so a broken tool notifies once; ENOENT
  turned into "could not find executable in PATH" (mason `process.lua:227`).
- **No silent caps:** if a budget drops content, say so. Silent truncation reads
  as "covered everything" when it didn't. Note that hive is not the only party
  that can truncate: ollama silently drops the *head* of an over-long prompt,
  taking the FIM sentinel with it, and returns HTTP 200
  (`IMPLEMENTATION.md` §8.3.7).
- **Hygiene:** large payloads kept off argv via stdin; env redacted before
  logging (mason `process.lua:155`).

---

## 9. The AI plugins: the findings that survive

Four plugins whose entire job is shipping buffer text to a model —
`copilot.lua`, `supermaven-nvim`, `codecompanion.nvim`, `avante.nvim`. **None is
installed here**; these were read from upstream sources, so treat the line
numbers as softer than the rest of this document.

### 9.1 copilot.lua — the undo *break*, and a live utf-16 bug

**The undo break.** `suggestion/init.lua:657`:

```lua
-- Create an undo breakpoint
vim.cmd("let &undolevels=&undolevels")
```

The exact opposite of conform's `undojoin`, and correct: each accepted suggestion
should be independently undoable. §12.6 measures why this is the *only* thing
that works.

**A verified bug worth knowing**, because it is the trap §4 warns about.
`get_doc` deliberately requests utf-16 positions, so the server's ranges come
back in utf-16 offsets. But the accept path computes its encoding as
(`suggestion/init.lua:662`):

```lua
if not encoding or encoding == "" or encoding ~= "utf-8" or encoding ~= "utf-16" or encoding ~= "utf-32" then
```

Those `or`s are a tautology — no string differs from all three — so both branches
always fire and `encoding` is unconditionally `"utf-8"`. The intent was `and`.
Net effect: utf-16 ranges handed to `apply_text_edits` as utf-8, so on any line
with non-ASCII before the suggestion the edit lands at the wrong column.
`panel/init.lua:233` passes the literal `"utf-16"` and is correct, so the two
call sites disagree. **lua_ls negotiates utf-16 here too**; convert once at the
boundary.

Also from copilot: it never serializes a buffer at all, driving the agent as an
LSP server so core's `didOpen`/`didChange` carries the text. And it guards
staleness by deep-comparing the whole param table
(`suggestion/init.lua:378`) — since that table holds both `doc.version`
(= changedtick) and `position`, one `vim.deep_equal` subsumes a changedtick guard
*and* a cursor guard.

supermaven's contribution, in one line: it sends the cursor as a **byte offset**
(`offset = #prefix`), sidestepping the whole utf-16 problem copilot tripped on.

### 9.2 Persistent NDJSON peers — *retired*

Was: supermaven's `sm-agent stdio` with newline-delimited JSON instead of
`Content-Length`, its 50-generation stale-response *reuse* (strip what you have
since typed off the front of an old completion and use the remainder), and its
25 ms polling render loop. All interesting, none applicable to one-shot HTTP.

### 9.3 Body transport: hive's is already the best of the five

codecompanion (`http.lua:35`) and avante (`llm.lua:575`) both write the request
body to a temp file and pass the *path* as plenary's `body`. plenary's `body` is
polymorphic — verified in the local copy, `parse.file` at `curl.lua:153` emits
`{ "-d", "@" .. path }`, reached via the `in_file` branch at `:212` and appended
at `:239`; the `--data-raw`-on-argv branch is at `:124` and neither plugin
reaches it.

Three problems with the temp-file approach, all avoided by `--data-binary @-`
with `stdin = req.body`, which is what `hive.curl` already does:

1. **It's `-d @file`, not `--data-binary @file`.** Plain `-d` *strips CR and LF
   from the file*. Safe today only because `vim.json.encode` emits single-line
   JSON; any adapter that pretty-printed its body would be silently mangled.
2. **codecompanion retains the temp files on error** (`http.lua:57`), so the body
   *and* a plaintext API-key header file (it passes `--header @file` too) survive
   every failed request, and every request at `DEBUG`/`TRACE`. Written `0644`.
3. avante leaks them deliberately under `Config.debug` (`llm.lua:612`).

**Conclusions: do not "upgrade" to a body file**, and **do not add `--retry` to
the POST** — codecompanion's `--retry 3` (`http.lua:132`) makes a non-idempotent
completion re-issuable.

### 9.4 Streaming caveats, for when streaming is added

Deferred in v1. Four things to get right, three of them mistakes made upstream:

- **SSE `[DONE]` must be handled explicitly.** codecompanion's whole parser is
  `local find_json_start = string.find(data, "{") or 1` with **no `[DONE]`
  handling anywhere in the repo** — `data: [DONE]` contains no `{`, so it falls
  through, fails `vim.json.decode`, and is dropped. Real protocol corruption
  becomes indistinguishable from normal end-of-stream. avante does it properly
  per-provider (`openai.lua:592`), covering both wire shapes.
- **Partial-line carry is nobody's job by default.** Neither plugin implements it;
  both inherit it from plenary's `Job`, whose `on_output` is a `coroutine.wrap`
  keeping `result_line` across chunk boundaries (`job.lua:289`). Outside plenary
  it is yours — and per §2, `text = true` is ignored when `stdout` is a function.
- **Accumulate into a table joined once.** Every NDJSON implementation surveyed
  is `buffer = buffer .. data`, i.e. quadratic; core has
  `vim._core.stringbuffer` precisely to avoid it.
- **Disable compression while streaming** — gzipped bytes defeat line-splitting.

### 9.5 Incremental JSON parsing — *retired*

Was: avante's `libs/jsonparser.lua`, a real character state machine with an
`INCOMPLETE` state whose `finalize()` materializes truncated input tagged
`_incomplete`, so a half-arrived tool call still renders a live diff preview. Plus
the best single detail in the original survey — `llm_tools/replace_in_file.lua:33`
renames a parameter to `the_diff` so that alphabetical key order puts `path`
before the diff bytes and streaming can start rendering earlier.

Retired: hive requests plain code into a FIM hole, not a JSON tool call.

### 9.6 Render partial output as virtual text; write real text on completion

avante's streaming preview is virtual-only until the tool call completes
(`replace_in_file.lua:688`):

```lua
if not is_streaming then
  insert_diff_blocks_new_lines()      -- nvim_buf_set_lines
else
  highlight_streaming_diff_blocks()   -- virt_lines extmarks only
end
```

**This is the one design decision all four plugins get wrong somewhere**, and it
sidesteps the entire staleness problem for the streaming case. avante's
`selection.lua:146` does the opposite on its `AvanteEdit` path, re-splitting the
whole accumulated response and `set_lines`-ing on every chunk.

Its gating is also worth copying if streaming lands: two seconds of wall clock
**and** a line-count-changed check, both keyed by request id
(`replace_in_file.lua:121`), rather than the single time-based debounce
everything else uses.

### 9.7 Write-back: use `apply_text_edits`

The spectrum, worst to best:

- **codecompanion** (`insert_edit_into_file/init.lua:136`): wholesale
  `nvim_buf_set_lines(bufnr, 0, -1, ...)` then a forced `vim.cmd("silent write")`.
  Destroys every extmark and mark in the buffer, no `undojoin`, no cursor
  restore, and silently saves the user's file. It *does* compute a real
  `vim.text.diff` — but only to render its review UI, never to minimize the edit.
- **avante** writes real git conflict markers into the buffer on its legacy path
  (`sidebar.lua:760`).
- **copilot.lua and supermaven both use `vim.lsp.util.apply_text_edits`**,
  inheriting all of §4 for free. That remains the right default.

One genuinely better detail, from avante's diff UI (`replace_in_file.lua:193`):
**`undojoin` once per logical operation, not per write.**

```lua
local undo_joined = session_ctx.undo_joined[opts.tool_use_id]
if not undo_joined then
  pcall(vim.cmd.undojoin)
  session_ctx.undo_joined[opts.tool_use_id] = true
end
```

One undo entry per tool call across many re-applications; a naive join-every-write
would collapse the user's own preceding edit into the model's. That is the same
distinction `IMPLEMENTATION.md` §10.3 draws between a refresh (one break, many
writes) and an accept (one break each).

### 9.8 Repairing the model's diff — *retired*

Was: avante's five-tier fuzzy match ladder for locating old text
(`utils/init.lua:680`) and `Utils.fix_diff` (`:1682`), which transcodes a unified
diff into SEARCH/REPLACE, injects a missing `------- SEARCH`, and synthetically
closes an unterminated block — with the honest comment *"Some models (e.g.,
gpt-4o) cannot correctly return diff content and often miss the SEARCH line."*
Also a warning: tier 3 is `gsub("%s*", "")`, so `x = a+b` and `x = a + b` compare
equal, and `try_find_match` returns the *first* hit without checking uniqueness,
so a SEARCH block matching several sites silently edits the earliest.

Retired because hive designs the problem class out: it asks for code in a FIM
hole and computes the diff itself.

### 9.9 Nobody handles `fileformat`, `endofline` or BOM

All four are `table.concat(nvim_buf_get_lines(...), "\n")` — supermaven
`util.lua:139`, codecompanion `utils/buffers.lua:119`, avante
`utils/init.lua:330` and `:1380`; copilot sidesteps it only by never serializing a
buffer. **That is the strongest possible confirmation of §1**: the correctness
work core does in `_buf_get_full_text` is skipped in the wild by every plugin
whose core competency is sending buffers to a process.

Staleness guards range from good to absent: copilot deep-compares the param
table; supermaven compares content; codecompanion uses `mtime.sec` for files
(so sub-second races pass) and `changedtick` in exactly one place; avante
captures `changedtick` in `Utils.get_doc` and then **never uses it as a staleness
check** — its confirm-dialog rollback is `nvim_buf_set_lines(bufnr, 0, -1, false,
original_lines)`, which discards the user's concurrent edits along with the
model's.

---

## 10. The transport gaps in `hive.curl` today

Four concrete gaps, each with a precedent above. `IMPLEMENTATION.md` §9.3 is the
fix list.

1. **No `pcall` around `vim.system`** (`hive/curl.lua:141`, `:144`). The
   `vim.fn.executable("curl")` pre-check at `:120` covers the common case but not
   a bad `cwd` or a non-executable binary. Per §2, an unguarded throw in a
   coroutine is a silent hang.
2. **No cancellation handle.** `M.request` discards the `SystemObj`, so there is
   no `:kill()`. Required for supersede-on-refresh; pair it with a generation
   counter (§8.4).
3. **The blocking `:wait()` at `:141` is not interruptible.** conform's
   `vim.wait(remaining, fn, 5)` keeps the event loop turning so `<C-c>` works.
4. **No buffer→bytes function exists** — zero `nvim_buf_get_lines` and zero
   `changedtick` anywhere in `lua/hive/` (all seven modules, 558 lines).

What is already right and should not be touched: `stdin = req.body` with
`--data-binary @-` (§9.3), the `vim.schedule` around the callback, and the 5 s
timeout headroom over curl's own `--max-time`.

