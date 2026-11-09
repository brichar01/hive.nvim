import net from "node:net";
import { attach } from "neovim";
import { type Logger, silent } from "../log.ts";
import { createNvim, type NvimConnection } from "../nvim_wrapper.ts";
import type { AttachOptions } from "./types.ts";

/** A connection to a Neovim's own RPC socket, the one `$NVIM` and `v:servername` name. */
export interface DialledNvim {
  nvim: NvimConnection;
  socket: string;
  /** True once the socket has closed, from either end. */
  closed: () => boolean;
  close: () => void;
}

export interface DialOptions {
  attach?: AttachOptions;
  log?: Logger;
}

/** Connect to the Neovim listening on `socket`. Rejects when nothing accepts the connection. */
export async function dialSocket(
  socket: string,
  options: DialOptions = {},
): Promise<DialledNvim> {
  const log = options.log ?? silent;
  const stream = net.createConnection(socket);
  await new Promise<void>((resolve, reject) => {
    stream.once("connect", resolve);
    stream.once("error", reject);
  });
  stream.on("error", (err) => {
    log.warn("%s: %s", socket, err.message);
  });

  const nvim = createNvim(
    attach({ reader: stream, writer: stream, options: options.attach }),
  );
  return {
    nvim,
    socket,
    closed: () => stream.destroyed,
    // Destroying the socket rejects the client's decoder unhandled, so end it and let Neovim close its side.
    close: () => stream.end(),
  };
}
