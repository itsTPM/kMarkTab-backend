import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import type { Budget } from "./budget.ts";
import type { CuratedCollection } from "./curated.ts";
import type { DeckResult, Decks } from "./decks.ts";
import type { ClientLimits } from "./limits.ts";
import type { Log } from "./log.ts";
import { isCollectionId } from "./photo.ts";

// A random id the extension generates once per install, sent as X-Install-Id
const INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/;

export function createApp(deps: {
  decks: Decks;
  curated: CuratedCollection;
  limits: ClientLimits;
  budget: Budget;
  log: Log;
  clientIp: (c: Context) => string;
}) {
  const { decks, curated, limits, budget, log, clientIp } = deps;
  const app = new Hono();

  // No cookies or auth headers, so any origin may read the responses
  app.use(
    cors({ origin: "*", allowMethods: ["GET"], allowHeaders: ["X-Install-Id"], maxAge: 86400 }),
  );

  app.use(async (c, next) => {
    const verdict = limits.request(clientIp(c));
    if (!verdict.ok) {
      return tooMany(c, verdict.retryAfterMs);
    }
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/health", (c) =>
    c.json({
      curated: { photos: curated.size, syncedAt: curated.syncedAt },
      budget: budget.snapshot(),
    }),
  );

  app.get("/v1/curated", (c) => respond(c, decks.curated()));

  app.get("/v1/collections/:id", async (c) => {
    const id = c.req.param("id");
    if (!isCollectionId(id)) {
      return error(c, 400, "invalidCollection", "Not an Unsplash collection id");
    }
    const installId = c.req.header("X-Install-Id") ?? "";
    if (!INSTALL_ID.test(installId)) {
      return error(c, 400, "invalidInstallId", "X-Install-Id is missing or invalid");
    }
    const result = await decks.collection(id, installId, clientIp(c));
    if (result.kind === "upstream") {
      log.warn("Unsplash request failed", { collection: id, error: result.message });
    }
    if (result.kind === "budget") {
      log.warn("Deck refused for the Unsplash budget", {
        collection: id,
        reason: result.reason,
        budget: budget.snapshot(),
      });
    }
    return respond(c, result);
  });

  app.notFound((c) => error(c, 404, "notFound", "No such endpoint"));

  app.onError((err, c) => {
    log.error("Unhandled error", { path: c.req.path, error: String(err) });
    return error(c, 500, "internal", "Internal error");
  });

  return app;
}

function respond(c: Context, result: DeckResult) {
  switch (result.kind) {
    case "ok":
      return c.json({ photos: result.photos });
    case "notFound":
      return error(c, 404, "collectionNotFound", "No such public collection, or it has no photos");
    case "tooMany":
      return tooMany(c, result.retryAfterMs);
    case "noCurated":
      c.header("Retry-After", seconds(result.retryAfterMs));
      return error(c, 503, "curatedNotReady", "The curated collection isn't loaded yet");
    case "budget":
      c.header("Retry-After", seconds(result.retryAfterMs));
      return error(c, 503, "budgetExhausted", "The Unsplash request budget is used up for now");
    case "upstream":
      return error(c, 502, "upstream", "Unsplash request failed");
  }
}

function tooMany(c: Context, retryAfterMs: number) {
  c.header("Retry-After", seconds(retryAfterMs));
  return error(c, 429, "tooManyRequests", "Too many requests");
}

function error(
  c: Context,
  status: 400 | 404 | 429 | 500 | 502 | 503,
  code: string,
  message: string,
) {
  c.header("Cache-Control", "no-store");
  return c.json({ error: code, message }, status);
}

function seconds(ms: number) {
  return String(Math.max(Math.ceil(ms / 1000), 1));
}
