import { resolve } from "node:path";
import {
  type ExtensionFactory,
  isEditToolResult,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "./log.ts";
import type { NvimConnection } from "./nvim_wrapper.ts";

const log = createLogger("diagnostics");

/** One entry of what `require('hive.diagnostics').collect` returns. */
export interface Diagnostic {
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
  source?: string;
}

/** The text added to a `write` or `edit` result. */
export function formatDiagnostics(
  path: string,
  diagnostics: Diagnostic[],
): string {
  if (diagnostics.length === 0) {
    return `LSP: no errors or warnings in ${path}.`;
  }
  const lines = diagnostics.map(({ line, col, severity, message, source }) => {
    const from = source ? ` [${source}]` : "";
    return `${String(line)}:${String(col)} ${severity}: ${message.replaceAll("\n", " ")}${from}`;
  });
  return [`LSP diagnostics for ${path}:`, ...lines].join("\n");
}

/** Add the language server's errors and warnings for the changed buffer to each `write` and `edit` result. */
export function diagnosticsExtension(
  nvim: NvimConnection,
  cwd: string,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (
        event.isError ||
        !(isWriteToolResult(event) || isEditToolResult(event))
      ) {
        return undefined;
      }
      const { path } = event.input;
      if (typeof path !== "string") {
        return undefined;
      }

      let diagnostics: unknown;
      try {
        diagnostics = await nvim.exec(
          "return require('hive.diagnostics').collect(...)",
          [resolve(cwd, path)],
        );
      } catch (err) {
        log.warn(
          "collect: %s",
          err instanceof Error ? err.message : String(err),
        );
        return undefined;
      }
      if (!Array.isArray(diagnostics)) {
        return undefined;
      }
      return {
        content: [
          ...event.content,
          {
            type: "text",
            text: formatDiagnostics(path, diagnostics as Diagnostic[]),
          },
        ],
      };
    });
  };
}
