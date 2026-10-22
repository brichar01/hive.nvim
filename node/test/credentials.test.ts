import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY_ENV, takeApiKey } from "../src/credentials.ts";

test("takeApiKey reads the key and removes it from the environment", () => {
  const env = { [KEY_ENV]: "secret" };
  assert.equal(takeApiKey(env), "secret");
  assert.equal(KEY_ENV in env, false);
});

test("takeApiKey treats an empty value as no key", () => {
  assert.equal(takeApiKey({ [KEY_ENV]: "" }), undefined);
});
