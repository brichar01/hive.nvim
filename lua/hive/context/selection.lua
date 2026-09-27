local M = {}

--- @param node TSNode
---
--- @return integer, integer 1-indexed first and last line
function M.node_lines(node)
  local start_r, _, end_r, end_c = node:range()
  if end_c == 0 then
    end_r = end_r - 1
  end
  return start_r + 1, end_r + 1
end

--- @param node TSNode
---
--- @param types string[]|fun(node: TSNode): boolean node types, or a predicate
local function matches(node, types)
  if type(types) == "function" then
    return types(node)
  end
  for _, name in ipairs(types) do
    if name == node:type() then
      return true
    end
  end
  return false
end

--- @param types string[]|fun(node: TSNode): boolean target types, or a predicate, traverse until one is found
---
--- @param pos [integer, integer] (1, 0) indexed cursor position (eg. from vim.api.nvim_win_get_cursor(0))
---
--- @param buf integer? buffer index, 0 for current buffer
---
--- @param range [integer, integer]? 1-indexed lines already selected, the node found must extend past them
---
---@return TSNode? Innermost node at `pos` of a target type, or nil if none are found
function M.parent_by_type(types, pos, buf, range)
  buf = buf or 0
  local row, col = unpack(pos)
  local parser = vim.treesitter.get_parser(buf)
  if not parser then
    return nil
  end
  parser:parse(true)

  -- Leading whitespace belongs to no node inside the enclosing construct.
  local line = vim.api.nvim_buf_get_lines(buf, row - 1, row, false)[1] or ""
  local first = line:find("%S")
  if first and col < first - 1 then
    col = first - 1
  end

  local node = vim.treesitter.get_node({ bufnr = buf, pos = { row - 1, col } })

  while node do
    if matches(node, types) then
      if not range then
        return node
      end
      local first_line, last_line = M.node_lines(node)
      if first_line < range[1] or last_line > range[2] then
        return node
      end
    end
    node = node:parent()
  end
  return nil
end

--- 0-indexed (row, col) tuple.
--- (default: window-local cursor)
--- @param pos [integer, integer]?
---
--- @param buf integer?
--- Buffer number (nil or 0 for current buffer)
function M._walk_up_tree(pos, buf)
  if not pos then
    pos = vim.api.nvim_win_get_cursor(0)
  end
  local row, col = unpack(pos)
  local parser = vim.treesitter.get_parser(buf or 0)
  if not parser then
    return {}
  end
  parser:parse(true)

  local node = vim.treesitter.get_node({ bufnr = buf or 0, pos = { row - 1, col } })

  local tree = {}
  while node do
    table.insert(tree, node:type())
    node = node:parent()
  end
  return tree
end

--- Node types for a named construct, keyed by filetype.
---
--- A filetype with no entry for a kind has no such construct, so the command
--- that asks for it does nothing. `literal` and `container` are not commands:
--- `literal` holds table, struct and collection literals, which bound a
--- selection but are not part of an outline. `container` holds the roots and
--- declarations that complete a filetype's `parent_types` list.
M.node_types = {
  call = {
    python = { "call" },
    c = { "call_expression" },
    rust = { "call_expression", "macro_invocation" },
    lua = { "function_call" },
    typescript = { "call_expression", "new_expression" },
  },
  literal = {
    python = { "dictionary", "list", "set", "tuple" },
    c = { "initializer_list" },
    rust = { "struct_expression", "array_expression" },
    lua = { "table_constructor" },
    typescript = { "object", "array" },
  },
  method = {
    python = { "function_definition", "decorated_definition" },
    c = { "function_definition" },
    rust = { "function_item" },
    lua = { "function_declaration", "function_definition" },
    typescript = {
      "method_definition",
      "function_declaration",
      "function_expression",
      "generator_function_declaration",
      "arrow_function",
    },
  },
  class = {
    python = { "class_definition" },
    rust = { "impl_item", "trait_item", "struct_item", "enum_item" },
    typescript = { "class_declaration", "interface_declaration" },
  },
  container = {
    python = { "module" },
    c = {
      "preproc_function_def",
      "struct_specifier",
      "union_specifier",
      "enum_specifier",
      "type_definition",
      "translation_unit",
    },
    rust = { "union_item", "macro_definition", "mod_item", "source_file" },
    lua = { "chunk" },
    typescript = {
      "type_alias_declaration",
      "enum_declaration",
      "internal_module",
      "export_statement",
      "program",
    },
  },
}

--- Kinds that make up `parent_types`. A call is asked for by name, never
--- expanded into.
local parent_kinds = { "literal", "method", "class", "container" }

--- @param kind string key of `M.node_types`
---
--- @param ft string? filetype to look up (default: current buffer)
---
--- @return table types for `parent_by_type`, empty where the language has no such construct
function M.types_for_kind(kind, ft)
  return M.node_types[kind][ft or vim.bo.filetype] or {}
end

--- Parent node types worth selecting, keyed by filetype.
---
--- Parsers name the same construct differently, so a shared list picks the wrong
--- node in half the languages.
M.parent_types = {}
for _, kind in ipairs(parent_kinds) do
  for ft, types in pairs(M.node_types[kind]) do
    M.parent_types[ft] = vim.list_extend(M.parent_types[ft] or {}, types)
  end
end

--- Types for a filetype with no `node_types` entry.
M.parent_fallback = {
  "function_definition",
  "function_declaration",
  "function_item",
  "method_definition",
  "class_definition",
  "class_declaration",
  "struct_item",
  "impl_item",
  "table_constructor",
  "chunk",
  "module",
  "program",
  "source_file",
  "translation_unit",
}

local element_suffixes = { "_statement$", "_declaration$", "_definition$", "_item$" }
local element_types = { declaration = true, preproc_include = true, preproc_def = true }
local body_types = { compound_statement = true, statement_block = true }
-- Lua has no statement node for a bare call: it is a `function_call` directly under the block.
local statement_parents = { chunk = true, block = true }

--- @param node TSNode
---
--- @return boolean true for a function or class definition, declaration or statement
function M.is_element(node)
  local node_type = node:type()
  if body_types[node_type] then
    return false
  end
  if element_types[node_type] then
    return true
  end
  for _, suffix in ipairs(element_suffixes) do
    if node_type:match(suffix) then
      return true
    end
  end
  local parent = node:parent()
  return node_type == "function_call" and parent ~= nil and statement_parents[parent:type()] == true
end

--- Fields of a wrapper node, such as a decorated or exported definition, that hold the definition.
local wrapped_fields = { "definition", "declaration" }

--- Text of a node up to its body, on one line, without the trailing `:`, `{` or `=>`.
--- A node with no body, such as a call or a statement, gives its first line.
---
--- @param node TSNode
---
--- @param lines string[] text the node was parsed from
---
--- @return string
function M.signature(node, lines)
  for _, field in ipairs(wrapped_fields) do
    node = node:field(field)[1] or node
  end
  local body = node:field("body")[1]
  local text
  if body then
    local start_r, start_c = node:start()
    local end_r, end_c = body:start()
    local head = vim.list_slice(lines, start_r + 1, end_r + 1)
    head[#head] = head[#head]:sub(1, end_c)
    head[1] = head[1]:sub(start_c + 1)
    text = table.concat(head, " ")
    text = text:gsub("%s*[:{]%s*$", ""):gsub("%s*=>%s*$", "")
  else
    text = lines[node:start() + 1]
  end
  return vim.trim(text:gsub("%s+", " "))
end

--- @param ft string? filetype to look up (default: current buffer)
---
--- @return table types for `parent_by_type`
function M.types_for(ft)
  return M.parent_types[ft or vim.bo.filetype] or M.parent_fallback
end

--- Select a node, leaving the cursor at its end.
---
--- @param node TSNode
---
--- @param visual string? `V` linewise or `v` charwise (default: `V`)
function M.select_node(node, visual)
  visual = visual or "V"
  local start_r, start_c, end_r, end_c = node:range()
  if end_c == 0 then
    end_r = end_r - 1
    end_c = #vim.api.nvim_buf_get_lines(0, end_r, end_r + 1, false)[1]
  end

  if vim.fn.mode():match("[vV\22]") then
    vim.cmd("normal! \27")
  end
  vim.api.nvim_win_set_cursor(0, { start_r + 1, start_c })
  vim.cmd("normal! " .. visual)
  vim.api.nvim_win_set_cursor(0, { end_r + 1, visual == "V" and 0 or math.max(end_c - 1, 0) })
end

return M
