import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

import { createApp } from "./app.ts";
import { Budget } from "./budget.ts";
import { loadConfig } from "./config.ts";
import { CuratedCollection } from "./curated.ts";
import { Decks } from "./decks.ts";
import { ClientLimits } from "./limits.ts";
import { consoleLog as log } from "./log.ts";
import { createUnsplash } from "./unsplash.ts";

const SWEEP_MS = 10 * 60_000;

const config = loadConfig();
const budget = new Budget();
const unsplash = createUnsplash({ accessKey: config.unsplashAccessKey, budget });
const curated = new CuratedCollection({
  collectionId: config.curatedCollectionId,
  unsplash,
  file: config.curatedFile,
  intervalMs: config.curatedSyncMs,
  log,
});
const limits = new ClientLimits();
const decks = new Decks({ curated, unsplash, limits });

function clientIp(c: Context): string {
  if (config.trustProxy) {
    // the proxy appends the address it saw; what comes before it is up to the client
    const forwarded = c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return getConnInfo(c).remote.address ?? "unknown";
}

await curated.load();
curated.start();

const sweep = setInterval(() => {
  limits.sweep();
  decks.sweep();
}, SWEEP_MS);
sweep.unref();

const app = createApp({ decks, curated, limits, budget, log, clientIp });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info("Listening", { port: info.port });
});

function shutdown() {
  curated.stop();
  clearInterval(sweep);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
