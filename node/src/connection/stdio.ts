import { attach } from "neovim";
import { createNvim } from "../nvim_wrapper.ts";
import type { ConnectOptions, OnClient, StdioTarget } from "./types.ts";

/** Serve the one Neovim that spawned the process, and exit the process when it disconnects. */
export function connectStdio(
  target: StdioTarget,
  onClient: OnClient,
  options: ConnectOptions,
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const nvim = createNvim(
    attach({
      reader: target.reader,
      writer: target.writer,
      options: options.attach,
    }),
  );
  nvim.on("disconnect", () => {
    exit(0);
  });
  onClient(nvim);
}
