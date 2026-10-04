import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createLogger, setLevel } from "../src/log.ts";

function capture(run: () => void): string {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string) => {
    lines.push(chunk);
    return true;
  };
  try {
    run();
  } finally {
    process.stderr.write = write;
  }
  return lines.join("");
}

afterEach(() => {
  setLevel("info");
});

test("lines start with the level and the source", () => {
  const out = capture(() => {
    createLogger("rpc").warn("exec: %s", "x()");
  });
  assert.equal(out, "WARN rpc: exec: x()\n");
});

test("levels more verbose than the threshold are dropped", () => {
  setLevel("warn");
  const log = createLogger("service");
  const out = capture(() => {
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
  });
  assert.equal(out, "ERROR service: e\nWARN service: w\n");
});

test("debug prints every level", () => {
  setLevel("debug");
  const out = capture(() => {
    createLogger("client").debug("d");
  });
  assert.equal(out, "DEBUG client: d\n");
});
