/** One agent session per workbench, and the events that reach its buffer and log. */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type AgentOptions, createSession } from "./agent.ts";
import { forward } from "./events.ts";
import type { ArgsOf } from "./hint.ts";
import { createLogger } from "./log.ts";
import type { NvimConnection } from "./nvim_wrapper.ts";
import {
  type ForwardedEvent,
  type PromptRequest,
} from "./protocol.ts";
import { createRouter, type Router } from "./router.ts";
import { createSummarizer, type Summarizer } from "./summary.ts";
import { setTools } from "./tools.ts";
import { createWorkbenchLog } from "./workbench_log.ts";

const log = createLogger("session");

export interface SessionOptions extends AgentOptions {
  /** What a message's thinking line summarises it with. Defaults to `createSummarizer`. */
  summarizer?: Summarizer;
}

export interface Sessions {
  prompt: (nvim: NvimConnection, request: PromptRequest) => Promise<void>;
}

/**
 * One workbench's session and event pipeline. Events are forwarded a microtask after their
 * listener, in order, so a `message_end` sees its saved entry. Awaiting the router keeps that
 * order across a header that waits for a summary.
 */
class Workbench {
  readonly model: string;
  readonly session: AgentSession;
  #queue = Promise.resolve();
  #router: Router;

  constructor(
    model: string,
    session: AgentSession,
    router: Router,
    idOf: (message: object) => string | undefined,
    argsOf: ArgsOf,
  ) {
    this.model = model;
    this.session = session;
    this.#router = router;
    session.subscribe((event) => {
      this.#queue = this.#queue.then(async () => {
        const forwarded = forward(event, idOf, argsOf);
        if (forwarded) {
          await this.#router(forwarded);
        }
      });
    });
  }

  /** Apply a prompt's thinking level and tool selection to an existing session. */
  apply(request: PromptRequest): void {
    this.session.setThinkingLevel(request.thinking);
    setTools(this.session, request.tools);
  }

  /** Resolve once every event so far has been forwarded and logged. */
  async drained(): Promise<void> {
    await this.#queue;
    await this.#router.drained();
  }

  /** Send any buffered stream text before an error ends the prompt. */
  flush(): void {
    this.#router.flush();
  }

  dispose(): void {
    this.session.dispose();
  }
}

/**
 * One agent session for each workbench of each Neovim client. A prompt with a different model
 * replaces its workbench's session, and the history with it.
 */
export function createSessions(
  apiKey: string | undefined,
  options: SessionOptions = {},
): Sessions {
  const clients = new WeakMap<NvimConnection, Map<string, Workbench>>();
  // One model for every workbench: loading it is the expensive part of a summary.
  const summarizer = options.summarizer ?? createSummarizer();

  const send = (nvim: NvimConnection, event: ForwardedEvent): void => {
    nvim
      .exec("require('hive.agent').on_event(...)", [event])
      .catch((err: unknown) => {
        log.warn(
          "on_event: %s",
          err instanceof Error ? err.message : String(err),
        );
      });
  };

  const workbenchesOf = (nvim: NvimConnection): Map<string, Workbench> => {
    let workbenches = clients.get(nvim);
    if (!workbenches) {
      const created = new Map<string, Workbench>();
      nvim.on("disconnect", () => {
        for (const workbench of created.values()) {
          workbench.dispose();
        }
      });
      clients.set(nvim, created);
      workbenches = created;
    }
    return workbenches;
  };

  const workbenchFor = async (
    nvim: NvimConnection,
    request: PromptRequest,
  ): Promise<Workbench> => {
    const workbenches = workbenchesOf(nvim);
    const current = workbenches.get(request.workbench);
    if (current?.model === request.model) {
      current.apply(request);
      return current;
    }
    current?.dispose();

    const session = await createSession(nvim, request, apiKey, options);
    setTools(session, request.tools);
    const idOf = (message: object): string | undefined =>
      session.sessionManager
        .getBranch()
        .findLast(
          (entry) => entry.type === "message" && entry.message === message,
        )?.id;

    const argsOf = (callId: string): unknown =>
      session.messages
        .flatMap((m) => (m.role === "assistant" ? m.content : []))
        .flatMap((c) =>
          c.type === "toolCall" && c.id === callId ? [c.arguments] : [],
        )
        .at(-1);

    const router = createRouter(
      (event) => {
        send(nvim, event);
      },
      createWorkbenchLog(request.log),
      summarizer.summarize,
    );
    const workbench = new Workbench(
      request.model,
      session,
      router,
      idOf,
      argsOf,
    );
    workbenches.set(request.workbench, workbench);
    return workbench;
  };

  return {
    prompt: async (nvim, request) => {
      try {
        const workbench = await workbenchFor(nvim, request);
        await workbench.session.prompt(request.text);
        await workbench.drained();
      } catch (err) {
        clients.get(nvim)?.get(request.workbench)?.flush();
        send(nvim, {
          type: "end",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
