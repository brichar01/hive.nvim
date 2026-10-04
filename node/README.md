# Run the hive.nvim agent service

This guide shows how to run the Node service that hive.nvim talks to, and how to
check changes to it. It is for developers who work on the service or run one
shared service for several Neovim instances.

If you only use `:Hive` commands in one Neovim, you do not need this guide.
`:Hive` starts the service for you.

## Before you start

You need:

- Node.js 23.6 or newer on `PATH`. The service runs its TypeScript source
  directly, with no build step. Node.js 26 is the tested version.
- A checkout of hive.nvim that Neovim loads as a plugin.

Run all commands in this guide from the root of the hive.nvim checkout.

## Install the dependencies

1. Install the packages:

   ```sh
   cd node && npm install
   ```

2. Make sure the service starts:

   ```sh
   node node/src/main.ts --pipe /tmp/hive-check.sock
   ```

   The service writes `listening on /tmp/hive-check.sock` and keeps running.
   Stop it with `Ctrl-C`, then delete the socket file with
   `rm /tmp/hive-check.sock`.

## Run the service for one Neovim

1. In Neovim, send a message:

   ```vim
   :Hive echo hello
   ```

   Neovim starts the service and shows `hello`.

The service runs as a child of Neovim and stops when Neovim quits. Its log lines
show as `DEBUG` notifications in Neovim.

To go back to this mode after you attach to a shared service, run `:Hive attach rpc`.

## Run a shared service

A shared service keeps running when Neovim quits, and more than one Neovim can
connect to it.

1. In a terminal, start the service on a Unix socket or a TCP port:

   ```sh
   node node/src/main.ts --pipe /tmp/hive.sock
   ```

   ```sh
   node node/src/main.ts --tcp 127.0.0.1:7777
   ```

   The agent uses Pi's built-in Mistral provider. Put the Mistral key in
   `HIVE_AGENT_API_KEY` when you start the service. Neovim cannot give a key to
   a service that it did not start. The service reads the variable once at
   startup, then removes it. If `HIVE_AGENT_API_KEY` is not set, Pi reads
   `MISTRAL_API_KEY`.

   ```sh
   HIVE_AGENT_API_KEY="$(pass show llm/key)" node node/src/main.ts --pipe /tmp/hive.sock
   ```

   The service writes its log lines to this terminal. To keep a log file, add
   `2> hive.log` to the command. To change how much it logs, add
   `--log-level error`, `warn`, `info` or `debug`. The default is `info`.

2. In each Neovim, connect to the service:

   ```vim
   :Hive attach pipe /tmp/hive.sock
   ```

   ```vim
   :Hive attach tcp 127.0.0.1:7777
   ```

   Neovim shows `attached over pipe` or `attached over tcp`.

3. Make sure the connection works:

   ```vim
   :Hive echo hello
   ```

   Neovim shows `hello`.

Use a Unix socket when Neovim and the service run on the same machine. A TCP
port has no encryption. Bind it to `127.0.0.1` unless the network is trusted.

## Check your changes

1. Run the typecheck, the linter and the unit tests:

   ```sh
   make node-check
   ```

   The same checks run from `node/` with `npm run check`. To run one check, use
   `npm run typecheck`, `npm run lint` or `npm test`.

2. Make sure the round trip still works. In Neovim, run `:Hive echo hello` and
   look for `hello`.

## Recover from problems

**The service stops at once with `EADDRINUSE`.** A service that stopped earlier
left its socket file behind. Delete the file, for example `rm /tmp/hive.sock`,
then start the service again.

**`:Hive attach` shows `could not connect`.** The service is not running, or it
listens on a different address. Start the service, then run `:Hive attach` again
with the address from its `listening on` line.

**`:Hive echo` shows an error after the shared service stopped.** Neovim finds a
closed connection only when it sends a message. After the error, the next
`:Hive echo` starts a local service in `rpc` mode. To use the shared service,
start it again and run `:Hive attach` again.

**The service stops with `--tcp expects <host>:<port>`.** Give both the host and
the port, for example `--tcp 127.0.0.1:7777`.
