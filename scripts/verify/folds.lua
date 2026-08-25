#!/usr/bin/env -S nvim -l
--
-- Verifies what §17.2 (notes/implementation/13-extension-ideas.md) is built on:
-- that a `{{{`/`}}}` marker in R1's text is a durable, window-independent way to
-- keep a section out of the prompt, and that the *fold* is only its rendering.
--
--   nvim -l scripts/verify/folds.lua
--   make verify-folds
--
-- Self-contained: writes one throwaway markdown file under a temp dir, needs no
-- server, no plugin and no treesitter parser. Every check carries its expected
-- value; a mismatch prints FAIL and the script exits 1.
--
-- The claim being verified is narrower than "hive can skip folds", and the
-- difference is the whole design. Fold *state* is window-local (W1) and is
-- destroyed by `:e!` (T6) — it also reports stale boundaries under
-- `foldmethod=expr` before a `zx`, which was measured but is not checked here
-- because it would need a parser on the runtime path. The marker is in the
-- file, so the exclusion survives a reload (T5) and is readable with no window
-- open at all (T3). The two readers agree while the folds are closed (T2); they
-- deliberately disagree once the user opens one to read it (T4), and that
-- disagreement is the point — opening a fold must not change a prompt byte, or
-- §8.3.1's prefix cache is lost on every submit that follows.
--
-- Re-run this on any Neovim whose fold behaviour is in question. Baseline: all
-- 21 checks green on NVIM v0.12.5, 2026-08-25. `foldmethod=marker` is
-- re-asserted after every reload because a markdown ftplugin may set `expr`.

local ROOT = vim.fs.joinpath(vim.fn.tempname(), "hive-folds")
local FILE = vim.fs.joinpath(ROOT, "notes.hive.md")

local failed = 0

local function out(...)
  io.stdout:write(string.format(...), "\n")
  io.stdout:flush()
end

local function show(v)
  return vim.inspect(v, { newline = " ", indent = "" })
end

local function check(id, what, got, want)
  local ok = vim.deep_equal(got, want)
  if not ok then
    failed = failed + 1
  end
  out("%-4s %-4s %-52s %s", id, ok and "ok" or "FAIL", what, show(got))
  if not ok then
    out("%-4s %-4s %-52s %s", "", "", "expected", show(want))
  end
end

-- The R1 body under test. Line numbers are cited by the checks, so do not
-- reorder without updating them.
--
--  1  # hive: notes
--  2
--  3  rename build_args to request_args        <- kept: the live task statement
--  4
--  5  ## parked <!-- {{{ -->                   <- marker ON the heading
--  6  - ask ben re: the 400 on llama.cpp
--  7  ### later <!-- {{{ -->                   <- nested
--  8  - chase the endofline thing in curl.lua
--  9  <!-- }}} -->
-- 10  <!-- }}} -->
-- 11
-- 12  ## open question                         <- marker BELOW the heading, so
-- 13  <!-- {{{ -->                                the heading survives
-- 14  - does a role line change the completion?
-- 15  <!-- }}} -->
-- 16
-- 17  still relevant                           <- kept
local BODY = {
  "# hive: notes",
  "",
  "rename build_args to request_args",
  "",
  "## parked <!-- {{{ -->",
  "- ask ben re: the 400 on llama.cpp",
  "### later <!-- {{{ -->",
  "- chase the endofline thing in curl.lua",
  "<!-- }}} -->",
  "<!-- }}} -->",
  "",
  "## open question",
  "<!-- {{{ -->",
  "- does a role line change the completion?",
  "<!-- }}} -->",
  "",
  "still relevant",
}

local FIRST, LAST = 1, #BODY

--- Reader A — the window one. Walks the region and skips whatever is *rendered*
--- closed. Needs a window on the buffer, which is what T3 disqualifies it for.
---@param win integer
---@param first integer  1-indexed, inclusive
---@param last integer   1-indexed, inclusive
---@return string[]
local function visible(win, first, last)
  return vim.api.nvim_win_call(win, function()
    local keep, l = {}, first
    while l <= last do
      local start = vim.fn.foldclosed(l)
      if start == -1 then
        keep[#keep + 1] = vim.fn.getline(l)
        l = l + 1
      else
        l = vim.fn.foldclosedend(l) + 1 -- skip the fold whole, not line by line
      end
    end
    return keep
  end)
end

--- Reader B — the text one, and the one §17.2 proposes hive actually ships.
--- Reads bytes, needs no window, and gives the same answer before and after a
--- reload. Marker lines are dropped at every depth, so an opened fold changes
--- nothing here (T4).
---@param buf integer
---@param first integer  1-indexed, inclusive
---@param last integer   1-indexed, inclusive
---@return string[]
local function unmarked(buf, first, last)
  local open, close = unpack(vim.split(vim.o.foldmarker, ","))
  local keep, depth = {}, 0
  for _, line in ipairs(vim.api.nvim_buf_get_lines(buf, first - 1, last, false)) do
    if line:find(open, 1, true) then
      depth = depth + 1
    elseif line:find(close, 1, true) then
      depth = math.max(0, depth - 1)
    elseif depth == 0 then
      keep[#keep + 1] = line
    end
  end
  return keep
end

-- What both readers return once the marked sections are excluded. Note what
-- survives and what does not: `## parked` carries the marker on its own line
-- and goes with the fold, `## open question` does not and stays.
local KEPT = {
  "# hive: notes",
  "",
  "rename build_args to request_args",
  "",
  "",
  "## open question",
  "",
  "still relevant",
}

local function remark(win)
  vim.wo[win].foldmethod = "marker" -- after any reload: an ftplugin may set expr
  vim.wo[win].foldenable = true
  vim.wo[win].foldlevel = 0 -- a marked section opens minimised, which is the default wanted
end

vim.fn.mkdir(ROOT, "p")

vim.cmd.edit(vim.fn.fnameescape(FILE))
local buf = vim.api.nvim_get_current_buf()
local win = vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_lines(buf, 0, -1, false, BODY)
vim.bo[buf].filetype = "markdown"
vim.cmd.write()
remark(win)

local v = vim.version()
out("hive: fold-marker verification — §17.2")
out("NVIM %d.%d.%d, foldmarker=%s", v.major, v.minor, v.patch, vim.o.foldmarker)
out("%s\n", FILE)

-- F: the fold structure the markers produce.
check("F1", "marker on a heading folds the heading too", vim.fn.foldclosed(5), 5)
check("F2", "nested marker is level 2", vim.fn.foldlevel(8), 2)
check("F3", "unmarked prose is level 0", vim.fn.foldlevel(3), 0)
check("F4", "marker below a heading spares the heading", vim.fn.foldclosed(12), -1)
check("F5", "...and folds from the line it is on", vim.fn.foldclosed(13), 13)

-- T1/T2: the two readers, folds closed.
check("T1", "window reader skips the marked sections", visible(win, FIRST, LAST), KEPT)
check("T2", "text reader agrees while folds are closed", unmarked(buf, FIRST, LAST), KEPT)

-- W1: fold state is window-local, so there is no such thing as "the fold state
-- of this buffer" to read. Two windows on the same buffer, one fold opened in
-- the second only.
vim.cmd.split()
local w2 = vim.api.nvim_get_current_win()
remark(w2)
vim.api.nvim_win_call(w2, function()
  vim.cmd("normal! 5Gzo")
end)
local function closed_in(w)
  return vim.api.nvim_win_call(w, function()
    return vim.fn.foldclosed(5)
  end)
end
check("W1", "same buffer, fold open in one window", closed_in(w2), -1)
check("W1", "...and still closed in the other", closed_in(win), 5)
check("W1", "text reader is indifferent to which", unmarked(buf, FIRST, LAST), KEPT)
vim.api.nvim_win_close(w2, true)

-- T3: the property that decides the design. Hide the buffer — no window shows
-- it, which is the state `bufhidden = "hide"` (§3.2) leaves it in whenever the
-- user submits from the code buffer — and read it anyway.
vim.cmd.enew()
check("T3", "no window shows the buffer", #vim.fn.win_findbuf(buf), 0)
check("T3", "text reader answers anyway, unchanged", unmarked(buf, FIRST, LAST), KEPT)
vim.api.nvim_win_set_buf(win, buf)
remark(win)

-- T4: opening a fold to read it must not move a prompt byte (§8.3.1). The
-- window reader grows; the text reader does not. The disagreement is intended.
vim.api.nvim_win_call(win, function()
  vim.cmd("normal! 5Gzo")
end)
check("T4", "opened fold: window reader grows", #visible(win, FIRST, LAST) > #KEPT, true)
check("T4", "opened fold: text reader is byte-identical", unmarked(buf, FIRST, LAST), KEPT)

-- T5: the reload. R1 is a real file (§3.1) and will be reloaded.
vim.api.nvim_win_call(win, function()
  vim.cmd("normal! zM")
end)
vim.cmd.edit({ bang = true })
remark(win)
check("T5", "marker fold still closed after :e!", vim.fn.foldclosed(5), 5)
check("T5", "text reader unchanged after :e!", unmarked(buf, FIRST, LAST), KEPT)

-- T6: the contrast, and the reason the marker is not optional. A manual fold —
-- what `zf` gives you, and what a user reaches for first — is gone after the
-- same reload, because nothing in the file records it.
vim.wo[win].foldmethod = "manual"
vim.cmd("5,10fold")
local manual_before = vim.fn.foldclosed(6)
vim.cmd.edit({ bang = true })
check("T6", "manual fold closed before reload", manual_before, 5)
check("T6", "manual fold gone after reload", vim.fn.foldclosed(6), -1)

-- K1: the known false positive, recorded rather than fixed. A fenced block in R1
-- containing a bare `{{{` reads as a marker and swallows the rest of the region.
-- §4.2's fence stripper has the same class of limitation and the same
-- disposition: total, deterministic, not lossless.
vim.api.nvim_buf_set_lines(buf, 0, -1, false, {
  "# hive: notes",
  "keep",
  "```lua",
  "local t = {{{ 1 } } }",
  "```",
  "also keep",
})
check("K1", "a fence holding {{{ eats the rest — known", unmarked(buf, 1, 6), { "# hive: notes", "keep", "```lua" })

out("")
if failed > 0 then
  out("%d check(s) FAILED", failed)
  os.exit(1)
end
out("all checks ok")
