/** Summaries of a message's thinking, from a small model running beside the agent. */

import { truncate } from "./hint.ts";
import { createLogger } from "./log.ts";
import type { LlamaChatSession } from "node-llama-cpp";

const log = createLogger("summary");

/**
 * The model a summary comes from: a half-billion parameter instruct model, quantised to run on a
 * CPU in about a second. It is downloaded on first use into `MODEL_DIR_ENV`'s directory.
 */
export const MODEL_URI =
  "hf:bartowski/Qwen2.5-0.5B-Instruct-GGUF/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf";

/** Where models are kept, when set. Unset uses node-llama-cpp's own `~/.node-llama-cpp/models`. */
export const MODEL_DIR_ENV = "HIVE_MODEL_DIR";

/** Tokens of a message's thinking a summary reads, so a long block stays a fast summary. */
export const THINKING_INPUT_CHARS = 3000;

/** Non-whitespace characters a summary keeps. */
export const SUMMARY_CHARS = 100;

/** Tokens the model may generate: room for one sentence, too little for a paragraph. */
export const SUMMARY_TOKENS = 64;

/** Tokens of context the model gets: the prompt and the thinking block, with room to spare. */
export const CONTEXT_TOKENS = 4096;

/** How long a summary may take before the thinking line falls back to its preview. */
export const SUMMARY_TIMEOUT_MS = 4000;

/**
 * The instruction a message's thinking is summarised under. The example teaches the shape of the
 * line, and is about invoices rather than code so that an agent's reasoning does not tempt the
 * model to copy it.
 */
export const SUMMARY_PROMPT =
  "Write a one-line status for the reasoning below: what it works on and where it is heading. " +
  "At most 12 words, no quotes, no preamble. Start with a verb in -ing form.\n" +
  "\n" +
  'Example reasoning: "The invoice totals drift because each line rounds on its own. Summing first and rounding once fixes it."\n' +
  'Example status: "Fixing invoice rounding by summing before rounding"\n' +
  "Do not copy the example's wording; describe the reasoning below.\n" +
  "\n";

/** How a model's line starts when it names itself: `Summary:`, `**Status** -` and the like. */
const LABEL = /^[\s*_#>-]*(?:status|summary)[\s*_:-]*/i;

/** How a model's line starts with a list marker: `1.`, `-`, `•`. */
const MARKER = /^(?:\d+[.)]|[-*•])\s+/;

/** Quotes and emphasis a model wraps a line in. */
const EDGES = /^[\s*_'"`\u2018\u2019\u201c\u201d]+|[\s*_'"`\u2018\u2019\u201c\u201d]+$/g;

/** One sentence: everything up to the first full stop. */
const SENTENCE = /^.*?[.!?](?=\s|$)/;

/** The prompt that asks for a summary of `thinking`, cut to `THINKING_INPUT_CHARS`. */
export function summaryPrompt(thinking: string): string {
  const text = truncate(thinking, THINKING_INPUT_CHARS);
  return `${SUMMARY_PROMPT}<thinking>\n${text}\n</thinking>\nStatus:`;
}

/** One line from the model's output: its first sentence, without quotes or labels, cut to `SUMMARY_CHARS`. */
export function summaryLine(output: string): string {
  const line = truncate(output).replace(LABEL, "").replace(MARKER, "").replace(EDGES, "");
  return truncate(SENTENCE.exec(line)?.[0] ?? line, SUMMARY_CHARS);
}

/** The model call a summary makes: the prompt in, the model's answer out. */
export type Ask = (prompt: string) => Promise<string>;

export interface SummarizerOptions {
  /** The model file to load, or the URI to download it from. Defaults to `MODEL_URI`. */
  model?: string;
  /** Where models are kept and downloaded to. Defaults to `MODEL_DIR_ENV`'s value, if set. */
  dir?: string;
  /** How long `summarize` waits for the model. Defaults to `SUMMARY_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** The model call, in place of a local model. Defaults to one that loads `model`. */
  ask?: Ask;
}

export interface Summarizer {
  /**
   * A one-line summary of `thinking`, or an empty string when it has none: no model yet, a
   * failure, or a timeout. Never rejects.
   */
  summarize: (thinking: string) => Promise<string>;
}

/**
 * Turns a message's thinking into a summary line, keeping one small model loaded for every
 * message that needs one. The model is downloaded and loaded on the first summary, so early
 * messages show their preview instead.
 */
export function createSummarizer(options: SummarizerOptions = {}): Summarizer {
  const ask =
    options.ask ??
    localModel(options.model ?? MODEL_URI, options.dir ?? process.env[MODEL_DIR_ENV]);
  const timeoutMs = options.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  /** The summary in flight, so one model call runs at a time. */
  let queue: Promise<string> = Promise.resolve("");
  /** Whether a failure was already reported, so a broken model says so once. */
  let failed = false;

  const summarise = (thinking: string): Promise<string> => {
    if (truncate(thinking) === "") {
      return Promise.resolve("");
    }
    const prompt = summaryPrompt(thinking);
    const work = queue
      .then(() => ask(prompt))
      .then(summaryLine, (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        (failed ? log.debug : log.warn)("no summary: %s", message);
        failed = true;
        return "";
      });
    queue = work;
    return capped(work, timeoutMs);
  };

  return { summarize: summarise };
}

/** `work`, or `""` once it takes longer than `ms`. The work itself runs on, for the next message. */
function capped(work: Promise<string>, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve("");
    }, ms);
    timer.unref();
    void work.then((summary) => {
      clearTimeout(timer);
      resolve(summary);
    });
  });
}

/** The model call a summarizer makes: a small Llama model, downloaded and loaded on first use. */
function localModel(model: string, dir: string | undefined): Ask {
  let ready: Promise<LlamaChatSession> | undefined;

  const load = async (): Promise<LlamaChatSession> => {
    const nlc = await import("node-llama-cpp");
    // `download: "auto"` fetches the model the first time, and `cli: false` keeps the console
    // clear: this process's stdout carries the msgpack stream.
    log.info("looking for %s", model);
    const path = await nlc.resolveModelFile(model, {
      directory: dir,
      download: "auto",
      cli: false,
    });
    log.info("loading %s", path);
    const llama = await nlc.getLlama({ gpu: false });
    const loaded = await llama.loadModel({ modelPath: path });
    const context = await loaded.createContext({ contextSize: CONTEXT_TOKENS });
    return new nlc.LlamaChatSession({ contextSequence: context.getSequence() });
  };

  return async (prompt: string): Promise<string> => {
    if (ready === undefined) {
      const loading = load();
      // A load that failed leaves nothing behind, so the next message tries again.
      void loading.catch(() => {
        ready = undefined;
      });
      ready = loading;
    }
    const session = await ready;
    // A summarizer runs one call at a time, so one session serves them all, with its history
    // cleared so a message's thinking never colours the next summary.
    session.setChatHistory([]);
    return session.prompt(prompt, { maxTokens: SUMMARY_TOKENS, temperature: 0 });
  };
}
