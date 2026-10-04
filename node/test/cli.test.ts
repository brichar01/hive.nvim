import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { parseCommandLine } from "../src/cli.ts";

const stdio = { reader: new PassThrough(), writer: new PassThrough() };

describe("parseCommandLine", () => {
  test("no arguments is stdio at info", () => {
    const { target, level } = parseCommandLine([], stdio);
    assert.equal(target.kind, "stdio");
    assert.equal(level, "info");
  });

  test("--pipe takes a path", () => {
    assert.deepEqual(
      parseCommandLine(["--pipe", "/tmp/hive.sock"], stdio).target,
      {
        kind: "pipe",
        path: "/tmp/hive.sock",
      },
    );
  });

  test("--tcp splits host and port", () => {
    assert.deepEqual(
      parseCommandLine(["--tcp", "127.0.0.1:7777"], stdio).target,
      {
        kind: "tcp",
        host: "127.0.0.1",
        port: 7777,
      },
    );
  });

  test("--tcp refuses a missing or invalid port", () => {
    assert.throws(() => parseCommandLine(["--tcp", "localhost"], stdio));
    assert.throws(() => parseCommandLine(["--tcp", "localhost:0"], stdio));
    assert.throws(() => parseCommandLine(["--tcp", ":7777"], stdio));
  });

  test("--tcp and --pipe together are refused", () => {
    assert.throws(() =>
      parseCommandLine(
        ["--tcp", "127.0.0.1:7777", "--pipe", "/tmp/hive.sock"],
        stdio,
      ),
    );
  });

  test("a flag without a value is refused", () => {
    assert.throws(() => parseCommandLine(["--pipe"], stdio));
    assert.throws(() => parseCommandLine(["--pipe", ""], stdio));
  });

  test("an unknown flag is refused", () => {
    assert.throws(() => parseCommandLine(["--socket", "x"], stdio));
  });

  test("--log-level sets the level, in any position", () => {
    const { target, level } = parseCommandLine(
      ["--pipe", "/tmp/hive.sock", "--log-level", "debug"],
      stdio,
    );
    assert.equal(target.kind, "pipe");
    assert.equal(level, "debug");
  });

  test("--log-level refuses an unknown level", () => {
    assert.throws(
      () => parseCommandLine(["--log-level", "trace"], stdio),
      /--log-level expects one of/,
    );
  });
});
