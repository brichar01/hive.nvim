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

function M.full()
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" then
    error("buffer has no file")
  end

  return vim.fs.abspath(file)
end

return M
