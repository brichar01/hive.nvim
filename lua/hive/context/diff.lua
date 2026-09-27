local M = {}

--- Diff of a file on disk against a revision, covering both staged and unstaged changes.
---
--- @param filename string path to the file
---
--- @param rev string? revision to diff against, `HEAD` when nil
---
--- @return string[] lines of the unified diff, empty when the file has no changes
function M.file(filename, rev)
  local path = vim.fs.abspath(filename)
  local cmd = { "git", "diff", rev or "HEAD", "--", path }
  local result = vim.system(cmd, { cwd = vim.fs.dirname(path), text = true }):wait()
  if result.code ~= 0 then
    error("git diff: " .. vim.trim(result.stderr or ""))
  end

  return vim.split(result.stdout or "", "\n", { plain = true, trimempty = true })
end

return M
