---@meta _
--- Definition file for LuaLS type information. Not loaded at runtime.
--- See: https://luals.github.io/wiki/definition-files/

-- lua/hive/init.lua -----------------------------------------------------------

---@class Hive.Plugin
---@field did_setup boolean whether setup() has been called
---@field setup fun(opts?: Hive.UserOptions) setup the plugin with user options
---@field completions fun(prompt: string, max_tokens: integer, callback?: fun(err: string|nil, completion: Hive.Completion|nil)): string|nil, Hive.Completion|nil

-- lua/hive/config.lua ---------------------------------------------------------

---@class Hive.Config
---@field augroup integer augroup created at module load
---@field ns integer namespace created at module load
---@field defaults fun(): Hive.DefaultOptions copy of the hard-coded defaults
---@field setup fun(opts?: Hive.UserOptions) setup the plugin configuration

---@class Hive.UserOptions
---@field base_url? string root URL of the OpenAI-compatible server
---@field model? string model name sent in the request body
---@field timeout? integer request timeout in milliseconds
---@field headers? table<string, string> headers sent with every request

---@class Hive.DefaultOptions
---@field base_url string root URL of the OpenAI-compatible server
---@field model string model name sent in the request body
---@field timeout integer request timeout in milliseconds
---@field headers table<string, string> headers sent with every request

---@class Hive.Options
---@field base_url string merged from user/default options
---@field model string merged from user/default options
---@field timeout integer merged from user/default options
---@field headers table<string, string> merged from user/default options

-- lua/hive/curl.lua -----------------------------------------------------------

---@class Hive.Curl
---@field build_args fun(req: Hive.Curl.Request): string[] build the curl argv for a request
---@field request fun(req: Hive.Curl.Request, callback?: fun(err: string|nil, res: Hive.Curl.Response|nil)): string|nil, Hive.Curl.Response|nil

-- lua/hive/api.lua ------------------------------------------------------------

---@class Hive.Api
---@field completions_request fun(prompt: string, max_tokens: integer): Hive.Curl.Request
---@field parse_completion fun(res: Hive.Curl.Response): string|nil, Hive.Completion|nil
---@field completions fun(prompt: string, max_tokens: integer, callback?: fun(err: string|nil, completion: Hive.Completion|nil)): string|nil, Hive.Completion|nil

-- lua/hive/util.lua -----------------------------------------------------------

---@class Hive.Util
---@field notify fun(msg: string|table, level?: integer) send notification with plugin title
---@field info fun(msg: string) send info notification
---@field warn fun(msg: string) send warning notification
---@field error fun(msg: string) send error notification

-- lua/hive/health.lua ---------------------------------------------------------

---@class Hive.Health
---@field check fun() perform health check for the plugin
