--- How the configured server is addressed and what protects the connection.
---
--- Shared by `:checkhealth hive` and by anything else that sends source code to
--- `base_url`, whatever the transport.

---@class Hive.Endpoint
local M = {}

---@class Hive.Endpoint.Transport
---@field scheme string URL scheme, such as "https"
---@field host string host name or address
---@field loopback boolean the server is on this machine
---@field plaintext boolean the server is remote and the connection is not TLS

---Classify a server URL
---@param url string
---@return string|nil err set when `url` is not a URL
---@return Hive.Endpoint.Transport|nil transport
function M.transport(url)
  local scheme, host = url:match("^(%a[%w+.-]*)://([^/:]+)")
  if not scheme then
    return ("not a URL: %s"):format(url)
  end

  local loopback = host == "localhost" or host == "127.0.0.1" or host == "::1"
  return nil,
    {
      scheme = scheme,
      host = host,
      loopback = loopback,
      plaintext = not loopback and scheme ~= "https",
    }
end

return M
