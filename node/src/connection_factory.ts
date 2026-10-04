import type net from "node:net";
import { connectPipe } from "./connection/pipe.ts";
import { connectStdio } from "./connection/stdio.ts";
import { connectTcp } from "./connection/tcp.ts";
import type { ConnectOptions, OnClient, Target } from "./connection/types.ts";
import { type Logger, silent } from "./log.ts";
import type { Handler } from "./rpc.ts";
import type { NvimConnection } from "./nvim_wrapper.ts";

export type { ConnectOptions, Target } from "./connection/types.ts";

export function dispatch(
  nvim: NvimConnection,
  handlers: Record<string, Handler>,
  log: Logger,
): (method: string, args: unknown[]) => void {
  return (method, args) => {
    log.debug("notification: %s", method);
    const handler = handlers[method];
    if (!handler) {
      log.warn("unknown notification: %s", method);
      return;
    }
    handler(nvim, args).catch((err: unknown) => {
      log.error(
        "%s: %s",
        method,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    });
  };
}

/**
 * Connect Neovim to the service on `target`, and route each client's notifications to `handlers`.
 *
 * Returns the listening server for `tcp` and `pipe`, and `undefined` for `stdio`.
 */
export function createConnection(
  target: Target,
  handlers: Record<string, Handler>,
  options: ConnectOptions = {},
): net.Server | undefined {
  const onClient: OnClient = (nvim: NvimConnection) => {
    nvim.on("notification", dispatch(nvim, handlers, options.log ?? silent));
  };

  switch (target.kind) {
    case "stdio":
      connectStdio(target, onClient, options);
      return undefined;
    case "tcp":
      return connectTcp(target, onClient, options);
    case "pipe":
      return connectPipe(target, onClient, options);
  }
}
