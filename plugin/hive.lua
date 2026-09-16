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

-- Token budget used by :Hive complete. The Lua API takes it as a parameter.
local DEFAULT_MAX_TOKENS = 256

---@class Hive.Subcommand
---@field impl fun(args: string[]) run the subcommand with the remaining arguments
---@field complete? fun(arg_lead: string): string[] completions for the subcommand's own arguments

---@type table<string, Hive.Subcommand>
local sub_cmds = {
  complete = {
    impl = function(args)
      local prompt = vim.trim(table.concat(args, " "))
      if prompt == "" then
        return require("hive.util").error("Hive complete: missing prompt")
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

  health = {
    impl = function()
      vim.cmd.checkhealth("hive")
    end,
  },
}

local sub_cmd_keys = vim.tbl_keys(sub_cmds)
table.sort(sub_cmd_keys)

---@param opts table command options from nvim_create_user_command
local function main_cmd(opts)
  local name = opts.fargs[1]
  local sub_cmd = name and sub_cmds[name]
  if not sub_cmd then
    return require("hive.util").error(("invalid subcommand: %s"):format(name or "<none>"))
  end
  sub_cmd.impl(vim.list_slice(opts.fargs, 2))
end

vim.api.nvim_create_user_command("Hive", main_cmd, {
  nargs = "*",
  desc = "Query the OpenAI-compatible completions endpoint",
  complete = function(arg_lead, cmd_line, _)
    -- Completing the subcommand name itself.
    local args = vim.split(vim.trim(cmd_line), "%s+")
    if #args <= 1 or (#args == 2 and arg_lead ~= "") then
      return vim.tbl_filter(function(key)
        return key:find(arg_lead, 1, true) == 1
      end, sub_cmd_keys)
    end

    local sub_cmd = sub_cmds[args[2]]
    return sub_cmd and sub_cmd.complete and sub_cmd.complete(arg_lead) or {}
  end,
})
