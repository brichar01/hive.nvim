import { parseCommandLine } from "./cli.ts";
import { createConnection } from "./connection_factory.ts";
import { createLogger, setLevel } from "./log.ts";
import { createHandlers } from "./rpc.ts";
import { createSessions, takeApiKey } from "./session.ts";

// ------- Logging -------

const log = createLogger("service");
const stray = createLogger("console");

console.log = stray.info;
console.info = stray.info;
console.debug = stray.debug;
console.warn = stray.warn;
console.error = stray.error;

// The client logs every message at info, so its info counts as debug here.
const client = createLogger("client");
const clientLogger = { level: "debug", info: client.debug, warn: client.warn, error: client.error, debug: client.debug };

// ------- Connection -------

const { target, level } = parseCommandLine(process.argv.slice(2), { reader: process.stdin, writer: process.stdout });
setLevel(level);

const sessions = createSessions(takeApiKey());

createConnection(target, createHandlers(sessions), { attach: { logger: clientLogger as never }, log });
