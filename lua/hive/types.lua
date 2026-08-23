---@meta _
--- Definition file for LuaLS type information. Not loaded at runtime.
--- See: https://luals.github.io/wiki/definition-files/

-- lua/hive/init.lua -----------------------------------------------------------

---@class Hive.Plugin
---@field did_setup boolean whether setup() has been called
---@field setup fun(opts?: Hive.UserOptions) setup the plugin with user options
---@field completions fun(prompt: string, max_tokens: integer, callback?: fun(err: string|nil, completion: Hive.Completion|nil)): string|nil, Hive.Completion|nil, vim.SystemObj|nil

-- lua/hive/config.lua ---------------------------------------------------------

---@class Hive.Config
---@field augroup integer augroup created at module load
---@field ns integer namespace created at module load
---@field defaults fun(): Hive.DefaultOptions copy of the hard-coded defaults
---@field setup fun(opts?: Hive.UserOptions) setup the plugin configuration
---@field resolve_api_key fun(): string|nil, "config"|"env"|nil bearer token and where it came from

---TLS options, used only when `base_url` is an `https://` URL.
---@class Hive.TlsOptions
---@field cacert? string path to a CA bundle for a privately-signed server
---@field insecure boolean skip certificate verification entirely

---@class Hive.UserTlsOptions
---@field cacert? string path to a CA bundle for a privately-signed server
---@field insecure? boolean skip certificate verification entirely

---@class Hive.UserOptions
---@field base_url? string root URL of the OpenAI-compatible server
---@field model? string model name sent in the request body
---@field timeout? integer request timeout in milliseconds
---@field connect_timeout? integer milliseconds allowed for the connect alone
---@field headers? table<string, string> headers sent with every request
---@field api_key? string|fun(): string|nil bearer token, or a function returning one
---@field api_key_env? string environment variable read when `api_key` is unset
---@field tls? Hive.UserTlsOptions TLS options for an `https://` base_url

---@class Hive.DefaultOptions
---@field base_url string root URL of the OpenAI-compatible server
---@field model string model name sent in the request body
---@field timeout integer request timeout in milliseconds
---@field connect_timeout integer milliseconds allowed for the connect alone
---@field headers table<string, string> headers sent with every request
---@field api_key string|fun(): string|nil bearer token, or a function returning one
---@field api_key_env string environment variable read when `api_key` is unset
---@field tls Hive.TlsOptions TLS options for an `https://` base_url

---@class Hive.Options
---@field base_url string merged from user/default options
---@field model string merged from user/default options
---@field timeout integer merged from user/default options
---@field connect_timeout integer merged from user/default options
---@field headers table<string, string> merged from user/default options
---@field api_key string|fun(): string|nil merged from user/default options
---@field api_key_env string merged from user/default options
---@field tls Hive.TlsOptions merged from user/default options

-- lua/hive/curl.lua -----------------------------------------------------------

---@class Hive.Curl
---@field build_args fun(req: Hive.Curl.Request): string[] build the curl argv for a request
---@field version fun(): integer[]|nil curl's version as { major, minor, patch }
---@field supports_expand fun(): boolean whether curl understands --variable/--expand-header
---@field request fun(req: Hive.Curl.Request, callback?: fun(err: string|nil, res: Hive.Curl.Response|nil)): string|nil, Hive.Curl.Response|nil, vim.SystemObj|nil

-- lua/hive/api.lua ------------------------------------------------------------

---@class Hive.Api
---@field base_request fun(url: string): Hive.Curl.Request shared credentials, TLS and timeouts
---@field completions_request fun(prompt: string, max_tokens: integer): Hive.Curl.Request
---@field parse_completion fun(res: Hive.Curl.Response): string|nil, Hive.Completion|nil
---@field completions fun(prompt: string, max_tokens: integer, callback?: fun(err: string|nil, completion: Hive.Completion|nil)): string|nil, Hive.Completion|nil, vim.SystemObj|nil
---@field models fun(timeout?: integer): string|nil, string[]|nil model ids advertised by the server

-- lua/hive/util.lua -----------------------------------------------------------

---@class Hive.Util
---@field notify fun(msg: string|table, level?: integer) send notification with plugin title
---@field info fun(msg: string) send info notification
---@field warn fun(msg: string) send warning notification
---@field error fun(msg: string) send error notification

-- lua/hive/health.lua ---------------------------------------------------------

---@class Hive.Health
---@field check fun() perform health check for the plugin
