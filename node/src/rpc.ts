import { type NvimConnection } from "./nvim_wrapper.ts";
import {
  isThinkingLevel,
  type PromptRequest,
  type Sessions,
  THINKING_LEVELS,
} from "./session.ts";

export type Handler = (nvim: NvimConnection, args: unknown[]) => Promise<void>;

/** Read the `{text, model, thinking, workbench, cwd}` table Lua sends with `prompt`. */
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
  return {
    text: field("text"),
    model: field("model"),
    thinking,
    workbench: field("workbench"),
    cwd: field("cwd"),
  };
}

export function createHandlers(sessions: Sessions): Record<string, Handler> {
  return {
    echo: async (nvim, args) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      await nvim.exec("require('hive.agent').on_echo(...)", [text]);
    },

    prompt: (nvim, args) => sessions.prompt(nvim, parsePromptRequest(args[0])),
  };
}
