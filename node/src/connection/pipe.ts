import type net from "node:net";
import { silent } from "../log.ts";
import { serveSocket } from "./socket.ts";
import type { ConnectOptions, OnClient, PipeTarget } from "./types.ts";

/** Listen on a Unix socket and serve each Neovim that connects. */
export function connectPipe(target: PipeTarget, onClient: OnClient, options: ConnectOptions): net.Server {
  const log = options.log ?? silent;
  return serveSocket(
    (server) =>
      server.listen(target.path, () => {
        log.info("listening on %s", target.path);
      }),
    onClient,
    options,
  );
}
