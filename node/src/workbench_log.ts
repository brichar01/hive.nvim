import { appendFile } from "node:fs/promises";
import { createLogger } from "./log.ts";

const log = createLogger("workbench-log");

/** What a workbench's log holds, keyed by the entry the message it came from writes. */
export type LoggedEntry =
  | { type: "thinking"; id: string; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown };

export interface WorkbenchLog {
  /** Append `entry` as one JSON line, with its timestamp. Never rejects. */
  write: (entry: LoggedEntry) => Promise<void>;
  /** Resolve once every write queued so far has finished. */
  drained: () => Promise<void>;
}

/**
 * The workbench's backing file, next to it with a `.log` extension. Raw thinking and tool calls
 * go here instead of into the buffer, one JSON object per line. `id` is the message's entry, the
 * hash its `<!-- hive:entry -->` tag shows, so a line can be found from the message it belongs to.
 */
export function createWorkbenchLog(path: string): WorkbenchLog {
  let queue = Promise.resolve();
  const write = (entry: LoggedEntry): Promise<void> => {
    const { id, ...rest } = entry;
    const line =
      JSON.stringify({ id, ts: new Date().toISOString(), ...rest }) + "\n";
    queue = queue.then(() => appendFile(path, line)).catch((err: unknown) => {
      log.warn(
        "append %s: %s",
        path,
        err instanceof Error ? err.message : String(err),
      );
    });
    return queue;
  };
  return { write, drained: () => queue };
}
