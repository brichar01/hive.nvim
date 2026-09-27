local selection = require("hive.context.selection")

local M = {}

--- @type table<string, vim.treesitter.Query|false>
local queries = {}

local outline_kinds = { "method", "class", "container" }

--- @param ft string
---
--- @return string[] node types for an outline of `ft`
local function outline_types(ft)
  local types = {}
  for _, kind in ipairs(outline_kinds) do
    vim.list_extend(types, selection.types_for_kind(kind, ft))
  end
  return #types > 0 and types or selection.parent_fallback
end

--- @param ft string
---
--- @param lang string
---
--- @return vim.treesitter.Query? query capturing `selection.types_for(ft)` as `@node`
local function query_for(ft, lang)
  local key = ft .. ":" .. lang
  if queries[key] == nil then
    -- A type the grammar does not define fails the whole query, and the fallback list spans grammars.
    local symbols = vim.treesitter.language.inspect(lang).symbols
    local patterns = {}
    for _, node_type in ipairs(outline_types(ft)) do
      if symbols[node_type] then
        table.insert(patterns, "(" .. node_type .. ")")
      end
    end
    queries[key] = #patterns > 0 and vim.treesitter.query.parse(lang, "[" .. table.concat(patterns, " ") .. "] @node")
      or false
  end
  return queries[key] or nil
end

--- @class gather.Entry
--- @field node TSNode
--- @field children gather.Entry[] nearest matching descendants, in document order

--- @param outer TSNode
---
--- @param inner TSNode
---
--- @return boolean true when `inner` lies within `outer`
local function contains(outer, inner)
  local o_sr, o_sc, o_er, o_ec = outer:range()
  local i_sr, i_sc, i_er, i_ec = inner:range()
  local starts_after = i_sr > o_sr or (i_sr == o_sr and i_sc >= o_sc)
  local ends_before = i_er < o_er or (i_er == o_er and i_ec <= o_ec)
  return starts_after and ends_before
end

--- Parse text with treesitter and collect its method, class and container nodes.
---
--- @param lines string[] text to parse
---
--- @param ft string filetype of the text
---
--- @return gather.Entry[] outermost matches below the root, empty when the filetype has no parser
function M.nodes(lines, ft)
  local lang = vim.treesitter.language.get_lang(ft)
  if not lang then
    return {}
  end

  local source = table.concat(lines, "\n")
  local has_parser, parser = pcall(vim.treesitter.get_string_parser, source, lang)
  if not has_parser then
    return {}
  end

  local query = query_for(ft, lang)
  if not query then
    return {}
  end

  local roots = {}
  --- @type gather.Entry[]
  local open = {}
  -- Captures arrive in document order with each ancestor before its descendants.
  local root = parser:parse()[1]:root()
  for _, node in query:iter_captures(root, source) do
    if not node:equal(root) then
      while #open > 0 and not contains(open[#open].node, node) do
        table.remove(open)
      end
      local entry = { node = node, children = {} }
      table.insert(#open > 0 and open[#open].children or roots, entry)
      table.insert(open, entry)
    end
  end
  return roots
end

--- Read a file, detect its filetype and collect its nodes with `nodes`.
---
--- @param filename string path to the file to parse
---
--- @return gather.Entry[] outermost matches, empty when the file is unreadable or has no parser
---
--- @return string[] lines of the file, for `format`
function M.nodes_from_file(filename)
  local ok, lines = pcall(vim.fn.readfile, filename)
  if not ok then
    return {}, {}
  end
  local ft = vim.filetype.match({ filename = filename, contents = lines })
  if not ft then
    return {}, lines
  end
  return M.nodes(lines, ft), lines
end

--- Draw the output of `nodes` as a tree of signatures.
---
--- @param entries gather.Entry[]
---
--- @param lines string[] text the nodes were parsed from
---
--- @return string[] one line for each node
function M.format(entries, lines)
  local out = {}
  local function draw(children, prefix)
    for i, entry in ipairs(children) do
      local last = i == #children
      table.insert(out, prefix .. (last and "└─ " or "├─ ") .. selection.signature(entry.node, lines))
      draw(entry.children, prefix .. (last and "   " or "│  "))
    end
  end
  for _, entry in ipairs(entries) do
    table.insert(out, selection.signature(entry.node, lines))
    draw(entry.children, "")
  end
  return out
end

-- ----------------------------------------------- LSP symbol gathering ------------------------------------------------

local lsp_timeout_ms = 2000

--- @param filename string
---
--- @return string[] lines from the loaded buffer when there is one, else from disk
---
--- @return string? ft filetype of the file
local function read(filename)
  local buf = vim.fn.bufnr(filename)
  if buf > 0 and vim.api.nvim_buf_is_loaded(buf) then
    return vim.api.nvim_buf_get_lines(buf, 0, -1, false), vim.bo[buf].filetype
  end
  local ok, lines = pcall(vim.fn.readfile, filename)
  if not ok then
    return {}, nil
  end
  return lines, vim.filetype.match({ filename = filename, contents = lines })
end

--- @param filename string
---
--- @return string path relative to the working directory where possible
local function relative(filename)
  return vim.fs.relpath(vim.uv.cwd() or "", filename) or filename
end

--- Run a position request against every client attached to `buf`.
---
--- @param buf integer
---
--- @param pos [integer, integer] (1, 0) indexed position of the symbol
---
--- @param method string LSP method returning locations
---
--- @param extra table? fields merged into the request params
---
--- @return vim.quickfix.entry[] locations sorted and without duplicates
local function locations(buf, pos, method, extra)
  local row, col = unpack(pos)
  local line = vim.api.nvim_buf_get_lines(buf, row - 1, row, false)[1] or ""
  local responses, err = vim.lsp.buf_request_sync(buf, method, function(client)
    local params = {
      textDocument = vim.lsp.util.make_text_document_params(buf),
      position = { line = row - 1, character = vim.str_utfindex(line, client.offset_encoding, col, false) },
    }
    return vim.tbl_extend("force", params, extra or {})
  end, lsp_timeout_ms)
  if not responses then
    error(("%s: %s"):format(method, err))
  end

  local items, seen = {}, {}
  for client_id, response in pairs(responses) do
    local result = response.result
    local client = vim.lsp.get_client_by_id(client_id)
    if result and client then
      if result.uri or result.targetUri then
        result = { result }
      end
      for _, item in ipairs(vim.lsp.util.locations_to_items(result, client.offset_encoding)) do
        local key = item.filename .. ":" .. item.lnum
        if not seen[key] then
          seen[key] = true
          table.insert(items, item)
        end
      end
    end
  end
  table.sort(items, function(a, b)
    if a.filename ~= b.filename then
      return a.filename < b.filename
    end
    return a.lnum < b.lnum
  end)
  return items
end

--- @param entries gather.Entry[]
---
--- @param row integer 0-indexed line of the symbol name
---
--- @return TSNode? innermost node whose head, before its body, holds `row`
local function defining_node(entries, row)
  local found
  for _, entry in ipairs(entries) do
    local start_r, _, end_r = entry.node:range()
    if start_r <= row and row <= end_r then
      local body = entry.node:field("body")[1]
      if row <= (body and body:start() or start_r) then
        found = entry.node
      end
      return defining_node(entry.children, row) or found
    end
  end
  return found
end

--- Source of the definitions of the symbol at `pos`.
---
--- Each definition is a `<path>:<first>-<last>` header followed by the text of the enclosing
--- method, class or container. A symbol with no such node, such as a variable, gives its line.
---
--- @param buf integer? buffer holding the symbol, 0 for current buffer
---
--- @param pos [integer, integer] (1, 0) indexed position of the symbol
---
--- @return string[] definitions separated by blank lines, empty when the server finds none
function M.implementation(buf, pos)
  if not buf or buf == 0 then
    buf = vim.api.nvim_get_current_buf()
  end
  local out = {}
  for _, item in ipairs(locations(buf, pos, "textDocument/implementation")) do
    local lines, ft = read(item.filename)
    local node = ft and defining_node(M.nodes(lines, ft), item.lnum - 1)
    local first, last = item.lnum, item.lnum
    if node then
      first, last = selection.node_lines(node)
    end

    if #out > 0 then
      table.insert(out, "")
    end
    local ref = relative(item.filename) .. ":" .. first
    table.insert(out, last > first and ref .. "-" .. last or ref)
    vim.list_extend(out, vim.list_slice(lines, first, last))
  end
  return out
end

--- References to the symbol at `pos`, not counting its declaration.
---
--- Each file is a path header followed by one `  <line>: <text>` entry for each reference.
---
--- @param buf integer? buffer holding the symbol, 0 for current buffer
---
--- @param pos [integer, integer] (1, 0) indexed position of the symbol
---
--- @return string[] references grouped by file, empty when the server finds none
function M.usages(buf, pos)
  if not buf or buf == 0 then
    buf = vim.api.nvim_get_current_buf()
  end
  local out = {}
  local current
  local refs = locations(buf, pos, "textDocument/references", { context = { includeDeclaration = false } })
  for _, item in ipairs(refs) do
    if item.filename ~= current then
      current = item.filename
      table.insert(out, relative(item.filename))
    end
    table.insert(out, ("  %d: %s"):format(item.lnum, vim.trim(item.text)))
  end
  return out
end

return M
