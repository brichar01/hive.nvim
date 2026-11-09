import { format } from "node:util";

export const LEVELS = ["error", "warn", "info", "debug"] as const;

export type Level = (typeof LEVELS)[number];

export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

let threshold: Level = "info";

/** Print `level` and less verbose levels. The default is `info`. */
export function setLevel(level: Level): void {
  threshold = level;
}

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

/** A logger whose lines start with the level and `source`, such as `WARN client: ...`. */
export function createLogger(source: string): Logger {
  // Stdout carries the msgpack stream, so every line goes to stderr.
  const write =
    (level: Level) =>
    (...args: unknown[]): void => {
      if (LEVELS.indexOf(level) <= LEVELS.indexOf(threshold)) {
        process.stderr.write(
          `${level.toUpperCase()} ${source}: ${format(...args)}\n`,
        );
      }
    };
  return {
    error: write("error"),
    warn: write("warn"),
    info: write("info"),
    debug: write("debug"),
  };
}

const noop = (): void => {};

/** Drops every line. */
export const silent: Logger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
};

/** Send `console` output to stderr through a logger, so nothing a library prints reaches stdout. */
export function captureConsole(): void {
  const stray = createLogger("console");
  console.log = stray.info;
  console.info = stray.info;
  console.debug = stray.debug;
  console.warn = stray.warn;
  console.error = stray.error;
}

/** A logger for the `neovim` client. The client logs every message at info, so its info counts as debug here. */
export function clientLogger(): Logger & { level: Level } {
  const client = createLogger("client");
  return {
    level: "debug",
    info: client.debug,
    warn: client.warn,
    error: client.error,
    debug: client.debug,
  };
}
