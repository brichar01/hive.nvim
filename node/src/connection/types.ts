import type { attach } from "neovim";
import type { Logger } from "../log.ts";
import type { NvimConnection } from "../nvim_wrapper.ts";

export type AttachOptions = NonNullable<Parameters<typeof attach>[0]["options"]>;

export type StdioTarget = { kind: "stdio"; reader: NodeJS.ReadableStream; writer: NodeJS.WritableStream };
export type TcpTarget = { kind: "tcp"; host: string; port: number };
export type PipeTarget = { kind: "pipe"; path: string };

export type Target = StdioTarget | TcpTarget | PipeTarget;

/** Called once for each Neovim client the connection creates. */
export type OnClient = (nvim: NvimConnection) => void;

export interface ConnectOptions {
  attach?: AttachOptions;
  log?: Logger;
  /** Called when a stdio client disconnects. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}
