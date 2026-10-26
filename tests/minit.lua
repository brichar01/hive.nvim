#!/usr/bin/env -S nvim -l

vim.env.LAZY_STDPATH = ".tests"
vim.env.LAZY_PATH = vim.fs.normalize("~/projects/lazy.nvim")

if vim.fn.isdirectory(vim.env.LAZY_PATH) == 1 then
  loadfile(vim.env.LAZY_PATH .. "/bootstrap.lua")()
else
  load(vim.fn.system("curl -s https://raw.githubusercontent.com/folke/lazy.nvim/main/bootstrap.lua"), "bootstrap.lua")()
end

-- lazy resets the rtp to lib64/nvim whenever lib64 exists, which drops the bundled parsers of an install in lib.
local bundled_parsers = vim.api.nvim_get_runtime_file("parser/lua.so", false)[1]

require("lazy.minit").setup({
  spec = {
    { dir = vim.uv.cwd(), opts = {} },
  },
  performance = {
    rtp = { paths = bundled_parsers and { vim.fs.dirname(vim.fs.dirname(bundled_parsers)) } or {} },
  },
})
