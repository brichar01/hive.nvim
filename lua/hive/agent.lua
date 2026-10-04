--- Connects to the Node service and owns its RPC channel.
---
--- Lua only notifies the service, and never calls |rpcrequest()|. The service
--- answers through |nvim_exec_lua()|, so Neovim never blocks on Node.

---@class Hive.Agent
local M = {}

local ROOT = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")
local MAIN = vim.fs.joinpath(ROOT, "node", "src", "main.ts")

-- Matches `KEY_ENV` in node/src/session.ts.
local KEY_ENV = "HIVE_AGENT_API_KEY"

---@class Hive.Agent.Connection
---@field channel integer
---@field stop fun() closes the channel the way its target needs

---@type Hive.Agent.Connection|nil
local connection = nil

---@param lines string[]
local function log_stderr(lines)
  local text = vim.trim(table.concat(lines, "\n"))
  if text ~= "" then
    require("hive.util").notify(text, vim.log.levels.DEBUG)
  end
end

---@param id integer
local function forget(id)
  if connection and connection.channel == id then
    connection = nil
  end
end

---Spawn the service and talk to it over its stdio.
---@return integer|nil channel
---@return string|nil err
function M.start_rpc()
  if vim.fn.executable("node") ~= 1 then
    return nil, "node executable not found in $PATH"
  end

  -- The key goes in the child's environment, never on its argv or in Neovim's environment.
  local key = require("hive.config").resolve_agent_api_key()
  local id = vim.fn.jobstart({ "node", MAIN, "--log-level", "warn" }, {
    rpc = true,
    cwd = ROOT,
    env = key and { [KEY_ENV] = key } or nil,
    on_stderr = function(_, data)
      log_stderr(data)
    end,
    on_exit = function(job, code)
      -- After stop() the connection is gone, so the SIGTERM exit is not reported.
      local current = connection ~= nil and connection.channel == job
      forget(job)
      if current and code ~= 0 then
        require("hive.util").error(("agent exited with code %d"):format(code))
      end
    end,
  })
  if id <= 0 then
    return nil, ("could not start the agent (jobstart returned %d)"):format(id)
  end

  connection = {
    channel = id,
    stop = function()
      vim.fn.jobstop(id)
    end,
  }
  return id
end

---@param mode "tcp"|"pipe"
---@param address string
---@return integer|nil channel
---@return string|nil err
local function start_socket(mode, address)
  local ok, id = pcall(vim.fn.sockconnect, mode, address, { rpc = true })
  if not ok or id == 0 then
    return nil, ("could not connect to %s (%s)"):format(address, ok and "sockconnect returned 0" or tostring(id))
  end

  connection = {
    channel = id,
    stop = function()
      pcall(vim.fn.chanclose, id)
    end,
  }
  return id
end

---Connect to a running service listening on `<host>:<port>`.
---@param address string
---@return integer|nil channel
---@return string|nil err
function M.start_tcp(address)
  return start_socket("tcp", address)
end

---Connect to a running service listening on a Unix socket.
---@param path string
---@return integer|nil channel
---@return string|nil err
function M.start_pipe(path)
  return start_socket("pipe", path)
end

---@type table<string, fun(config: string|nil): integer|nil, string|nil>
M.targets = {
  rpc = function()
    return M.start_rpc()
  end,
  tcp = function(address)
    if not address then
      return nil, "tcp needs <host>:<port>"
    end
    return M.start_tcp(address)
  end,
  pipe = function(path)
    if not path then
      return nil, "pipe needs a socket path"
    end
    return M.start_pipe(path)
  end,
}

---Replace the current connection with one to `target`.
---@param target string key of `targets`
---@param config string|nil address for `tcp` and `pipe`
---@return string|nil err
function M.attach(target, config)
  local start = M.targets[target]
  if not start then
    return ("unknown target: %s"):format(target)
  end
  M.stop()
  local _, err = start(config)
  return err
end

function M.stop()
  if connection then
    connection.stop()
    connection = nil
  end
end

---Send a notification to the service, spawning it over `rpc` when there is no connection.
---@param method string
---@param ... any
---@return string|nil err
function M.notify(method, ...)
  if not connection then
    local _, err = M.start_rpc()
    if err then
      return err
    end
  end
  ---@cast connection Hive.Agent.Connection

  -- A socket channel has no exit callback, so a closed one only shows up here.
  local id = connection.channel
  local ok, err = pcall(vim.rpcnotify, id, method, ...)
  if not ok then
    forget(id)
    return tostring(err)
  end
end

---Run-time values set by `:Hive set`, ahead of `agent` in the config.
---@type { model?: string, thinking?: Hive.ThinkingLevel, tools?: string[] }
local overrides = {}

---@return { model: string, thinking: Hive.ThinkingLevel, tools: string[] } what the next prompt uses
function M.settings()
  local agent = require("hive.config").agent
  return {
    model = overrides.model or agent.model,
    thinking = overrides.thinking or agent.thinking,
    tools = overrides.tools or agent.tools,
  }
end

---Override the model for later prompts. A different model starts a new session on the next prompt.
---@param model string Mistral model id from Pi's catalogue
---@return string|nil err
function M.set_model(model)
  if model == "" then
    return "missing model"
  end
  overrides.model = model
end

---Override the thinking level for later prompts. The session and its history carry over.
---@param level string
---@return string|nil err
function M.set_thinking(level)
  local levels = require("hive.config").thinking_levels
  if not vim.list_contains(levels, level) then
    return ("thinking level must be one of %s, got %s"):format(table.concat(levels, ", "), level)
  end
  overrides.thinking = level --[[@as Hive.ThinkingLevel]]
end

---Override the active tools for later prompts. The session and its history carry over.
---@param tools string[]
---@return string|nil err
function M.set_tools(tools)
  local err = require("hive.config").check_tools(tools)
  if err then
    return err
  end
  overrides.tools = tools
end

---@param text string
---@param path string workbench file
---@return string|nil err
local function send(text, path)
  local settings = M.settings()
  return M.notify("prompt", {
    text = text,
    model = settings.model,
    thinking = settings.thinking,
    tools = settings.tools,
    workbench = vim.fn.fnamemodify(path, ":t:r"),
    cwd = vim.fn.getcwd(),
  })
end

---Send `text` to the agent, and stream its reply into the project's current workbench.
---Each workbench has its own session.
---@param text string
---@return string|nil err
function M.prompt(text)
  local ui = require("hive.ui")
  local _, path = ui.open()
  ui.append("## You\n")
  ui.mark_start("user")
  ui.append(text)
  ui.mark_end("user")
  ui.append("\n## Agent\n")
  return send(text, path)
end

---Send the current workbench's text after its last `<!-- hive:end <id> -->` as the prompt,
---and stream the reply after it.
---@return string|nil err
function M.chat()
  local ui = require("hive.ui")
  local text, first, last, path = ui.unanswered()
  if text == "" then
    return "nothing to send after the last reply"
  end
  ui.open()
  ui.mark_start("user", first)
  ui.mark_end("user", last)
  return send(text, path)
end

-- -------------------------------------------- Callbacks from the service ---------------------------------------------

---@param text string
function M.on_echo(text)
  require("hive.util").info(text)
end

---@class Hive.Agent.Event
---@field type "message_start"|"message_end"|"text"|"thinking"|"thinking_end"|"tool_start"|"tool_end"|"end"
---@field text? string a tool result's output, on its message_start
---@field role? "user"|"assistant"|"toolResult"
---@field id? string session entry id
---@field hint? string what the message holds, on its message_end
---@field call? string tool call id, on a tool_start and its tool result's message_start
---@field delta? string
---@field name? string
---@field args? any
---@field isError? boolean
---@field error? string

---@param event Hive.Agent.Event
function M.on_event(event)
  local ui = require("hive.ui")
  if event.type == "message_start" then
    ui.mark_start(event.role)
    local call = event.call and ui.take_call(event.call)
    if call then
      ui.append(call .. "\n")
    end
    if event.text and event.text ~= "" then
      ui.append(event.text)
    end
  elseif event.type == "message_end" then
    ui.tag(event.role, event.id, event.hint)
  elseif event.type == "text" then
    ui.append_reply(event.delta)
  elseif event.type == "thinking" then
    ui.append(event.delta)
  elseif event.type == "thinking_end" then
    ui.append("\n")
  elseif event.type == "tool_start" then
    ui.add_call(event.call, ("`%s %s`"):format(event.name, vim.json.encode(event.args)))
  elseif event.type == "end" then
    if event.error then
      ui.append("\n**Error:** " .. event.error)
      require("hive.util").error("Hive prompt: " .. event.error)
    end
    ui.append("\n")
  end
end

return M
