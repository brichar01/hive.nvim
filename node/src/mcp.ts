/**
 * An MCP server that reads and edits the buffers of a running Neovim.
 *
 * The MCP client starts it and talks MCP over stdio. It dials Neovim's own RPC
 * socket and calls `hive.mcp` there, so hive.nvim has to be on that Neovim's
 * runtimepath. Edits stay in the buffer, unsaved, and nothing reaches disk.
 *
 * Usage: `node src/mcp.ts [--log-level <error|warn|info|debug>]`
 */
import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type DialledNvim, dialSocket } from "./connection/dial.ts";
import {
  captureConsole,
  clientLogger,
  createLogger,
  isLevel,
  type Level,
  LEVELS,
  type Logger,
  setLevel,
  silent,
} from "./log.ts";
import type { NvimConnection } from "./nvim_wrapper.ts";

type VimValue = Parameters<NvimConnection["exec"]>[1] extends
  | (infer V)[]
  | undefined
  ? V
  : never;

/** How long a Neovim gets to describe itself before the scan skips it. */
export const DESCRIBE_TIMEOUT_MS = 2000;

const DESCRIBE = `return {
  pid = vim.fn.getpid(),
  cwd = vim.fn.getcwd(),
  focused_at = vim.g.hive_focused_at,
  buffer = vim.api.nvim_buf_get_name(0),
}`;

// ------- Choosing a Neovim -------

/** A Neovim found by the socket scan. */
export interface Candidate {
  socket: string;
  pid: number;
  cwd: string;
  /** When the Neovim last gained focus, in ms since the epoch. `null` when it has not since hive.nvim loaded. */
  focusedAt: number | null;
  /** The current window's buffer. */
  buffer: string;
}

export interface Environment {
  HIVE_NVIM?: string;
  NVIM?: string;
  XDG_RUNTIME_DIR?: string;
}

export interface LocatorOptions {
  env: Environment;
  /** The directory the MCP client works in. The scan matches it against each Neovim's working directory. */
  cwd: string;
  dial?: (socket: string) => Promise<DialledNvim>;
  /** Lists the sockets the scan describes. Defaults to `nvim.*.0` in the runtime directory. */
  sockets?: () => Promise<string[]>;
  log?: Logger;
}

/** Finds the Neovim the tools act on, and keeps one connection to it. */
export interface Locator {
  nvim: () => Promise<NvimConnection>;
  candidates: () => Promise<Candidate[]>;
  /** Use `socket` for the rest of the session. */
  select: (socket: string) => Promise<Candidate>;
  close: () => void;
}

const message = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (Array.isArray(err) && typeof err[1] === "string") {
    return err[1];
  }
  return String(err);
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** The default Neovim server sockets in `dir`, which Neovim names `nvim.<pid>.0`. */
export async function listSockets(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => /^nvim\.\d+\.0$/.test(name))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function parseCandidate(socket: string, value: unknown): Candidate {
  const fields = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const { pid, cwd, focused_at, buffer } = fields;
  if (typeof pid !== "number" || typeof cwd !== "string") {
    throw new Error(`${socket} did not describe itself`);
  }
  return {
    socket,
    pid,
    cwd,
    focusedAt: typeof focused_at === "number" ? focused_at : null,
    buffer: typeof buffer === "string" ? buffer : "",
  };
}

const contains = (dir: string, path: string): boolean =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

const describeCandidates = (candidates: Candidate[]): string =>
  candidates.length === 0
    ? "No Neovim sockets were found."
    : candidates
        .map(
          (c) =>
            `  ${c.socket}  pid ${String(c.pid)}  cwd ${c.cwd}  buffer ${c.buffer || "[No Name]"}  focused ${
              c.focusedAt === null ? "never" : new Date(c.focusedAt).toISOString()
            }`,
        )
        .join("\n");

/**
 * Pick the Neovim whose working directory contains `cwd` or sits inside it, preferring the one focused last.
 *
 * Throws when none matches, or when the two best share a focus time, listing the candidates so the caller can
 * pick one with `select_nvim`.
 */
export function choose(cwd: string, candidates: Candidate[]): Candidate {
  const focus = (c: Candidate): number => c.focusedAt ?? -1;
  const matching = candidates
    .filter((c) => contains(c.cwd, cwd) || contains(cwd, c.cwd))
    .sort((a, b) => focus(b) - focus(a));
  const [best, next] = matching;
  if (!best) {
    throw new Error(
      `No Neovim works in or above ${cwd}. Ask the user which to use, then call select_nvim.\n${describeCandidates(candidates)}`,
    );
  }
  if (next && focus(next) === focus(best)) {
    throw new Error(
      `Several Neovims work in ${cwd} and none was focused last. Ask the user which to use, then call select_nvim.\n${describeCandidates(matching)}`,
    );
  }
  return best;
}

/**
 * Find the Neovim from `$HIVE_NVIM`, then `$NVIM`, then the socket `select` pinned, then a scan of the runtime
 * directory narrowed by `choose`.
 */
export function createLocator(options: LocatorOptions): Locator {
  const { env, cwd } = options;
  const log = options.log ?? silent;
  const dial = options.dial ?? ((socket: string) => dialSocket(socket, { log }));
  const runtimeDir = env.XDG_RUNTIME_DIR ?? `/run/user/${String(process.getuid?.() ?? "")}`;
  const sockets = options.sockets ?? (() => listSockets(runtimeDir));
  const fixed = env.HIVE_NVIM ? "$HIVE_NVIM" : env.NVIM ? "$NVIM" : undefined;

  let current: DialledNvim | undefined;
  let pinned: string | undefined;

  const describe = async (socket: string): Promise<Candidate> => {
    const dialled = await withTimeout(dial(socket), DESCRIBE_TIMEOUT_MS, socket);
    try {
      return parseCandidate(
        socket,
        await withTimeout(dialled.nvim.exec(DESCRIBE, []), DESCRIBE_TIMEOUT_MS, socket),
      );
    } finally {
      dialled.close();
    }
  };

  const candidates = async (): Promise<Candidate[]> => {
    const results = await Promise.allSettled((await sockets()).map(describe));
    return results.flatMap((result) => {
      if (result.status === "rejected") {
        log.debug("skipped: %s", message(result.reason));
        return [];
      }
      return [result.value];
    });
  };

  const close = (): void => {
    current?.close();
    current = undefined;
  };

  const target = async (): Promise<string> =>
    env.HIVE_NVIM || env.NVIM || pinned || choose(cwd, await candidates()).socket;

  return {
    nvim: async () => {
      if (current && !current.closed()) {
        return current.nvim;
      }
      close();
      const socket = await target();
      try {
        current = await dial(socket);
      } catch (err) {
        throw new Error(`could not connect to Neovim at ${socket}: ${message(err)}`, {
          cause: err,
        });
      }
      log.info("using %s", socket);
      return current.nvim;
    },
    candidates,
    select: async (socket) => {
      if (fixed) {
        throw new Error(`${fixed} names the Neovim for this session, so it cannot be changed`);
      }
      const candidate = await describe(socket);
      close();
      pinned = socket;
      return candidate;
    },
    close,
  };
}

// ------- Tools -------

interface ReadResult {
  first: number;
  lines: string[];
  total: number;
  source: "buffer" | "disk";
}

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const PATH = z.string().min(1).describe("File path, absolute or relative to the working directory");
const LINE = z.number().int().min(1);

/** An MCP server whose tools act on the Neovim `locator` finds. Relative paths resolve against `cwd`. */
export function createMcpServer(locator: Locator, cwd: string): McpServer {
  const server = new McpServer({ name: "hive", version: "0.0.0" });
  const absolute = (path: string): string => resolve(cwd, path);

  const call = async (fn: string, ...args: VimValue[]): Promise<unknown> => {
    const nvim = await locator.nvim();
    try {
      return await nvim.exec(`return require('hive.mcp').${fn}(...)`, args);
    } catch (err) {
      throw new Error(`${fn}: ${message(err)}`, { cause: err });
    }
  };
  /** Calls that return the buffer, and the cursor where there is one, as `hive.mcp` describes them. */
  const info = async (fn: string, ...args: VimValue[]) => text(await call(fn, ...args));

  server.registerTool(
    "read_buffer",
    {
      description:
        "Read lines of a file as Neovim holds them, including unsaved changes. Reads the file on disk when no buffer holds it. Each line starts with its 1-based number and a tab.",
      inputSchema: {
        path: PATH,
        start: LINE.optional().describe("First line, 1-based. Defaults to 1"),
        end: LINE.optional().describe("Last line, inclusive. Defaults to the last line"),
      },
    },
    async ({ path, start, end }) => {
      const range: Record<string, number> = {};
      if (start !== undefined) {
        range.first = start;
      }
      if (end !== undefined) {
        range.last = end;
      }
      const result = (await call("read", absolute(path), range)) as ReadResult;
      const lines = Array.isArray(result.lines) ? result.lines : [];
      const last = result.first + lines.length - 1;
      const header = `${absolute(path)} lines ${String(result.first)}-${String(last)} of ${String(result.total)} (${result.source})`;
      const body = lines.map((line, i) => `${String(result.first + i)}\t${line}`);
      return text([header, ...body].join("\n"));
    },
  );

  server.registerTool(
    "edit_buffer",
    {
      description:
        "Replace lines start to end (1-based, inclusive) of a file's Neovim buffer with `lines`. Set end to start - 1 to insert before start, and pass no lines to delete. Loads a buffer when the file has none. The change stays unsaved in Neovim and nothing is written to disk. Line numbers shift after each edit, so read the range again before the next one.",
      inputSchema: {
        path: PATH,
        start: LINE.describe("First line to replace, 1-based"),
        end: z.number().int().min(0).describe("Last line to replace, inclusive"),
        lines: z.array(z.string()).describe("The new lines, without line endings"),
      },
    },
    ({ path, start, end, lines }) => info("edit", absolute(path), start, end, lines),
  );

  server.registerTool(
    "open_buffer",
    {
      description:
        "Load a file into a listed Neovim buffer, or an empty one when the file does not exist. With focus, also show it in the current window.",
      inputSchema: {
        path: PATH,
        focus: z.boolean().optional().describe("Show the buffer in the current window. Defaults to false"),
      },
    },
    ({ path, focus }) => info("open", absolute(path), focus ?? false),
  );

  server.registerTool(
    "get_active_buffer",
    { description: "The buffer in Neovim's current window: its number, path, modified flag and line count." },
    () => info("active"),
  );

  server.registerTool(
    "set_active_buffer",
    {
      description: "Show a file's loaded buffer in Neovim's current window. Use open_buffer for a file with no buffer.",
      inputSchema: { path: PATH },
    },
    ({ path }) => info("set_active", absolute(path)),
  );

  server.registerTool(
    "get_cursor",
    { description: "The cursor in Neovim's current window: 1-based line, 0-based byte column, and the buffer." },
    () => info("cursor"),
  );

  server.registerTool(
    "set_cursor",
    {
      description:
        "Move the cursor in Neovim's current window. With a path, first show that file's loaded buffer in the window.",
      inputSchema: {
        line: LINE.describe("1-based line"),
        col: z.number().int().min(0).describe("0-based byte column"),
        path: PATH.optional(),
      },
    },
    ({ line, col, path }) =>
      path === undefined ? info("set_cursor", line, col) : info("set_cursor", line, col, absolute(path)),
  );

  server.registerTool(
    "list_nvims",
    {
      description:
        "List the running Neovims with their socket, pid, working directory, current buffer and when each last gained focus.",
    },
    async () => text(describeCandidates(await locator.candidates())),
  );

  server.registerTool(
    "select_nvim",
    {
      description: "Use the Neovim on `socket` for every later tool call. Take the socket from list_nvims.",
      inputSchema: { socket: z.string().min(1) },
    },
    async ({ socket }) => text(await locator.select(socket)),
  );

  return server;
}

// ------- Entry point -------

/** Read `--log-level <error|warn|info|debug>`, `warn` by default. */
export function parseCommandLine(argv: string[]): { level: Level } {
  const { values } = parseArgs({
    args: argv,
    options: { "log-level": { type: "string", default: "warn" } },
    strict: true,
    allowPositionals: false,
  });
  const level = values["log-level"];
  if (!isLevel(level)) {
    throw new Error(`--log-level expects one of ${LEVELS.join(", ")}, got ${level}`);
  }
  return { level };
}

/** Serve MCP on stdio until the client closes stdin. */
export async function main(level: Level, env: Environment, cwd: string): Promise<void> {
  // Stdout carries MCP, so every log line goes to stderr.
  setLevel(level);
  captureConsole();
  const log = createLogger("mcp");

  const locator = createLocator({
    env,
    cwd,
    log,
    dial: (socket) => dialSocket(socket, { attach: { logger: clientLogger() as never }, log }),
  });
  const server = createMcpServer(locator, cwd);
  process.stdin.on("end", () => {
    locator.close();
    void server.close();
  });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  const { level } = parseCommandLine(process.argv.slice(2));
  await main(level, process.env, process.cwd());
}
