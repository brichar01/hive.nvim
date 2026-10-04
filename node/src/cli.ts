import { parseArgs } from "node:util";
import type { Target } from "./connection/types.ts";
import { isLevel, LEVELS, type Level } from "./log.ts";

export interface CommandLine {
  target: Target;
  level: Level;
}

type Stdio = Omit<Extract<Target, { kind: "stdio" }>, "kind">;

/**
 * Read the command line.
 *
 * No target flag means `stdio`. `--tcp <host>:<port>` and `--pipe <path>` listen.
 * `--log-level <error|warn|info|debug>` sets the verbosity, `info` by default.
 */
export function parseCommandLine(argv: string[], stdio: Stdio): CommandLine {
  const { values } = parseArgs({
    args: argv,
    options: {
      tcp: { type: "string" },
      pipe: { type: "string" },
      "log-level": { type: "string", default: "info" },
    },
    strict: true,
    allowPositionals: false,
  });

  const level = values["log-level"];
  if (!isLevel(level)) {
    throw new Error(`--log-level expects one of ${LEVELS.join(", ")}, got ${level}`);
  }

  return { target: parseTarget(values.tcp, values.pipe, stdio), level };
}

function parseTarget(tcp: string | undefined, pipe: string | undefined, stdio: Stdio): Target {
  if (tcp !== undefined && pipe !== undefined) {
    throw new Error("give --tcp or --pipe, not both");
  }

  if (pipe !== undefined) {
    if (pipe === "") {
      throw new Error("--pipe needs a path");
    }
    return { kind: "pipe", path: pipe };
  }

  if (tcp !== undefined) {
    const at = tcp.lastIndexOf(":");
    const host = at > 0 ? tcp.slice(0, at) : "";
    const port = Number(tcp.slice(at + 1));
    if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`--tcp expects <host>:<port>, got ${tcp}`);
    }
    return { kind: "tcp", host, port };
  }

  return { kind: "stdio", ...stdio };
}
