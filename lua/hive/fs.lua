--- Buffer-backed file content for the agent's `read`, `write` and `edit` tools.
---
--- A file with a loaded buffer is served from the buffer, as bytes. A write to a
--- file with no buffer loads one, so the agent never writes to disk. `fileformat`,
--- `bomb` and `eol` survive a round trip, so Pi's own line ending and BOM
--- handling sees the real file.
---
--- The service calls `read`, `write` and `loaded` through |nvim_exec_lua()|.

---@class Hive.Fs
local M = {}

local BOM = "\239\187\191"

---@type table<string, string>
local SEPARATORS = { unix = "\n", dos = "\r\n", mac = "\r" }

---@param path string
---@return string|nil
local function realpath(path)
  return vim.uv.fs_realpath(path)
end

---Find the loaded file buffer for `path`.
---@param path string absolute path
---@return integer|nil buf
function M.find(path)
  local target = vim.fs.normalize(path)
  local real = realpath(target)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == "" then
      local name = vim.api.nvim_buf_get_name(buf)
      if name ~= "" then
        name = vim.fs.normalize(name)
        if name == target or (real ~= nil and realpath(name) == real) then
          return buf
        end
      end
    end
  end
  return nil
end

---@param buf integer
---@return boolean empty true for a buffer with no lines at all, such as one read from an empty file
local function is_empty(buf)
  return vim.api.nvim_buf_call(buf, function()
    return vim.fn.line2byte(vim.fn.line("$") + 1) == -1
  end)
end

---The file's bytes as the buffer holds them, before any `fileencoding` conversion.
---
--- A missing final newline reads as missing even when `fixendofline` would add
--- it on `:write`, so the agent sees the file as it is on disk.
---@param buf integer
---@return string
function M.content(buf)
  if is_empty(buf) then
    return ""
  end

  local sep = SEPARATORS[vim.bo[buf].fileformat] or "\n"
  local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, true), sep)
  if vim.bo[buf].eol then
    text = text .. sep
  end
  if vim.bo[buf].bomb then
    text = BOM .. text
  end
  return text
end

---Choose the `fileformat` that reads `text` back as it is, the way Vim's own
---detection would. Text with no line break keeps the buffer's format.
---@param text string
---@param current string the buffer's `fileformat`
---@return string fileformat
local function detect_format(text, current)
  if not text:find("\n", 1, true) then
    if current == "mac" or not text:find("\r", 1, true) then
      return current
    end
    return "unix"
  end
  -- dos only when every line feed ends a CRLF, otherwise the CRs stay in the lines.
  if not text:find("[^\r]\n") and text:sub(1, 1) ~= "\n" then
    return "dos"
  end
  return "unix"
end

---Replace only the lines that differ, so marks and the cursor outside the change stay put.
---@param buf integer
---@param lines string[]
local function replace_lines(buf, lines)
  local old = vim.api.nvim_buf_get_lines(buf, 0, -1, true)
  local first = 1
  while first <= #old and first <= #lines and old[first] == lines[first] do
    first = first + 1
  end
  local old_last, new_last = #old, #lines
  while old_last >= first and new_last >= first and old[old_last] == lines[new_last] do
    old_last = old_last - 1
    new_last = new_last - 1
  end
  if first > old_last and first > new_last then
    return
  end
  vim.api.nvim_buf_set_lines(buf, first - 1, old_last, true, vim.list_slice(lines, first, new_last))
end

---Load `content` into `buf`
---@param buf integer
---@param content string
function M.set_content(buf, content)
  if M.content(buf) == content then
    return
  end
  if not vim.bo[buf].modifiable then
    error(("buffer %d is not modifiable"):format(buf))
  end

  local bomb = content:sub(1, #BOM) == BOM
  local text = bomb and content:sub(#BOM + 1) or content

  local format = detect_format(text, vim.bo[buf].fileformat)
  local sep = SEPARATORS[format]

  local eol = text ~= "" and text:sub(-#sep) == sep
  if eol then
    text = text:sub(1, -#sep - 1)
  end

  local lines = vim.split(text, sep, { plain = true })
  local was_empty = is_empty(buf)
  replace_lines(buf, lines)
  -- An empty buffer stays empty after one blank line is set, and would then read back as "".
  if was_empty and eol and #lines == 1 and lines[1] == "" and is_empty(buf) then
    vim.api.nvim_buf_set_lines(buf, 0, -1, true, { "", "" })
    vim.api.nvim_buf_set_lines(buf, 1, 2, true, {})
  end

  local bo = vim.bo[buf]
  if bo.fileformat ~= format then
    bo.fileformat = format
  end
  if bo.bomb ~= bomb then
    bo.bomb = bomb
  end
  if bo.eol ~= eol then
    bo.eol = eol
  end
end

-- -------------------------------------------- Entry points for the service --------------------------------------------

---@param path string absolute path
---@return boolean loaded true when a buffer serves `path`
function M.loaded(path)
  return M.find(path) ~= nil
end

---@param path string absolute path
---@return string|nil content the buffer's bytes, nil when no buffer serves `path`
function M.read(path)
  local buf = M.find(path)
  return buf and M.content(buf) or nil
end

---Load `path` into a listed buffer: the file's content when it exists, empty otherwise.
---@param path string absolute path
---@return integer buf
function M.open(path)
  local buf = vim.fn.bufadd(path)
  -- Called through nvim_exec_lua, a swap file left by another Neovim or a crash raises E325
  -- but leaves the buffer loaded, so unload it before a later write finds it.
  local ok, err = pcall(vim.fn.bufload, buf)
  if not ok then
    pcall(vim.api.nvim_buf_delete, buf, { unload = true, force = true })
    if tostring(err):find("E325", 1, true) then
      error(("%s has a swap file, so another Neovim may be editing it"):format(path), 0)
    end
    error(err, 0)
  end
  vim.bo[buf].buflisted = true
  return buf
end

---Write `content` to the buffer for `path`, loading one when there is none. Nothing reaches disk.
---@param path string absolute path
---@param content string
function M.write(path, content)
  M.set_content(M.find(path) or M.open(path), content)
end

return M
