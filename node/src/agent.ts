/** Build one Pi agent session wired to a Neovim connection. */

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { memoryStore } from "./credentials.ts";
import { diagnosticsExtension } from "./diagnostics.ts";
import { createNvimOperations } from "./nvim_ops.ts";
import type { NvimConnection } from "./nvim_wrapper.ts";
import { HIVE_SYSTEM_PROMPT, PROVIDER, type PromptRequest } from "./protocol.ts";
import { buildTools } from "./tools.ts";

export interface AgentOptions {
  /** Pi's global config directory. Defaults to Pi's own, `~/.pi/agent`. */
  agentDir?: string;
  /** Pi settings for the session. Nothing is read from Pi's settings files. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /** Replaces the catalogue's `https://api.deepseek.com`, for a stub server. */
  baseUrl?: string;
}

export async function createSession(
  nvim: NvimConnection,
  request: PromptRequest,
  apiKey: string | undefined,
  options: AgentOptions,
): Promise<AgentSession> {
  const runtime = await ModelRuntime.create({
    credentials: memoryStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  // With no key, Pi falls back to `DEEPSEEK_API_KEY` in the service's environment.
  if (apiKey) {
    await runtime.setRuntimeApiKey(PROVIDER, apiKey);
  }

  const model = runtime.getModel(PROVIDER, request.model);
  if (!model) {
    throw new Error(`unknown DeepSeek model: ${request.model}`);
  }

  const { cwd } = request;
  const ops = createNvimOperations(nvim);
  const settingsManager = SettingsManager.inMemory(options.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    // Replace the base prompt:
    systemPromptOverride: (base) => (base || "") + "\n\n" + HIVE_SYSTEM_PROMPT,
    settingsManager,
    extensionFactories: [
      { name: "hive-diagnostics", factory: diagnosticsExtension(nvim, cwd) },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: options.agentDir,
    // read, write and edit go through Neovim's buffers. The rest read the filesystem.
    noTools: "builtin",
    customTools: buildTools(cwd, ops),
    resourceLoader,
    modelRuntime: runtime,
    model: options.baseUrl ? { ...model, baseUrl: options.baseUrl } : model,
    thinkingLevel: request.thinking,
    sessionManager: SessionManager.inMemory(request.cwd),
    settingsManager,
  });
  return session;
}
