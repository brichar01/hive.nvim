--- Reads the workbench's `.log` file and shows one entry's raw content in the buffer.
---
--- The workbench shows only a message's text. Its thinking and tool calls go to
--- `<workbench>.log` beside it, one JSON object per line. Each object has the full
--- entry `id`, but a workbench header shows only its first eight characters, so
--- entries are looked up by prefix.

---@class Hive.Log
local M = {}

local ns = vim.api.nvim_create_namespace("hive.log")

---The log beside the current buffer, falling back to the current workbench's log.
---@return string
function M.path()
  local name = vim.api.nvim_buf_get_name(0)
  if name ~= "" then
    local sibling = vim.fn.fnamemodify(name, ":r") .. ".log"
    if vim.uv.fs_stat(sibling) then
      return sibling
    end
  end
  return vim.fn.fnamemodify(require("hive.workbench").current(), ":r") .. ".log"
end

---@param path string
---@return string[]|nil lines
---@return string|nil err
local function read(path)
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok then
    return nil, ("could not read %s"):format(path)
  end
  return lines
end

---@class Hive.Log.Entry
---@field id string full entry id, whose first eight characters are the workbench hash
---@field ts? string when the entry was written
---@field type string `thinking` or `tool_call`
---@field text? string the thinking text
---@field name? string the tool's name
---@field args? any the tool call's arguments

---Find the log entries whose id starts with `hash`.
---@param hash string message hash, with or without a leading `#`
---@return Hive.Log.Entry[]|nil entries
---@return string|nil err
function M.find(hash)
  if hash == nil or hash == "" then
    return nil, "missing message hash"
  end
  hash = hash:gsub("^#", "")

  local path = M.path()
  local lines, err = read(path)
  if not lines then
    return nil, err
  end

  local entries = {}
  for _, line in ipairs(lines) do
    if line ~= "" then
      local ok, entry = pcall(vim.json.decode, line)
      if ok and type(entry) == "table" and type(entry.id) == "string" and vim.startswith(entry.id, hash) then
        entries[#entries + 1] = entry
      end
    end
  end

  if #entries == 0 then
    return nil, ("no message matching %s in %s"):format(hash, path)
  end
  return entries
end

---@param entry Hive.Log.Entry
---@return string label what kind of entry this is, for its heading
local function label(entry)
  if entry.type == "tool_call" then
    return ("Tool call (%s)"):format(entry.name or "?")
  elseif entry.type == "thinking" then
    return "Thinking"
  end
  return entry.type or "Entry"
end

---@param entry Hive.Log.Entry
---@return string[] lines the entry's content
local function content(entry)
  local text
  if entry.type == "thinking" then
    text = entry.text or ""
  elseif entry.type == "tool_call" then
    text = entry.args == nil and "{}" or vim.json.encode(entry.args)
  else
    text = vim.json.encode(entry)
  end
  return vim.split(text, "\n", { plain = true })
end

---Render entries as the lines shown below the cursor.
---@param entries Hive.Log.Entry[]
---@return string[]
function M.render(entries)
  local lines = {}
  for i, entry in ipairs(entries) do
    if i > 1 then
      lines[#lines + 1] = ""
    end
    lines[#lines + 1] = label(entry) .. ":"
    vim.list_extend(lines, content(entry))
  end
  return lines
end

---Show the entries for `hash` as virtual lines below the cursor.
---@param hash string message hash, with or without a leading `#`
---@return string|nil err
function M.show(hash)
  local entries, err = M.find(hash)
  if not entries then
    return err
  end

  local buf = vim.api.nvim_get_current_buf()
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {
    virt_lines = vim.tbl_map(function(line)
      return { { line, "Comment" } }
    end, M.render(entries)),
  })
end

---Complete the hashes in the current log.
---@param arg_lead string
---@return string[]
function M.complete(arg_lead)
  local lines = read(M.path())
  if not lines then
    return {}
  end

  local seen, hashes = {}, {}
  for _, line in ipairs(lines) do
    local ok, entry = pcall(vim.json.decode, line)
    if ok and type(entry) == "table" and type(entry.id) == "string" then
      local hash = entry.id:sub(1, 8)
      if not seen[hash] and vim.startswith(hash, arg_lead) then
        seen[hash] = true
        hashes[#hashes + 1] = hash
      end
    end
  end
  table.sort(hashes)
  return hashes
end

return M
