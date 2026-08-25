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
  base_url = "http://localhost:8080",
  -- A placeholder: `llama-server` serves one model and ignores this field
  -- (§9.1). It exists for a server that serves several, and §13.2c compares it
  -- against /v1/models so a wrong name fails at :checkhealth rather than as an
  -- HTTP 400 at submit time.
  -- A FIM-capable coder model is a hard requirement; §13.4 is what tells the
  -- user their model cannot do FIM. Measured here: Qwen2.5-Coder-3B-Instruct
  -- Q6_K (§8.3.1). The 7b is comfortable on §8.3.4's server and both land on
  -- the same budget, so size the model to the card, not to this table.
  model = "default",
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

  -- FIM ------------------------------------------------------------------
  fim = {
    -- sentinel set; "qwen" | "codellama" | "deepseek" | "starcoder" |
    -- "starcoder2" | table
    dialect = "qwen",
    -- 5.6 s of decode at the 45.4 tok/s §8.3.1 measures at this context, and
    -- 5.6 of the 7.1 s cold submit. This is the expensive knob, not the
    -- budget. Measure decode before raising it on other hardware: it does NOT
    -- scale with prefill, and §8.3.1's step model is what predicts the cost.
    max_tokens = 256,
    -- extra stop strings appended to the dialect's own
    stop = {},
  },

  -- prompt budget --------------------------------------------------------
  -- Every value here is derived in §8.3 from the measurements in §8.3.1.
  -- §8.3.4's remote server derives the same numbers independently, so this
  -- table serves both. Re-derive on other hardware per §8.3.4's procedure, and
  -- read §8.3.8 first: two settings on this machine were each worth more than
  -- a hardware change.
  budget = {
    total_tokens = 3072,         -- ceiling for prompt + completion; §8.3.2
                                 -- 3072 not 4096: the server window is 4096
                                 -- for prompt AND completion (§8.3.7)
    bytes_per_token = 4.07,      -- exact via /tokenize over this repo's Lua;
                                 -- §8.3.5, and reconciled per submit
    -- share of the remaining budget each region may claim; the spend/trim/
    -- donate order is §8.3.6's (code → context → notes), not this table's.
    -- Derived in §8.3.3 against `total_tokens - fim.max_tokens` = 2816, so
    -- code 1549, context 845, notes 422.
    reserve = { notes = 0.15, context = 0.30, code = 0.55 },
  },

  -- what goes in R3 ------------------------------------------------------
  code = {
    -- Short files are sent whole, skipping every language-specific step
    -- below. See §6.2. Both limits must pass; bytes is the real guard.
    whole_file = {
      enabled = true,
      max_lines = 60,            -- "a standard page"; see §6.2 for the derivation
                                 -- 150 is affordable at this budget (§8.3.3);
                                 -- 60 stays a context-quality choice
      -- must not exceed reserve.code expressed in bytes, or the whole-file
      -- rung emits a payload the budget will immediately trim: §8.3.3
      max_bytes = 6144,          -- guards minified / very-long-line files
                                 -- 1549 tok x 4.07 B/tok = 6304, rounded down
    },

    -- The import/include block, prepended to the slice when the whole file
    -- did not fit. See §6.8.
    imports = {
      enabled = true,
      max_lines = 40,            -- elided with a marker beyond this; §8.3.3
                                 -- 308 tokens, well under §8.3.6's
                                 -- half-reserve drop rule (774)
    },

    unit = "function",           -- "function" | "lines"
    -- 40+20 is 462 tokens; with the import block, 770 of reserve.code's 1549,
    -- so half the reserve is still free. See §8.3.3.
    lines_before = 40,           -- used when unit == "lines"
    lines_after = 20,
    include_doc_comments = true, -- [R§11.3]
  },

  -- what goes in R2 ------------------------------------------------------
  context = {
    source = "lsp",              -- "lsp" | "treesitter" | "off"
    -- a filtered stub line costs ~15 tokens and reserve.context is 845, so
    -- this is 600 tokens and leaves 245 for consumers below: §8.3.3
    max_symbols = 40,
    lsp_timeout = 1500,          -- ms; a slow server must never block a refresh
    kinds = {                    -- SymbolKind names to keep; see §7.1
      "Function", "Method", "Class", "Struct", "Interface", "Constructor", "Field",
      -- required: tsgo reports arrow-consts as Variable (§7.1); kept only
      -- when §7.1's callability check passes
      "Variable", "Constant",
    },
    max_depth = 1,               -- documentSymbol nesting depth to descend

    -- What *calls* the target — §7.4. Sourced from `textDocument/references`,
    -- not call hierarchy: lua_ls answers `-32601` for `prepareCallHierarchy`
    -- and `CallHierarchyItem.range` disagrees across the other three.
    -- Only applies when §6.3 found a unit (strategy `unit`).
    consumers = {
      enabled = true,
      -- call sites, not callers. A widened site is 1-3 lines ~= 10-30 tokens,
      -- so 6 is 60-180 tokens of the 245 max_symbols leaves; it is taken from
      -- ranked stubs, which is why it is not folded into max_symbols. A tight
      -- fit, and §8.3.6 trims consumers before the last stubs. §8.3.3.
      max = 6,
      -- widen cap for the bracket-balance fallback, used only when no
      -- treesitter parser exists for the *caller's* filetype
      max_lines = 3,
    },
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

