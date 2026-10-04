import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { createConnection, dispatch } from "../src/connection_factory.ts";
import { type Logger, silent } from "../src/log.ts";
import type { NvimConnection } from "../src/nvim_wrapper.ts";
import type { Handler } from "../src/rpc.ts";

const quiet = {
  attach: {
    logger: {
      level: "error",
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as never,
  },
};

const nvim: NvimConnection = { on: () => {}, exec: () => Promise.resolve(0) };

function recorder(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (fmt: unknown, ...args: unknown[]) => {
      lines.push(
        `${level} ${String(fmt)} ${args.map(String).join(" ")}`.trim(),
      );
    };
  return {
    log: {
      error: at("error"),
      warn: at("warn"),
      info: at("info"),
      debug: at("debug"),
    },
    lines,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("dispatch", () => {
  test("runs the handler named by the method with its arguments", async () => {
    const seen: unknown[][] = [];
    const handlers: Record<string, Handler> = {
      echo: (_, args) => {
        seen.push(args);
        return Promise.resolve();
      },
    };
    dispatch(nvim, handlers, silent)("echo", ["hi"]);
    await tick();
    assert.deepEqual(seen, [["hi"]]);
  });

  test("warns about an unknown method", () => {
    const { log, lines } = recorder();
    dispatch(nvim, {}, log)("nope", []);
    assert.ok(lines.includes("warn unknown notification: %s nope"));
  });

  test("logs a handler failure as an error", async () => {
    const { log, lines } = recorder();
    dispatch(
      nvim,
      { boom: () => Promise.reject(new Error("bang")) },
      log,
    )("boom", []);
    await tick();
    assert.ok(
      lines.some((line) => line.startsWith("error") && line.includes("bang")),
    );
  });
});

describe("createConnection", () => {
  test("stdio exits the process when the reader ends", async () => {
    const reader = new PassThrough();
    const codes: number[] = [];

    const server = createConnection(
      { kind: "stdio", reader, writer: new PassThrough() },
      {},
      { ...quiet, exit: (code) => codes.push(code) },
    );
    assert.equal(server, undefined);

    reader.end();
    await tick();
    assert.deepEqual(codes, [0]);
  });

  test("pipe serves each client and closes its socket on disconnect", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "hive-")), "agent.sock");
    const server = createConnection({ kind: "pipe", path }, {}, quiet);
    assert.ok(server);
    await once(server, "listening");

    try {
      for (let i = 0; i < 2; i++) {
        const client = net.connect(path).resume();
        await once(client, "connect");
        client.end();
        await once(client, "close");
      }
      assert.ok(server.listening);
    } finally {
      server.close();
    }
  });

  test("tcp listens on the given port", async () => {
    const server = createConnection(
      { kind: "tcp", host: "127.0.0.1", port: 0 },
      {},
      quiet,
    );
    assert.ok(server);
    await once(server, "listening");
    server.close();
  });
});
