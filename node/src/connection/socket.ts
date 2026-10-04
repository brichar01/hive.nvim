import net from "node:net";
import { attach } from "neovim";
import { createNvim } from "../nvim_wrapper.ts";
import { silent } from "../log.ts";
import type { ConnectOptions, OnClient } from "./types.ts";

/**
 * Create a server that serves each Neovim that connects, and closes the socket when
 * that client disconnects. The process keeps running for the next one.
 *
 * `listen` binds the server, and decides whether it is TCP or a Unix socket.
 */
export function serveSocket(
  listen: (server: net.Server) => void,
  onClient: OnClient,
  options: ConnectOptions,
): net.Server {
  const log = options.log ?? silent;

  const server = net.createServer((socket) => {
    const nvim = createNvim(
      attach({ reader: socket, writer: socket, options: options.attach }),
    );
    nvim.on("disconnect", () => socket.destroy());
    socket.on("error", (err) => {
      log.warn("socket error: %s", err.message);
    });
    onClient(nvim);
  });

  server.on("error", (err) => {
    log.error("server error: %s", err.message);
  });

  listen(server);
  return server;
}
