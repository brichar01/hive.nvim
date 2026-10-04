local M = {}

local function workbench_slug()
  local home = vim.uv.os_homedir()
  local cwd = vim.uv.cwd()

  if not cwd or not home then
    error("a path is not set")
  end

  -- Project dir relative to $HOME (falls back to the absolute path if outside).
  local rel = cwd
  if cwd == home or vim.startswith(cwd, home .. "/") then
    rel = cwd:sub(#home + 2)
  end
  rel = rel:gsub("^/+", "")
  if rel == "" then
    rel = "home"
  end

  -- sanitise path
  return (rel:gsub("[^%w%.%-_]", "%%"))
end

local function workbench_dir()
  local dir = vim.fs.joinpath(vim.fn.stdpath("cache"), "workbenches")
  vim.fn.mkdir(dir, "p")
  return dir
end

local function open_workbench(path)
  vim.cmd.edit(vim.fn.fnameescape(path))
  vim.bo.swapfile = false
  vim.bo.filetype = "markdown"
end

local function new_path()
  local name = workbench_slug() .. "-" .. os.date("%Y%m%d%H%M%S") .. ".md"

  return vim.fs.joinpath(workbench_dir(), name)
end

local function new_workbench()
  open_workbench(new_path())
  vim.cmd("write")
end

--- @return table this project's workbench paths, in name order
local function workbench_list()
  local existing = vim.fn.glob(vim.fs.joinpath(workbench_dir(), workbench_slug() .. "-*.md"), false, true)
  table.sort(existing)

  return existing
end

local function latest_workbench()
  local existing = workbench_list()

  return existing[#existing]
end

--- Open the workbench either side of the one in the current buffer.
---
--- A buffer holding anything but one of this project's workbenches has no
--- neighbour to step to, so nothing happens.
---
--- @param step integer -1 for the previous name, 1 for the next
local function step_workbench(step)
  local current = vim.fs.normalize(vim.api.nvim_buf_get_name(0))
  local existing = workbench_list()

  for i, path in ipairs(existing) do
    if vim.fs.normalize(path) == current then
      local target = existing[i + step]
      if target then
        open_workbench(target)
      end
      return
    end
  end
end

--- @return string path of this project's workbench, the newest one or one yet to be written
function M.current()
  return latest_workbench() or new_path()
end

M.actions = {
  fn = workbench_slug,
  open = function()
    local latest = latest_workbench()
    if latest then
      open_workbench(latest)
    else
      new_workbench()
    end
  end,
  new = new_workbench,
  next = function()
    step_workbench(1)
  end,
  previous = function()
    step_workbench(-1)
  end,
}

return M
