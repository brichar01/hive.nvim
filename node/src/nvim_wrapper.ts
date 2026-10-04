import type { NeovimClient } from "neovim";
import { createLogger } from "./log.ts";

const log = createLogger("nvim");

type ExecuteLua = NeovimClient["executeLua"];

export interface NvimConnection {
  on: (...args: Parameters<NeovimClient["on"]>) => void;
  exec: (...args: Parameters<ExecuteLua>) => ReturnType<ExecuteLua>;
}

export const createNvim = (nvim: NeovimClient): NvimConnection => {
  const on: NvimConnection["on"] = (event, listener) => {
    nvim.on(event, listener);
  };

  const exec: NvimConnection["exec"] = (code, args) => {
    log.info(code, args);
    return nvim.executeLua(code, args);
  };

  return { on, exec };
};
