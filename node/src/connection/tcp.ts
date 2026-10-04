import type net from "node:net";
import { silent } from "../log.ts";
import { serveSocket } from "./socket.ts";
import type { ConnectOptions, OnClient, TcpTarget } from "./types.ts";

/** Listen on `<host>:<port>` and serve each Neovim that connects. */
export function connectTcp(
  target: TcpTarget,
  onClient: OnClient,
  options: ConnectOptions,
): net.Server {
  const log = options.log ?? silent;
  return serveSocket(
    (server) =>
      server.listen(target.port, target.host, () => {
        log.info("listening on %s:%d", target.host, target.port);
      }),
    onClient,
    options,
  );
}
