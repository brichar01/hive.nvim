import { type NvimConnection } from "./nvim_wrapper.ts";
import { createLogger } from "./log.ts";
import {
  isThinkingLevel,
  type PromptRequest,
  resolveTools,
  type Sessions,
  THINKING_LEVELS,
  TOOLS,
} from "./session.ts";
import { resolveModel } from "./summary.ts";

const log = createLogger("model");

export type Handler = (nvim: NvimConnection, args: unknown[]) => Promise<void>;

/** How much of the model is downloaded before `load` reports it, so a download is not one call per chunk. */
export const PROGRESS_STEP = 10;

/** What `load` tells Neovim through `hive.agent.on_load`. */
export type LoadStatus =
  | { status: "downloading"; percent: number }
  | { status: "ready"; path: string }
  | { status: "error"; error: string };

export interface HandlerOptions {
  /** The model resolve `load` calls. Defaults to `resolveModel`, so a test downloads nothing. */
  resolve?: typeof resolveModel;
}

/** Read the `{text, model, thinking, workbench, cwd, tools, log}` table Lua sends with `prompt`. */
export function parsePromptRequest(arg: unknown): PromptRequest {
  const fields = (typeof arg === "object" && arg !== null ? arg : {}) as Record<
    string,
    unknown
  >;
  const field = (name: string): string => {
    const value = fields[name];
    if (typeof value !== "string" || value === "") {
      throw new Error(`prompt: ${name} must be a non-empty string`);
    }
    return value;
  };
  const thinking = field("thinking");
  if (!isThinkingLevel(thinking)) {
    throw new Error(
      `prompt: thinking must be one of ${THINKING_LEVELS.join(", ")}, got ${thinking}`,
    );
  }
  const request = {
    text: field("text"),
    model: field("model"),
    thinking,
    workbench: field("workbench"),
    cwd: field("cwd"),
    log: field("log"),
  };
  const { tools } = fields;
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
    throw new Error(`prompt: tools must be a list of ${TOOLS.join(", ")}, with * patterns or +name/-name deltas`);
  }
  const names = tools;
  try {
    resolveTools(names);
  } catch (err) {
    throw new Error(`prompt: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return { ...request, tools: names };
}

export function createHandlers(
  sessions: Sessions,
  options: HandlerOptions = {},
): Record<string, Handler> {
  const resolve = options.resolve ?? resolveModel;
  /** The download in flight, so a second `load` joins the first instead of starting another. */
  let loading: Promise<string> | undefined;

  const report = (nvim: NvimConnection, update: LoadStatus): Promise<void> =>
    nvim
      .exec("require('hive.agent').on_load(...)", [update])
      .then(() => {})
      .catch((err: unknown) => {
        log.warn(
          "on_load: %s",
          err instanceof Error ? err.message : String(err),
        );
      });

  /** Download the summary model, reporting every `PROGRESS_STEP` percent and then how it ended. */
  const download = (nvim: NvimConnection): Promise<void> => {
    const start = async (): Promise<string> => {
      let reported = 0;
      const path = await resolve({
        onProgress: ({ downloadedSize, totalSize }) => {
          if (totalSize <= 0) {
            return;
          }
          const percent = Math.floor((downloadedSize / totalSize) * 100);
          if (percent < reported + PROGRESS_STEP) {
            return;
          }
          reported = percent;
          void report(nvim, { status: "downloading", percent });
        },
      });
      log.info("ready: %s", path);
      return path;
    };
    loading ??= start().finally(() => {
      loading = undefined;
    });
    return loading.then(
      (path) => report(nvim, { status: "ready", path }),
      (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("no model: %s", error);
        return report(nvim, { status: "error", error });
      },
    );
  };

  return {
    echo: async (nvim, args) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      await nvim.exec("require('hive.agent').on_echo(...)", [text]);
    },

    // Download the summary model now, so the first thinking line does not wait on it.
    load: (nvim) => download(nvim),
    prompt: (nvim, args) => sessions.prompt(nvim, parsePromptRequest(args[0])),
  };
}
