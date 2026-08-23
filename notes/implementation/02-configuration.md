# Configuration — §2

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 2. Configuration

Replace the `defaults` table in `lua/hive/config.lua` with the following. Every
field is validated; validation failure reverts the whole table to defaults and
notifies, matching the existing `M.setup` behaviour.

```lua
local defaults = {
  -- transport -------------------------------------------------------------
  base_url = "http://localhost:11434",
  -- NOTE: the 7b tag is not installed on this machine. Installed 2026-08-21:
  -- qwen2.5-coder:3b (FIM-capable — ollama reports the `insert` capability)
  -- and qwen3.5:0.8b (thinking model, no FIM template; §9.1, §9.4). A
  -- FIM-capable coder model is a hard requirement; `:checkhealth hive`
  -- (§13.4) is what tells the user their model cannot do FIM.
  -- 3b, not 7b: on the §8.3.1 CPU baseline a 7b model prefills ~2.5x
  -- slower, which is not usable. On a dedicated GPU, prefer 7b (§8.3.4).
  model = "qwen2.5-coder:3b",
  timeout = 60000,
  -- Bounds the connect phase alone. Only matters off-box: loopback refuses a
  -- dead port instantly, a remote host that DROPs packets stalls for the whole
  -- `timeout`. §9.6.
  connect_timeout = 3000,
  headers = { ["Content-Type"] = "application/json", ["Accept"] = "application/json" },

  -- credentials and TLS — inert for a loopback server, required off-box (§9.6)
  ---@type string|fun(): string|nil
  api_key = nil,               -- a literal here lives in your dotfiles
  api_key_env = "HIVE_API_KEY",-- read when `api_key` is unset
  tls = {
    cacert = nil,              -- CA bundle for a privately-signed server
    insecure = false,          -- makes TLS decorative; prefer `cacert`
  },

  -- "auto" probes once per session and caches; see §9.1
  transport = "auto",            -- "auto" | "openai" | "ollama_raw"

  -- FIM ------------------------------------------------------------------
  fim = {
    -- sentinel set; "qwen" | "codellama" | "deepseek" | "starcoder" |
    -- "starcoder2" | table
    dialect = "qwen",
    -- decode is 18.5 tok/s on the §8.3.1 baseline, so this is a ~7 s
    -- worst case. Raise to 256 on a GPU (§8.3.4).
    max_tokens = 128,
    -- extra stop strings appended to the dialect's own
    stop = {},
  },

  -- prompt budget --------------------------------------------------------
  -- Every value here is derived in §8.3 from the CPU baseline of §8.3.1.
  -- On a dedicated GPU use the larger tier in §8.3.4 instead.
  budget = {
    total_tokens = 1024,         -- ceiling for prompt + completion; §8.3.2
    bytes_per_token = 3.9,       -- measured on Lua source, see §8.3.1
    -- share of the remaining budget each region may claim; the spend/trim/
    -- donate order is §8.3.6's (code → context → notes), not this table's.
    -- Derived in §8.3.3 so that reserve.code fits §6.2's 60-line whole-file
    -- case exactly; the same ratios hold at the §8.3.4 GPU budget.
    reserve = { notes = 0.15, context = 0.30, code = 0.55 },
  },

  -- what goes in R3 ------------------------------------------------------
  code = {
    -- Short files are sent whole, skipping every language-specific step
    -- below. See §6.2. Both limits must pass; bytes is the real guard.
    whole_file = {
      enabled = true,
      max_lines = 60,            -- "a standard page"; see §6.2 for the derivation
      -- must not exceed reserve.code expressed in bytes, or the whole-file
      -- rung emits a payload the budget will immediately trim: §8.3.3
      max_bytes = 1920,          -- guards minified / very-long-line files
    },

    -- The import/include block, prepended to the slice when the whole file
    -- did not fit. See §6.8.
    imports = {
      enabled = true,
      max_lines = 20,            -- elided with a marker beyond this; §8.3.3
    },

    unit = "function",           -- "function" | "lines"
    -- 28+12 rather than 40+20 so that slice + import block together stay
    -- inside reserve.code at the default budget; see §8.3.3
    lines_before = 28,           -- used when unit == "lines"
    lines_after = 12,
    include_doc_comments = true, -- [R§11.3]
  },

  -- what goes in R2 ------------------------------------------------------
  context = {
    source = "lsp",              -- "lsp" | "treesitter" | "off"
    -- a filtered stub line costs ~15 tokens, and reserve.context is 269
    -- tokens at the default budget: §8.3.3. Raise to 40 on a GPU (§8.3.4).
    max_symbols = 16,
    lsp_timeout = 1500,          -- ms; a slow server must never block a refresh
    kinds = {                    -- SymbolKind names to keep; see §7.1
      "Function", "Method", "Class", "Struct", "Interface", "Constructor", "Field",
      -- required: tsgo reports arrow-consts as Variable (§7.1); kept only
      -- when §7.1's callability check passes
      "Variable", "Constant",
    },
    max_depth = 1,               -- documentSymbol nesting depth to descend
  },

  -- triggers -------------------------------------------------------------
  events = {
    refresh_on = { "BufWritePost", "CursorHold" },
    auto_submit = false,         -- refresh does not imply a model request
    debounce = 300,              -- ms, applies to refresh and submit alike
  },

  -- session file ---------------------------------------------------------
  session = {
    dir = vim.fs.joinpath(vim.fn.stdpath("data"), "hive"),
    headers = {
      notes   = "# hive: notes",
      context = "# hive: context",
      code    = "# hive: code",
    },
  },

  -- rendering ------------------------------------------------------------
  ui = {
    provenance_hl = "DiffText",
    split = "vsplit",            -- "vsplit" | "split" | "tabnew" | "current"
  },
}
```

Validation (extend the existing `pcall` block; `vim.validate` per leaf):

| Field | Rule |
| --- | --- |
| `base_url` | string, non-empty, trailing `/` stripped (already done) |
| `model` | string, non-empty |
| `timeout` | number, ≥ 1000 |
| `connect_timeout` | number, 100 ≤ x ≤ `timeout` — a connect budget larger than the request budget can never be reached, so it is always a mistake |
| `api_key` | string or `fun(): string|nil`, optional; empty string treated as unset |
| `api_key_env` | string, non-empty |
| `tls.cacert` | string, optional, and **`filereadable()`** — a mistyped path must fail at `setup()`, not as curl exit 77 per request |
| `tls.insecure` | boolean; warn when set together with `tls.cacert`, since the skip wins |
| `transport` | one of `auto`/`openai`/`ollama_raw` |
| `fim.dialect` | one of the known keys, or a table with all five keys of §8.1 |
| `fim.max_tokens` | integer ≥ 1, **and < `budget.total_tokens`** — §8.3 spends `total_tokens - max_tokens` on the prompt, so an equal or larger value leaves no prompt at all |
| `budget.total_tokens` | integer ≥ 512 — the smallest budget in which §6.2's 24-line rung (185 tokens) plus a handful of stubs still fits under §8.3.3's split |
| `budget.bytes_per_token` | number in (1, 10] |
| `budget.reserve` | three numbers > 0 summing to 1.0 ± 0.001 |
| `code.whole_file.max_bytes` | integer ≥ 0, and warn when it exceeds `reserve.code × (total_tokens - fim.max_tokens) × bytes_per_token` — §8.3.3; a larger value only produces payloads the budget then trims |
| `code.unit` | one of `function`/`lines` |
| `context.source` | one of `lsp`/`treesitter`/`off` |
| `context.kinds` | list of strings, each a key of `vim.lsp.protocol.SymbolKind` |
| `events.refresh_on` | list of valid autocmd event names (`pcall` a dummy `nvim_create_autocmd`) |
| `session.headers.*` | three distinct non-empty strings, none matching `^```` |
| `headers` | table, string keys and string values |
| `fim.stop` | list of strings |
| `whole_file.enabled`, `imports.enabled`, `include_doc_comments`, `auto_submit` | boolean |
| `whole_file.max_lines`/`max_bytes`, `imports.max_lines`, `lines_before`/`lines_after`, `max_symbols`, `max_depth`, `lsp_timeout`, `debounce` | integer ≥ 0 |
| `session.dir`, `ui.provenance_hl` | string, non-empty |
| `ui.split` | one of `vsplit`/`split`/`tabnew`/`current` |

