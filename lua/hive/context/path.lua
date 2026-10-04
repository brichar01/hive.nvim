local M = {}

function M.relative()
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" then
    error("buffer has no file")
  end

  local root = vim.uv.cwd()
  if root == nil then
    error("no root")
  end
  local path = vim.fs.relpath(root, file) or file

  return path
end

function M.relative_with_line(line1, line2)
  local ref = M.relative() .. ":" .. line1
  if line2 > line1 then
    ref = ref .. "-" .. line2
  end
  return ref
end

---`text` under its `<path>:<line1>-<line2>` reference, or `text` alone for a buffer with no file.
---@param line1 integer
---@param line2 integer
---@param text string
---@return string
function M.snippet(line1, line2, text)
  local ok, ref = pcall(M.relative_with_line, line1, line2)
  return ok and ref .. "\n" .. text or text
end

function M.full()
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" then
    error("buffer has no file")
  end

  return vim.fs.abspath(file)
end

return M
