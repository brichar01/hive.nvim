-- User-facing commands. Every require() lives inside a callback so the plugin
-- modules are only loaded once the user actually invokes a subcommand.
--
-- RESOURCES:
--  - :help nvim_create_user_command()
--  - https://github.com/lumen-oss/nvim-best-practices?tab=readme-ov-file#speaking_head-user-commands

if vim.g.loaded_hive then
  return
end
vim.g.loaded_hive = true

-- Token budgets used by :HiveBare. The Lua API takes them as a parameter.
local DEFAULT_MAX_TOKENS = 256
local DEFAULT_FIM_MAX_TOKENS = 128

---@class Hive.Subcommand
---@field impl fun(args: string[], opts: table) run the subcommand with the remaining arguments and the command options
---@field complete? fun(arg_lead: string, args: string[]): string[] completions for the subcommand's own arguments, given the ones before `arg_lead`

---@param words string[]
---@return fun(arg_lead: string): string[]
local function complete_from(words)
  return function(arg_lead)
    return vim.tbl_filter(function(word)
      return word:find(arg_lead, 1, true) == 1
    end, words)
  end
end

---@param args string[]
---@return string register named by the first argument, `+` when there is none
local function register_arg(args)
  return args[1] or "+"
end

---@param opts table command options from nvim_create_user_command
---@return [integer, integer]|nil lines the command was given, nil without a range
local function range_of(opts)
  return opts.range > 0 and { opts.line1, opts.line2 } or nil
end

---@param node TSNode
---@return string `<path>:<first>-<last>` for the node in the current buffer
local function node_ref(node)
  local first, last = require("hive.context.selection").node_lines(node)
  return require("hive.context.path").relative_with_line(first, last)
end

---@param kind string key of `hive.context.selection.node_types`, or `"parent"` for any parent type
---@return fun(args: string[], opts: table)
local function select_impl(kind)
  return function(_, opts)
    local selection = require("hive.context.selection")
    local range = range_of(opts)
    local pos = range and { range[1], 0 } or vim.api.nvim_win_get_cursor(0)
    local types = kind == "parent" and selection.types_for() or selection.types_for_kind(kind)
    local node = selection.parent_by_type(types, pos, 0, range)
    if not node then
      return require("hive.util").error(("no enclosing %s"):format(kind))
    end
    selection.select_node(node, kind == "call" and "v" or "V")
  end
end

local select_kinds = { "call", "method", "class", "parent" }

-- ----------------------------------------------------- :HiveBare -----------------------------------------------------

---@type table<string, Hive.Subcommand>
local bare_cmds = {
  complete = {
    impl = function(args)
      local prompt = vim.trim(table.concat(args, " "))
      if prompt == "" then
        return require("hive.util").error("HiveBare complete: missing prompt")
      end

      local Util = require("hive.util")
      Util.info("requesting completion...")
      require("hive").completions(prompt, "", DEFAULT_MAX_TOKENS, function(err, completion)
        if err then
          return Util.error(err)
        end
        Util.info(completion.text)
      end)
    end,
  },

  -- Fill the cursor position inside the enclosing function and append the result to the workbench.
  fim = {
    impl = function(args)
      local Util = require("hive.util")
      local max_tokens = tonumber(args[1]) or DEFAULT_FIM_MAX_TOKENS
      if max_tokens < 1 or max_tokens % 1 ~= 0 then
        return Util.error("HiveBare fim: max tokens must be a positive integer")
      end

      local selection = require("hive.context.selection")
      local pos = vim.api.nvim_win_get_cursor(0)
      local node = selection.parent_by_type(selection.types_for_kind("method"), pos)
      if not node then
        return Util.error("HiveBare fim: no function at the cursor")
      end

      local prefix, suffix = require("hive.context.format").split_at_cursor(pos, node, 0)
      if not prefix or not suffix then
        return Util.error("HiveBare fim: cursor outside the function")
      end

      local before = table.concat(prefix, "\n")
      local after = table.concat(suffix, "\n")
      local ref = node_ref(node)
      local at = ("%d:%d"):format(pos[1], pos[2])
      local workbench = require("hive.workbench").current()

      Util.info(("%s at %s, %d tokens"):format(ref, at, max_tokens))
      require("hive").completions(before, after, max_tokens, function(err, completion)
        if err or completion == nil then
          return Util.error(err or "no completion")
        end

        local lines = { ("%s @ %s -- %s"):format(ref, at, completion.finish_reason or "?") }
        vim.list_extend(lines, vim.split(before .. completion.text .. after, "\n", { plain = true }))

        vim.fn.writefile(lines, workbench, "a")
        vim.cmd.checktime()
      end)
    end,
  },

  health = {
    impl = function()
      vim.cmd.checkhealth("hive")
    end,
  },
}

-- --------------------------------------------------- :HiveContext ----------------------------------------------------

---@type table<string, Hive.Subcommand>
local context_cmds = {
  -- With a range, select the enclosing node that extends past it. Without one, the node at the cursor.
  select = {
    impl = function(args, opts)
      local kind = args[1]
      if not vim.tbl_contains(select_kinds, kind) then
        return require("hive.util").error(
          ("HiveContext select: expected one of %s"):format(table.concat(select_kinds, ", "))
        )
      end
      select_impl(kind)(args, opts)
    end,
    complete = complete_from(select_kinds),
  },

  -- With a range, copy `<path>:<line1>-<line2>`. Without one, copy the signature of the element at the
  -- cursor as `<text> [<path>:<line1>-<line2>]`.
  ref = {
    impl = function(_, opts)
      local path = require("hive.context.path")
      local ref
      if opts.range > 0 then
        ref = path.relative_with_line(opts.line1, opts.line2)
      else
        local selection = require("hive.context.selection")
        local node = selection.parent_by_type(selection.is_element, vim.api.nvim_win_get_cursor(0))
        if not node then
          return require("hive.util").error("HiveContext ref: no element at the cursor")
        end

        local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
        ref = ("%s [%s]"):format(selection.signature(node, lines), node_ref(node))
      end
      vim.fn.setreg("+", ref)
      vim.notify(ref)
    end,
  },

  -- Copy the outline of the buffer, or of only the selected lines, into a register.
  outline = {
    impl = function(args, opts)
      local gather = require("hive.context.gather")
      local first, last = 0, -1
      if opts.range > 0 then
        first, last = opts.line1 - 1, opts.line2
      end
      local lines = vim.api.nvim_buf_get_lines(0, first, last, false)

      local outline = gather.format(gather.nodes(lines, vim.bo.filetype), lines)
      if #outline == 0 then
        return require("hive.util").error("HiveContext outline: no nodes to outline")
      end

      local register = register_arg(args)
      vim.fn.setreg(register, outline, "l")
      vim.notify(("Copied %d outline lines to %s"):format(#outline, register))
    end,
  },

  -- Copy the definitions and references of the symbol at the cursor into a register.
  symbol = {
    impl = function(args)
      local gather = require("hive.context.gather")
      local pos = vim.api.nvim_win_get_cursor(0)
      local name = vim.fn.expand("<cword>")

      local implementation = gather.implementation(0, pos)
      local usages = gather.usages(0, pos)
      if #implementation == 0 and #usages == 0 then
        return require("hive.util").error("HiveContext symbol: no definition or references for " .. name)
      end

      local out = {}
      vim.list_extend(out, #implementation > 0 and implementation or { "(none)" })
      vim.list_extend(out, #usages > 0 and usages or { "(none)" })

      local register = register_arg(args)
      vim.fn.setreg(register, out, "l")
      vim.notify(("Copied %s: %d usage lines to %s"):format(name, #usages, register))
    end,
  },

  -- Copy the git diff of the buffer's file against `rev=<rev>` (default `HEAD`) into a register.
  diff = {
    impl = function(args)
      local register, rev = "+", nil
      for _, arg in ipairs(args) do
        local value = arg:match("^rev=(.+)$")
        if value then
          rev = value
        else
          register = arg
        end
      end

      local diff = require("hive.context.diff").file(require("hive.context.path").full(), rev)
      if #diff == 0 then
        return require("hive.util").error("HiveContext diff: no changes")
      end

      vim.fn.setreg(register, diff, "l")
      vim.notify(("Copied %d diff lines to %s"):format(#diff, register))
    end,
  },

  -- Append the nearest function to the workbench, split at the cursor as a FIM prompt.
  fim = {
    impl = function()
      local Util = require("hive.util")
      local selection = require("hive.context.selection")
      local pos = vim.api.nvim_win_get_cursor(0)
      local node = selection.parent_by_type(selection.types_for_kind("method"), pos)
      if not node then
        return Util.error("HiveContext fim: no function at the cursor")
      end

      local markers = { prefix = "<|fim_prefix|>", suffix = "<|fim_suffix|>" }
      local prefix, suffix = require("hive.context.format").split_at_cursor(pos, node, 0, markers)
      if not prefix then
        return Util.error("HiveContext fim: cursor outside the function")
      end

      local lines = { node_ref(node) }
      vim.list_extend(lines, suffix or {})
      vim.list_extend(lines, prefix)

      vim.fn.writefile(lines, require("hive.workbench").current(), "a")
      vim.cmd.checktime()
    end,
  },

  -- Copy the buffer's path relative to the working directory.
  rel = {
    impl = function()
      local ref = require("hive.context.path").relative()
      vim.fn.setreg("+", ref)
      vim.notify(ref)
    end,
  },

  -- Copy the buffer's absolute path.
  file = {
    impl = function()
      local path = require("hive.context.path").full()
      vim.fn.setreg("+", path)
      vim.notify("Copied " .. path)
    end,
  },

  workbench = {
    impl = function(args)
      local actions = require("hive.workbench").actions
      local action = actions[args[1] or "open"]
      if not action then
        return require("hive.util").error(("HiveContext workbench: unknown action: %s"):format(args[1]))
      end
      action()
    end,
    complete = complete_from({ "new", "next", "open", "previous" }),
  },
}

-- ------------------------------------------------------- :Hive -------------------------------------------------------

---@type table<string, Hive.Subcommand>
local agent_cmds = {
  -- Connect to the service on `rpc` (spawn it), `tcp <host>:<port>` or `pipe <path>`.
  attach = {
    impl = function(args)
      local Util = require("hive.util")
      local target = args[1] or "rpc"
      local err = require("hive.agent").attach(target, args[2])
      if err then
        return Util.error("Hive attach: " .. err)
      end
      Util.info(("attached over %s"):format(target))
    end,
    complete = complete_from({ "pipe", "rpc", "tcp" }),
  },

  -- Send the workbench's text after the last reply as the prompt.
  chat = {
    impl = function()
      local err = require("hive.agent").chat()
      if err then
        require("hive.util").error("Hive chat: " .. err)
      end
    end,
  },

  echo = {
    impl = function(args)
      local err = require("hive.agent").notify("echo", table.concat(args, " "))
      if err then
        require("hive.util").error("Hive echo: " .. err)
      end
    end,
  },

  -- Override the agent's `model`, `thinking` level or active `tools` until Neovim exits. With no value, show the
  -- current one.
  set = {
    impl = function(args)
      local Util = require("hive.util")
      local Agent = require("hive.agent")
      local setters = {
        model = function(values)
          return Agent.set_model(values[1])
        end,
        thinking = function(values)
          return Agent.set_thinking(values[1])
        end,
        tools = Agent.set_tools,
      }
      local key, values = args[1], vim.list_slice(args, 2)
      local setter = key and setters[key]
      if not setter then
        return Util.error(("Hive set: expected model, thinking or tools, got %s"):format(key or "<none>"))
      end
      if #values > 0 then
        local err = setter(values)
        if err then
          return Util.error("Hive set: " .. err)
        end
      end
      local value = Agent.settings()[key]
      Util.info(("%s: %s"):format(key, type(value) == "table" and table.concat(value, " ") or value))
    end,
    complete = function(arg_lead, args)
      if #args == 0 then
        return complete_from({ "model", "thinking", "tools" })(arg_lead)
      end
      if #args == 1 and args[1] == "thinking" then
        return complete_from(require("hive.config").thinking_levels)(arg_lead)
      end
      if args[1] == "tools" then
        return complete_from(require("hive.config").tools)(arg_lead)
      end
      return {}
    end,
  },

  prompt = {
    impl = function(args)
      local Util = require("hive.util")
      local text = vim.trim(table.concat(args, " "))
      if text == "" then
        return Util.error("Hive prompt: missing prompt")
      end
      local err = require("hive.agent").prompt(text)
      if err then
        Util.error("Hive prompt: " .. err)
      end
    end,
  },

  -- Ask for an instruction, then send the last visual selection's `<path>:<range>`, the selection and the instruction.
  selection = {
    impl = function(_, opts)
      local Util = require("hive.util")
      local lines = opts.range > 0
          and vim.fn.getregion(vim.fn.getpos("'<"), vim.fn.getpos("'>"), { type = vim.fn.visualmode() })
        or {}
      local text = vim.trim(table.concat(lines, "\n"))
      if text == "" then
        return Util.error("Hive selection: empty selection")
      end
      text = require("hive.context.path").snippet(vim.fn.line("'<"), vim.fn.line("'>"), text)

      vim.ui.input({ prompt = "Hive: " }, function(input)
        if input == nil then
          return
        end
        input = vim.trim(input)
        local err = require("hive.agent").prompt(input == "" and text or text .. "\n" .. input)
        if err then
          Util.error("Hive selection: " .. err)
        end
      end)
    end,
  },
}

-- --------------------------------------------------- Registration ----------------------------------------------------

---@param name string command name
---@param sub_cmds table<string, Hive.Subcommand>
---@param desc string
local function register(name, sub_cmds, desc)
  local keys = vim.tbl_keys(sub_cmds)
  table.sort(keys)

  vim.api.nvim_create_user_command(name, function(opts)
    local sub_name = opts.fargs[1]
    local sub_cmd = sub_name and sub_cmds[sub_name]
    if not sub_cmd then
      return require("hive.util").error(("%s: invalid subcommand: %s"):format(name, sub_name or "<none>"))
    end
    sub_cmd.impl(vim.list_slice(opts.fargs, 2), opts)
  end, {
    nargs = "*",
    range = true,
    desc = desc,
    complete = function(arg_lead, cmd_line, _)
      -- Completing the subcommand name itself.
      local args = vim.split(vim.trim(cmd_line), "%s+")
      if #args <= 1 or (#args == 2 and arg_lead ~= "") then
        return complete_from(keys)(arg_lead)
      end

      local sub_cmd = sub_cmds[args[2]]
      local before = vim.list_slice(args, 3, arg_lead == "" and #args or #args - 1)
      return sub_cmd and sub_cmd.complete and sub_cmd.complete(arg_lead, before) or {}
    end,
  })
end

register("Hive", agent_cmds, "Drive the agent service")
register("HiveBare", bare_cmds, "Send a prompt straight to the configured endpoint")
register("HiveContext", context_cmds, "Select, gather and copy code context")
