# Neovim frontend for pi-coding-agent

Build plan. Neovim spawns a Node service that wraps `@earendil-works/pi-coding-agent`
and owns the agent loop. Neovim is the filesystem: `read`, `write` and `edit` never
touch disk.

Source references below are paths in the Pi repository
(`earendil-works/pi`), not in this one.

## Architecture

```
Neovim (Lua)                              Node service (TypeScript)
  |                                          |
  |-- jobstart({rpc = true}) --------------->|  attach(process.stdin/stdout)
  |                                          |
  |   Lua  -> node:  rpcnotify only          |  createAgentSession({
  |   node -> nvim:  nvim_* API requests     |    noTools: "builtin",
  |                                          |    customTools: [...] })
```

One channel, one rule: **Lua never calls `rpcrequest`**. Lua only notifies, and Node
drives Neovim with API requests. This removes the nested-request deadlock, where
Neovim blocks waiting on a reply from Node while a tool operation tries to read a
buffer.

Node owns the agent. The tool operations call back into Neovim for file content.

## Interception

`packages/coding-agent/src/core/sdk.ts:41` gives the supported seam. `noTools:
"builtin"` drops the built-in read, bash, edit and write tools, and `customTools`
registers replacements built from the exported factories.

```ts
createAgentSession({
  cwd,
  noTools: "builtin",
  customTools: [
    createReadToolDefinition(cwd,  { operations: nvimRead }),
    createWriteToolDefinition(cwd, { operations: nvimWrite }),
    createEditToolDefinition(cwd,  { operations: nvimEdit }),
    createBashToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ],
})
```

The operation interfaces are small and already exported:

| Tool | Interface | Members |
|---|---|---|
| read | `ReadOperations` (`core/tools/read.ts:35`) | `readFile -> Buffer`, `access`, `detectImageMimeType?` |
| write | `WriteOperations` (`core/tools/write.ts:27`) | `writeFile`, `mkdir` |
| edit | `EditOperations` (`core/tools/edit.ts:83`) | `readFile -> Buffer`, `writeFile`, `access` |

Only the leaves are replaced, so Pi keeps its own semantics: exact match then fuzzy,
uniqueness counted in normalised space, overlap detection, BOM and CRLF restore, and
diff and unified patch generation.

`mkdir` stays on disk. Directories are real. Only file content is buffer-backed.

`bash`, `grep`, `find` and `ls` keep reading the filesystem.

## Stages

### 1. Channel

New `node/` package. `attach({reader: process.stdin, writer: process.stdout})`, one
`ping` notification, one reply through `nvim_exec_lua`.

Send every log line to stderr. Stdout is the protocol and one stray `console.log`
corrupts the stream.

Done when `:Hive echo hello` round-trips.

### 2. Session and event stream

`createAgentSession` with stock tools. Prompt in, events out to a scratch buffer.

#### Credentials

The key stays in the secret store that the curl interface uses, never in Pi's
credential file. Lua owns resolution, and Node only carries the key.

Learnings from the curl interface (`lua/hive/direct/api.lua`, `lua/hive/direct/curl.lua`) that
carry over:

- **Resolve in Lua with `Config.resolve_api_key()`.** It reads a literal string, a
  function that reads a wallet, and then `api_key_env`. The function result is
  cached for the session, so the wallet prompts once. Do not add a second resolver
  in Node.
- **Keep the key off argv.** curl gets it as a child-only environment variable and
  expands it into the header with `--variable` and `--expand-header`. For Node, pass
  it in the `env` of `jobstart`, not as an argument. `/proc/<pid>/cmdline` is
  world-readable.
- **Scope the environment to the child.** `with_env` sets the variable in curl's
  environment, not Neovim's. Do the same with `jobstart`, and never `vim.env`.
- **nil means unauthenticated.** curl sends no `Authorization` header for a nil key.
  Pi cannot match this (see below), so a nil key becomes a placeholder.
- **Keep the transport checks.** `hive.endpoint.transport()` classifies a URL, and
  `health.lua` warns about a remote plaintext `base_url`. Apply the same check to the
  provider URL that Node uses.

Pi interface, checked against 0.87.1 by `scripts/pi-auth/auth.test.mjs`
(`npm test` there):

- **Pass a runtime and an in-memory store.** `createAgentSession({ modelRuntime })`
  with `ModelRuntime.create({ credentials, modelsPath: null })`, then
  `runtime.setRuntimeApiKey(provider, key)`. Pi does not export `AuthStorage`, so
  `credentials` is a four-method `CredentialStore` of our own.
- **The default store reads Pi's files.** Without `credentials`, Pi creates an empty
  `auth.json` and serves any key it holds when no runtime key is set. Without
  `modelsPath: null`, it reads `models.json`. With both set, neither file is read or
  created.
- **Do not use a provider variable name for the key.** Built-in providers fall back
  to their own variable, such as `OPENAI_API_KEY`. The `jobstart` variable must have
  a name Pi does not know, and Node must delete it from `process.env` after it reads
  it.
- **A missing key is refused.** `prompt()` fails with "No API key found" before it
  sends a request, also with `authHeader: false`. For a nil key, set a placeholder
  runtime key. `openai-completions` then sends `Authorization: Bearer <placeholder>`.
  A server with no key configured ignores it.

`resolve_api_key()` returns one key for one `base_url`, but Pi resolves one key per
provider. Stage 2 supports one provider. A per-provider config shape is out of scope.

Done when a prompt streams text into a buffer, and no `auth.json` exists in the agent
directory after the session.

### 3. Fidelity layer (`lua/hive/fs.lua`)

`nvim_buf_get_lines` returns lines, not a file. Rebuild the byte content:

- Join with `\r\n` when `fileformat` is `dos`, else `\n`.
- Prepend the BOM when `bomb` is set.
- Append a trailing separator unless `noeol`.

Miss any of these and Pi's `detectLineEnding` sees LF throughout and rewrites a CRLF
file, or every write flips the trailing newline.

Test as a round trip over four fixtures (LF, CRLF, BOM, no trailing newline): read
through the layer, write back, expect byte equality.

### 4. Wire the operations in

`readFile` serves the buffer when one is loaded and falls back to disk otherwise.
Images fall back to disk, because `detectImageMimeType` needs a real file.

Done when the agent edits a file with an open buffer, the buffer updates, and disk is
untouched.

### 5. Open on write

A write to a path with no loaded buffer opens one: `bufadd(path)`, `bufload()`,
`nvim_buf_set_lines`, `buflisted` on. For an existing file `bufload` reads it first.
For a new file you get an empty named buffer. Nothing reaches disk through these
tools.

Done when the agent creates a new file and it appears as a listed, modified, unsaved
buffer with no disk entry.

### 6. Rendering and approval

`tool_result` carries `details.diff`, `details.patch` and `details.firstChangedLine`
(`core/tools/edit.ts:70`). That is the extmark diff and the cursor jump.

Approvals gate at `tool_call`. The handler is async, so it awaits the Neovim round
trip and returns `{block: true, reason}` on a refusal. The diff only exists after
execute, so approval is on intent (path, edit count), not on a rendered diff.

### 7. Packaging and health

Node on `PATH` and a built `node/` bundle become hard requirements. Add checks for
both to `lua/hive/health.lua` alongside the curl check.

## Open decision: save policy

Buffers left modified mean `bash`, `grep`, `find` and any test run see stale disk,
because those tools still read the filesystem.

- **a.** Leave buffers modified. Full review gate, but the agent's own shell commands
  lie to it.
- **b.** Auto-save after each write. Consistent, no review gate, and undo is the only
  recovery.
- **c.** Leave buffers modified, and flush dirty agent-touched buffers from a
  `tool_call` hook on `bash`. Keeps the review gate and closes the gap where it bites.

Recommended: **c**, as a config key with a and b available. The choice only affects
stage 5.

## New files

| Path | Holds |
|---|---|
| `node/` | The service: `package.json`, `src/main.ts`, `src/rpc.ts`, `src/session.ts`, `src/nvim-ops.ts` |
| `lua/hive/agent.lua` | Job spawn and lifecycle |
| `lua/hive/fs.lua` | Buffer-backed file content |
| `lua/hive/ui.lua` | Scratch buffer, float, extmarks |
| `lua/hive/approve.lua` | Approval prompts |
