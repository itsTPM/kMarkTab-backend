import { describe, expect, it, vi } from "vitest";

import { Budget } from "../src/budget.ts";
import { createUnsplash, UnsplashError } from "../src/unsplash.ts";
import { rawPhoto } from "./helpers.ts";

function setup(response: () => Response) {
  const budget = new Budget(1000);
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(response()),
  );
  const unsplash = createUnsplash({ accessKey: "key", budget, fetch });
  return { budget, fetch, unsplash };
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function kindOf(promise: Promise<unknown>) {
  return promise.then(
    () => "resolved",
    (err) => (err instanceof UnsplashError ? err.kind : String(err)),
  );
}

describe("createUnsplash", () => {
  it("requests a random deck of the collection with the key", async () => {
    const { fetch, unsplash } = setup(() => json([rawPhoto("a"), rawPhoto("b")]));
    const photos = await unsplash.randomFromCollection("abc_DEF-123", 30, "deck");

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.unsplash.com/photos/random?collections=abc_DEF-123&count=30",
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe("Client-ID key");
    expect(photos.map((p) => p.id)).toEqual(["a", "b"]);
    expect(photos[0]).toEqual({
      id: "a",
      url: "https://images.unsplash.com/photo-a?ixid=x",
      width: 6000,
      height: 4000,
      color: "#a0b0c0",
      blurHash: "LKO2?U%2Tw=w",
      alt: "photo a",
      link: "https://unsplash.com/photos/a",
      author: { name: "Author a", link: "https://unsplash.com/@authora" },
    });
  });

  it("requests the collection's metadata", async () => {
    const { fetch, unsplash } = setup(() =>
      json({ id: "k5t16wLIhwQ", title: "test", private: false, total_photos: 0 }),
    );
    expect(await unsplash.collection("k5t16wLIhwQ", "firstDeck")).toEqual({
      id: "k5t16wLIhwQ",
      totalPhotos: 0,
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://api.unsplash.com/collections/k5t16wLIhwQ",
    );
  });

  it("reports a private collection as missing", async () => {
    // what Unsplash answers for both
    const { unsplash } = setup(() =>
      json({ errors: ["Couldn't find Collection"] }, { status: 404 }),
    );
    expect(await kindOf(unsplash.collection("0JYw6dTpkfw", "firstDeck"))).toBe("notFound");
  });

  it("requests a page of the collection", async () => {
    const { fetch, unsplash } = setup(() => json([rawPhoto("a")]));
    await unsplash.collectionPage("123", 3, "curatedSync");
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://api.unsplash.com/collections/123/photos?per_page=30&page=3",
    );
  });

  it("tells from the Link header whether there is a next page", async () => {
    const link = (rels: string) => ({ headers: { Link: rels } });
    const page = (init: ResponseInit, photos = [rawPhoto("a")]) =>
      setup(() => json(photos, init)).unsplash.collectionPage("1", 1, "curatedSync");

    // the headers Unsplash sent for the first and the last page of a 152-photo collection
    const first = await page(
      link(
        '<https://api.unsplash.com/collections/1/photos?page=6&per_page=30>; rel="last", ' +
          '<https://api.unsplash.com/collections/1/photos?page=2&per_page=30>; rel="next"',
      ),
    );
    expect(first.next).toBe(true);
    const last = await page(
      link(
        '<https://api.unsplash.com/collections/1/photos?page=1&per_page=30>; rel="first", ' +
          '<https://api.unsplash.com/collections/1/photos?page=5&per_page=30>; rel="prev"',
      ),
    );
    expect(last.next).toBe(false);

    // no header: go on until an empty page
    expect((await page({})).next).toBe(true);
    expect((await page({}, [])).next).toBe(false);
  });

  it("takes the remaining budget from the response headers", async () => {
    const { budget, unsplash } = setup(() =>
      json([rawPhoto("a")], {
        headers: { "X-Ratelimit-Remaining": "420", "X-Ratelimit-Limit": "1000" },
      }),
    );
    await unsplash.randomFromCollection("1", 30, "deck");
    expect(budget.snapshot()).toMatchObject({ limit: 1000, remaining: 420 });
  });

  it("doesn't send a request the budget can't afford", async () => {
    const { budget, fetch, unsplash } = setup(() => json([]));
    budget.update(100);
    expect(await kindOf(unsplash.randomFromCollection("1", 30, "deck"))).toBe("rateLimited");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing collection", async () => {
    const { unsplash } = setup(() =>
      json({ errors: ["Couldn't find Collection"] }, { status: 404 }),
    );
    expect(await kindOf(unsplash.randomFromCollection("1", 30, "deck"))).toBe("notFound");
  });

  it("treats an empty random deck as a missing collection", async () => {
    const { unsplash } = setup(() => json([]));
    expect(await kindOf(unsplash.randomFromCollection("1", 30, "deck"))).toBe("notFound");
  });

  it("recognizes Unsplash's rate limit and stops spending", async () => {
    const { budget, unsplash } = setup(() => new Response("Rate Limit Exceeded", { status: 403 }));
    expect(await kindOf(unsplash.randomFromCollection("1", 30, "deck"))).toBe("rateLimited");
    expect(budget.snapshot().remaining).toBe(0);
  });

  it("tells other 403s from the rate limit", async () => {
    const { budget, unsplash } = setup(
      () =>
        new Response("OAuth error: The access token is invalid", {
          status: 403,
          headers: { "X-Ratelimit-Remaining": "999" },
        }),
    );
    expect(await kindOf(unsplash.randomFromCollection("1", 30, "deck"))).toBe("upstream");
    expect(budget.snapshot().remaining).toBe(999);
  });

  it("reports server errors, network errors and unexpected bodies as upstream", async () => {
    expect(
      await kindOf(setup(() => json({}, { status: 500 })).unsplash.collectionPage("1", 1, "deck")),
    ).toBe("upstream");
    expect(
      await kindOf(setup(() => json({ id: "x" })).unsplash.collectionPage("1", 1, "deck")),
    ).toBe("upstream");
    expect(
      await kindOf(setup(() => json([{ id: "x" }])).unsplash.collectionPage("1", 1, "deck")),
    ).toBe("upstream");

    const budget = new Budget();
    const failing = createUnsplash({
      accessKey: "key",
      budget,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await kindOf(failing.collectionPage("1", 1, "deck"))).toBe("upstream");
  });
});
