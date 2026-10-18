/** Downloads the summary model, so the first summary in an agent session does not wait on it. */

import { createLogger } from "./log.ts";
import { MODEL_DIR_ENV, MODEL_URI, resolveModel } from "./summary.ts";

const log = createLogger("model");

const dir = process.env[MODEL_DIR_ENV];
log.info("%s into %s", MODEL_URI, dir ?? "node-llama-cpp's default model directory");

try {
  // Progress goes to this terminal, which is not the service's msgpack stream.
  const path = await resolveModel({ progress: true });
  log.info("ready: %s", path);
} catch (err) {
  log.error("no model: %s", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
