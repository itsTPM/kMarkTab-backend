import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CuratedCollection } from "../src/curated.ts";
import { silentLog } from "../src/log.ts";
import type { Photo } from "../src/photo.ts";
import { UnsplashError, type Unsplash } from "../src/unsplash.ts";
import { Clock, fakeUnsplash, photos } from "./helpers.ts";

const HOUR_MS = 60 * 60_000;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "curated-"));
  file = join(dir, "data", "curated.json");
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function create(unsplash: Unsplash, now = new Clock().now, collectionId = "curated") {
  return new CuratedCollection({
    collectionId,
    unsplash,
    file,
    intervalMs: 6 * HOUR_MS,
    log: silentLog,
    now,
  });
}

// Pages of 30 out of `all`
function pagesOf(all: Photo[]) {
  return vi.fn((_id: string, page: number, _priority: string) =>
    Promise.resolve({
      photos: all.slice((page - 1) * 30, page * 30),
      next: page * 30 < all.length,
    }),
  );
}

describe("CuratedCollection", () => {
  it("fetches pages while Unsplash says there is a next one", async () => {
    const collectionPage = pagesOf(photos("p", 75));
    const curated = create(fakeUnsplash({ collectionPage }));
    await curated.sync();

    expect(collectionPage).toHaveBeenCalledTimes(3);
    expect(collectionPage.mock.calls.map(([id, page]) => [id, page])).toEqual([
      ["curated", 1],
      ["curated", 2],
      ["curated", 3],
    ]);
    expect(curated.size).toBe(75);
  });

  it("doesn't stop at a short page while there is a next one", async () => {
    const collectionPage = vi
      .fn()
      .mockResolvedValueOnce({ photos: photos("a", 10), next: true })
      .mockResolvedValueOnce({ photos: photos("b", 10), next: false });
    const curated = create(fakeUnsplash({ collectionPage }));
    await curated.sync();
    expect(collectionPage).toHaveBeenCalledTimes(2);
    expect(curated.size).toBe(20);
  });

  it("asks with the empty-collection priority only while it has no photos", async () => {
    const collectionPage = pagesOf(photos("p", 10));
    const curated = create(fakeUnsplash({ collectionPage }));
    await curated.sync();
    await curated.sync();
    expect(collectionPage.mock.calls.map((call) => call[2])).toEqual([
      "curatedEmpty",
      "curatedSync",
    ]);
  });

  it("drops a photo that came twice because the pages shifted", async () => {
    const page1 = photos("p", 30);
    const collectionPage = vi
      .fn()
      .mockResolvedValueOnce({ photos: page1, next: true })
      .mockResolvedValueOnce({ photos: [page1[29]!, ...photos("q", 5)], next: false });
    const curated = create(fakeUnsplash({ collectionPage }));
    await curated.sync();
    expect(curated.size).toBe(35);
  });

  it("keeps the current photos when a sync fails halfway", async () => {
    const curated = create(fakeUnsplash({ collectionPage: pagesOf(photos("old", 40)) }));
    await curated.sync();

    const failing = create(
      fakeUnsplash({
        collectionPage: vi
          .fn()
          .mockResolvedValueOnce({ photos: photos("new", 30), next: true })
          .mockRejectedValueOnce(new UnsplashError("upstream", "boom")),
      }),
    );
    await failing.load();
    await expect(failing.sync()).rejects.toThrow("boom");
    expect(failing.size).toBe(40);
    expect(failing.sample(100).every((p) => p.id.startsWith("old"))).toBe(true);
  });

  it("refuses to replace the photos with an empty collection", async () => {
    const curated = create(
      fakeUnsplash({ collectionPage: () => Promise.resolve({ photos: [], next: false }) }),
    );
    await expect(curated.sync()).rejects.toThrow("no photos");
  });

  it("shares one sync between concurrent calls", async () => {
    const collectionPage = pagesOf(photos("p", 10));
    const curated = create(fakeUnsplash({ collectionPage }));
    await Promise.all([curated.sync(), curated.sync()]);
    expect(collectionPage).toHaveBeenCalledTimes(1);
  });

  it("stores the photos for the next start", async () => {
    const clock = new Clock();
    await create(fakeUnsplash({ collectionPage: pagesOf(photos("p", 12)) }), clock.now).sync();

    const restarted = create(fakeUnsplash(), clock.now);
    await restarted.load();
    expect(restarted.size).toBe(12);
    expect(restarted.syncedAt).toBe(clock.time);
    await expect(readFile(`${file}.tmp`)).rejects.toThrow();
  });

  it("ignores a stored file of another collection or a broken one", async () => {
    await create(fakeUnsplash({ collectionPage: pagesOf(photos("p", 12)) })).sync();
    const other = create(fakeUnsplash(), new Clock().now, "other");
    await other.load();
    expect(other.size).toBe(0);

    await writeFile(file, "{not json");
    const broken = create(fakeUnsplash());
    await broken.load();
    expect(broken.size).toBe(0);
  });

  it("samples without repeats", async () => {
    const curated = create(fakeUnsplash({ collectionPage: pagesOf(photos("p", 50)) }));
    await curated.sync();
    const ids = curated.sample(30).map((p) => p.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(curated.sample(100)).toHaveLength(50);
  });

  describe("schedule", () => {
    it("syncs right away without photos, retries failures, then syncs every interval", async () => {
      vi.useFakeTimers();
      const collectionPage = vi
        .fn()
        .mockRejectedValueOnce(new UnsplashError("upstream", "down"))
        .mockResolvedValue({ photos: photos("p", 5), next: false });
      const curated = create(fakeUnsplash({ collectionPage }), () => Date.now());
      curated.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(collectionPage).toHaveBeenCalledTimes(1);
      expect(curated.size).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(collectionPage).toHaveBeenCalledTimes(2);
      // the file is written with real I/O; the next sync is scheduled once it is done
      await vi.waitFor(() => expect(curated.size).toBe(5));

      await vi.advanceTimersByTimeAsync(6 * HOUR_MS - 60_000);
      expect(collectionPage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(collectionPage).toHaveBeenCalledTimes(3);
      curated.stop();
    });

    it("waits out the rest of the interval after a restart", async () => {
      vi.useFakeTimers();
      await create(fakeUnsplash({ collectionPage: pagesOf(photos("p", 5)) }), () =>
        Date.now(),
      ).sync();

      vi.advanceTimersByTime(2 * HOUR_MS);
      const collectionPage = pagesOf(photos("p", 5));
      const restarted = create(fakeUnsplash({ collectionPage }), () => Date.now());
      await restarted.load();
      restarted.start();

      await vi.advanceTimersByTimeAsync(4 * HOUR_MS - 1);
      expect(collectionPage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(collectionPage).toHaveBeenCalledTimes(1);
      restarted.stop();
    });
  });
});
