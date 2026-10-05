// HTTP server: API + the static dashboard from ./frontend.
//   deno task dev      (watch mode)
//   deno task start
// Set RUN_WORKER_INLINE=true to also run the background worker in this process (handy locally).
import { getConfig } from "./config.ts";
import { buildApp } from "./app.ts";
import { log } from "./lib/log.ts";
import { startWorker } from "./worker.ts";

const cfg = getConfig();
const app = buildApp({ staticRoot: "./frontend" });

if (Deno.env.get("RUN_WORKER_INLINE") === "true") startWorker();

Deno.serve({ port: cfg.port, onListen: ({ port }) => log("info", "server.listening", { port, env: cfg.env }) }, app.fetch);
