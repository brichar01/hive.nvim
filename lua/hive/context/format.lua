local M = {}

--- Split a node's text at the cursor.
---
--- The last prefix line and the first suffix line are the partial line the
--- cursor sits on, so joining them restores it.
---
--- @param pos [integer, integer] (1, 0) indexed cursor position (eg. from vim.api.nvim_win_get_cursor(0))
---
--- @param node TSNode node whose range is split
---
--- @param buf integer? buffer index, 0 for current buffer
---
--- @param markers { prefix: string?, suffix: string? }? tokens prepended to the first line of each half
---
--- @return table? prefix lines from the node start to the cursor, nil if the cursor is outside the node
---
--- @return table? suffix lines from the cursor to the node end, nil if the cursor is outside the node
function M.split_at_cursor(pos, node, buf, markers)
  buf = buf or 0
  markers = markers or {}
  local row, col = unpack(pos)
  row = row - 1
  local start_r, start_c, end_r, end_c = node:range()

  if row < start_r or (row == start_r and col < start_c) then
    return nil
  end
  if row > end_r or (row == end_r and col > end_c) then
    return nil
  end

  local prefix = vim.api.nvim_buf_get_text(buf, start_r, start_c, row, col, {})
  local suffix = vim.api.nvim_buf_get_text(buf, row, col, end_r, end_c, {})

  if markers.prefix then
    prefix[1] = markers.prefix .. prefix[1]
  end
  if markers.suffix then
    suffix[1] = markers.suffix .. suffix[1]
  end
  return prefix, suffix
end

return M
