import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { Budget } from "../src/budget.ts";
import { CuratedCollection } from "../src/curated.ts";
import { Decks } from "../src/decks.ts";
import { ClientLimits } from "../src/limits.ts";
import { silentLog, type Fields, type Log } from "../src/log.ts";
import { UnsplashError, type Unsplash } from "../src/unsplash.ts";
import { Clock, fakeUnsplash, photos } from "./helpers.ts";

const MINUTE_MS = 60_000;
const INSTALL = { "X-Install-Id": "0f8fad5b-d9cb-469f-a165-70867728950e" };

const dirs: string[] = [];

const body = (res: Response): Promise<any> => res.json();

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(
  options: {
    collection?: Unsplash["collection"];
    random?: Unsplash["randomFromCollection"];
    curated?: number;
  } = {},
) {
  const clock = new Clock();
  const dir = await mkdtemp(join(tmpdir(), "app-"));
  dirs.push(dir);
  const collection = vi.fn(
    options.collection ?? ((id: string) => Promise.resolve({ id, totalPhotos: 100 })),
  );
  const random = vi.fn(options.random ?? (() => Promise.resolve(photos("u", 30))));
  const unsplash = fakeUnsplash({
    collection,
    collectionPage: () =>
      Promise.resolve({ photos: photos("cur", options.curated ?? 50), next: false }),
    randomFromCollection: random,
  });
  const curated = new CuratedCollection({
    collectionId: "curated1",
    unsplash,
    file: join(dir, "curated.json"),
    intervalMs: 60 * MINUTE_MS,
    log: silentLog,
    now: clock.now,
  });
  if (options.curated !== 0) {
    await curated.sync();
  }
  const limits = new ClientLimits(clock.now);
  const warnings: { message: string; fields?: Fields }[] = [];
  const log: Log = { ...silentLog, warn: (message, fields) => warnings.push({ message, fields }) };
  const app = createApp({
    decks: new Decks({ curated, unsplash, limits, now: clock.now }),
    curated,
    limits,
    budget: new Budget(1000, clock.now),
    log,
    clientIp: (c) => c.req.header("X-Test-Ip") ?? "127.0.0.1",
  });
  return { app, clock, collection, random, warnings };
}

describe("GET /v1/curated", () => {
  it("serves 30 random curated photos", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/curated");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const { photos } = await body(res);
    expect(photos).toHaveLength(30);
    expect(photos[0]).toHaveProperty("author.name");
  });

  it("answers 503 curatedNotReady until the first sync", async () => {
    const { app } = await setup({ curated: 0 });
    const res = await app.request("/v1/curated");
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("curatedNotReady");
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("GET /v1/collections/:id", () => {
  it("serves a random deck of the collection from Unsplash", async () => {
    const { app, random } = await setup();
    const res = await app.request("/v1/collections/bHDh4Ae7O8o", { headers: INSTALL });
    expect(res.status).toBe(200);
    expect((await body(res)).photos).toHaveLength(30);
    expect(random).toHaveBeenCalledWith("bHDh4Ae7O8o", 30, "firstDeck");
  });

  it("asks with the regular priority after the first deck", async () => {
    const { app, clock, random } = await setup();
    await app.request("/v1/collections/c1", { headers: INSTALL });
    clock.advance(5 * MINUTE_MS);
    await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(random.mock.calls.map((call) => call[2])).toEqual(["firstDeck", "deck"]);
  });

  it("serves the curated collection entered by hand from what it has", async () => {
    const { app, random } = await setup();
    const res = await app.request("/v1/collections/curated1", { headers: INSTALL });
    expect(res.status).toBe(200);
    expect(random).not.toHaveBeenCalled();
  });

  it("rejects an invalid collection id or install id", async () => {
    const { app } = await setup();
    const badId = await app.request("/v1/collections/a%20b", { headers: INSTALL });
    expect(badId.status).toBe(400);
    expect((await body(badId)).error).toBe("invalidCollection");

    const noInstall = await app.request("/v1/collections/c1");
    expect(noInstall.status).toBe(400);
    expect((await body(noInstall)).error).toBe("invalidInstallId");
  });

  it("answers 429 with Retry-After past a limit", async () => {
    const { app } = await setup();
    for (let i = 0; i < 10; i++) {
      await app.request(`/v1/collections/c${i}`, { headers: INSTALL });
    }
    const res = await app.request("/v1/collections/c10", { headers: INSTALL });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(24 * 60 * 60));
  });

  it("checks the collection once before its decks", async () => {
    const { app, clock, collection, random } = await setup();
    await app.request("/v1/collections/c1", { headers: INSTALL });
    clock.advance(5 * MINUTE_MS);
    await app.request("/v1/collections/c1", { headers: INSTALL });
    // another install of the same collection
    await app.request("/v1/collections/c1", { headers: { "X-Install-Id": "another-install" } });
    expect(collection).toHaveBeenCalledTimes(1);
    expect(collection).toHaveBeenCalledWith("c1", "firstDeck");
    expect(random).toHaveBeenCalledTimes(3);

    // checked again after 6 hours: it may have been deleted or made private since
    clock.advance(6 * 60 * MINUTE_MS);
    await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(collection).toHaveBeenCalledTimes(2);
  });

  it("remembers a missing or private collection for an hour", async () => {
    const { app, clock, collection, random } = await setup({
      collection: () => Promise.reject(new UnsplashError("notFound", "Not found")),
    });
    const res = await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe("collectionNotFound");
    // /photos/random would have returned photos from all of Unsplash
    expect(random).not.toHaveBeenCalled();

    // other installs get the answer without asking Unsplash
    const other = { "X-Install-Id": "another-install" };
    expect((await app.request("/v1/collections/c1", { headers: other })).status).toBe(404);
    expect(collection).toHaveBeenCalledTimes(1);

    clock.advance(60 * MINUTE_MS);
    await app.request("/v1/collections/c1", { headers: other });
    expect(collection).toHaveBeenCalledTimes(2);
  });

  // Unsplash updates the count minutes after photos are added
  it("doesn't trust the collection's photo count", async () => {
    const { app } = await setup({
      collection: (id) => Promise.resolve({ id, totalPhotos: 0 }),
    });
    const res = await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(res.status).toBe(200);
  });

  it("answers 404 for an empty collection", async () => {
    const { app } = await setup({
      random: () => Promise.reject(new UnsplashError("notFound", "No photos found.")),
    });
    const res = await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(res.status).toBe(404);
  });

  it("forgets the check once the collection is gone", async () => {
    const { app, clock, collection } = await setup({
      random: vi
        .fn<Unsplash["randomFromCollection"]>()
        .mockResolvedValueOnce(photos("u", 30))
        .mockRejectedValue(new UnsplashError("notFound", "No photos found.")),
    });
    await app.request("/v1/collections/c1", { headers: INSTALL });
    clock.advance(5 * MINUTE_MS);
    expect((await app.request("/v1/collections/c1", { headers: INSTALL })).status).toBe(404);

    clock.advance(60 * MINUTE_MS);
    await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(collection).toHaveBeenCalledTimes(2);
  });

  it("answers 503 budgetExhausted when the budget ran out, without holding the user back", async () => {
    const { app, random } = await setup({
      random: vi
        .fn()
        .mockRejectedValueOnce(new UnsplashError("rateLimited", "no budget"))
        .mockResolvedValue(photos("u", 30)),
    });
    const res = await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(res.status).toBe(503);
    expect((await body(res)).error).toBe("budgetExhausted");
    expect(res.headers.get("Retry-After")).toBe("300");
    // no cooldown: the failed request didn't count
    expect((await app.request("/v1/collections/c1", { headers: INSTALL })).status).toBe(200);
    expect(random).toHaveBeenCalledTimes(2);
  });
  it("gives parallel requests of one install for one collection the same deck", async () => {
    const { app, random } = await setup();
    const responses = await Promise.all(
      [1, 2, 3].map(() => app.request("/v1/collections/c1", { headers: INSTALL })),
    );
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    const decks = await Promise.all(responses.map(body));
    expect(decks[1]).toEqual(decks[0]);
    expect(decks[2]).toEqual(decks[0]);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it("serves the same deck again within the cooldown, a new one after it", async () => {
    const { app, clock, random } = await setup({
      random: vi
        .fn()
        .mockResolvedValueOnce(photos("a", 30))
        .mockResolvedValueOnce(photos("b", 30))
        .mockResolvedValue(photos("c", 30)),
    });
    const first = await body(await app.request("/v1/collections/c1", { headers: INSTALL }));
    await app.request("/v1/collections/c2", { headers: INSTALL });
    clock.advance(4 * MINUTE_MS);
    // back to c1 before the cooldown is over
    const again = await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual(first);
    expect(random).toHaveBeenCalledTimes(2);

    clock.advance(MINUTE_MS);
    const next = await body(await app.request("/v1/collections/c1", { headers: INSTALL }));
    expect(next.photos[0].id).toBe("c0");
  });

  it("doesn't give another install the same deck", async () => {
    const { app, random } = await setup();
    await app.request("/v1/collections/c1", { headers: INSTALL });
    await app.request("/v1/collections/c1", { headers: { "X-Install-Id": "another-install" } });
    expect(random).toHaveBeenCalledTimes(2);
  });

  it("doesn't hold the user back after Unsplash failed", async () => {
    const { app, random } = await setup({
      random: vi
        .fn()
        .mockRejectedValueOnce(new UnsplashError("upstream", "Unsplash responded 500"))
        .mockResolvedValue(photos("u", 30)),
    });
    expect((await app.request("/v1/collections/c1", { headers: INSTALL })).status).toBe(502);
    expect((await app.request("/v1/collections/c1", { headers: INSTALL })).status).toBe(200);
    expect(random.mock.calls.map((call) => call[2])).toEqual(["firstDeck", "firstDeck"]);
  });

  it("logs a deck refused for the budget", async () => {
    const { app, warnings } = await setup({
      random: () =>
        Promise.reject(
          new UnsplashError("rateLimited", "Budget is saved for higher priorities (firstDeck)"),
        ),
    });
    await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(warnings).toEqual([
      {
        message: "Deck refused for the Unsplash budget",
        fields: {
          collection: "c1",
          reason: "Budget is saved for higher priorities (firstDeck)",
          budget: { limit: 1000, remaining: 1000, updatedAt: null },
        },
      },
    ]);
  });

  it("answers 502 when Unsplash fails", async () => {
    const { app } = await setup({
      random: () => Promise.reject(new UnsplashError("upstream", "Unsplash responded 500")),
    });
    const res = await app.request("/v1/collections/c1", { headers: INSTALL });
    expect(res.status).toBe(502);
  });
});

describe("the rest", () => {
  it("answers CORS preflights for X-Install-Id", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/collections/c1", {
      method: "OPTIONS",
      headers: {
        Origin: "chrome-extension://abc",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Install-Id",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Install-Id");
  });

  it("limits requests per IP", async () => {
    const { app } = await setup();
    for (let i = 0; i < 120; i++) {
      await app.request("/v1/curated");
    }
    const res = await app.request("/v1/curated");
    expect(res.status).toBe(429);
    expect((await app.request("/v1/curated", { headers: { "X-Test-Ip": "8.8.8.8" } })).status).toBe(
      200,
    );
  });

  it("reports health", async () => {
    const { app } = await setup();
    const health = await body(await app.request("/health"));
    expect(health.curated.photos).toBe(50);
    expect(health.budget.remaining).toBe(1000);
  });

  it("answers JSON 404 for unknown paths", async () => {
    const { app } = await setup();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect((await body(res)).error).toBe("notFound");
  });
});
