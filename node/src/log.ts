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
