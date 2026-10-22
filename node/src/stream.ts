/** Coalescing streamed text so Neovim gets one update per chunk instead of one per token. */

import type { ForwardedEvent } from "./protocol.ts";

/**
 * How much streamed text Neovim waits for before it sees a chunk. Both limits sit far above a
 * message, so in practice the next event flushes the buffer rather than its size.
 */
const STREAM_CHUNK_LINES = 2000;
const STREAM_CHUNK_CHARS = 100_000;

export interface Chunker {
  (event: ForwardedEvent): ForwardedEvent[];
  /** Send whatever is buffered now. */
  flush: () => ForwardedEvent[];
}

/**
 * Coalesce streamed text into chunks, so Neovim makes one RPC and one buffer update per chunk
 * instead of one per token. Every other event flushes what is buffered and passes through in
 * order, so a message's text reaches the buffer before the message's own event does.
 */
export function createChunker(): Chunker {
  let buffered = "";
  const flush = (): ForwardedEvent[] => {
    const delta = buffered;
    if (delta === "") {
      return [];
    }
    buffered = "";
    return [{ type: "text", delta }];
  };

  const chunk = (event: ForwardedEvent): ForwardedEvent[] => {
    if (event.type === "text") {
      buffered += event.delta;
      const lines = buffered.match(/\n/g)?.length ?? 0;
      const reached =
        buffered.length >= STREAM_CHUNK_CHARS || lines >= STREAM_CHUNK_LINES;
      return reached ? flush() : [];
    }
    return [...flush(), event];
  };
  chunk.flush = flush;
  return chunk;
}
