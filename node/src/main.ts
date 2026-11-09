import { parseCommandLine } from "./cli.ts";
import { createConnection } from "./connection_factory.ts";
import { captureConsole, clientLogger, createLogger, setLevel } from "./log.ts";
import { createHandlers } from "./rpc.ts";
import { takeApiKey } from "./credentials.ts";
import { createSessions } from "./sessions.ts";

// ------- Logging -------

const log = createLogger("service");
captureConsole();

// ------- Connection -------

const { target, level } = parseCommandLine(process.argv.slice(2), {
  reader: process.stdin,
  writer: process.stdout,
});
setLevel(level);

const sessions = createSessions(takeApiKey());

createConnection(target, createHandlers(sessions), {
  attach: { logger: clientLogger() as never },
  log,
});
