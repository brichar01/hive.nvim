--- Named definitions that enclose the cursor, such as `Class.method`.
---
--- `refresh` caches each buffer's method, class and container tree. The plugin
--- calls it on BufReadPost, BufEnter and CursorHold, so `chain` only reads the
--- cache and is cheap enough for a statusline.

local gather = require("hive.context.gather")
local selection = require("hive.context.selection")

local M = {}

--- @type table<integer, gather.Entry[]>
local trees = {}

--- Rebuild the tree of method, class and container nodes for a buffer.
---
--- @param buf integer? buffer number (default: current buffer)
function M.refresh(buf)
  if buf == nil or buf == 0 then
    buf = vim.api.nvim_get_current_buf()
  end
  local parser = vim.treesitter.get_parser(buf, nil, { error = false })
  trees[buf] = parser and gather.tree(parser, buf, vim.bo[buf].filetype) or nil
end

--- @param buf integer
function M.forget(buf)
  trees[buf] = nil
end

--- @param node TSNode
---
--- @param row integer 0-indexed
---
--- @param col integer 0-indexed
---
--- @return boolean
local function covers(node, row, col)
  local start_r, start_c, end_r, end_c = node:range()
  local after_start = row > start_r or (row == start_r and col >= start_c)
  local before_end = row < end_r or (row == end_r and col < end_c)
  return after_start and before_end
end

--- @class scope.Link
--- @field node TSNode
--- @field name string

--- Named nodes from the cached tree that contain `pos`, outermost first.
---
--- @param buf integer? buffer number (default: current buffer)
---
--- @param pos [integer, integer]? (1, 0) indexed position (default: cursor in the current window)
---
--- @return scope.Link[] empty when the buffer has no cached tree
function M.chain(buf, pos)
  if buf == nil or buf == 0 then
    buf = vim.api.nvim_get_current_buf()
  end
  pos = pos or vim.api.nvim_win_get_cursor(0)
  local row, col = pos[1] - 1, pos[2]

  local links = {}
  local entries = trees[buf] or {}
  local wrapped
  local i = 1
  while i <= #entries do
    local entry = entries[i]
    if covers(entry.node, row, col) then
      -- A wrapper, such as an export or a decorator, already took the name of the definition inside it.
      local name = not (wrapped and wrapped:equal(entry.node)) and selection.name(entry.node, buf)
      if name then
        table.insert(links, { node = entry.node, name = name })
      end
      wrapped = selection.unwrap(entry.node)
      entries, i = entry.children, 1
    else
      i = i + 1
    end
  end
  return links
end

return M
