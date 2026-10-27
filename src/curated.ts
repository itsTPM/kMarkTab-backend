import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Priority } from "./budget.ts";
import type { Log } from "./log.ts";
import { sample, type Photo } from "./photo.ts";
import type { Unsplash } from "./unsplash.ts";

// 3000 photos: far beyond what a hand-picked collection needs, and a bound on one sync's cost
const MAX_PAGES = 100;
// Retry delays after a failed sync while there are no photos at all; capped at the last one
const EMPTY_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
// After a failed scheduled sync: the old photos keep being served, nothing is urgent
const RETRY_MS = 30 * 60_000;

interface StoredCollection {
  collectionId: string;
  syncedAt: number;
  photos: Photo[];
}

// The author's collection. Unsplash has no "changed since" query, so a sync fetches every
// page (of 30) until Unsplash says there is no next one; for a few hundred photos that is a
// dozen requests every few hours. The photos are kept in memory and in a file, so a restart
// doesn't spend the budget again.
export class CuratedCollection {
  readonly collectionId: string;
  readonly #unsplash: Unsplash;
  readonly #file: string;
  readonly #intervalMs: number;
  readonly #log: Log;
  readonly #now: () => number;

  #photos: Photo[] = [];
  #syncedAt: number | null = null;
  #syncing: Promise<void> | null = null;
  #timer: NodeJS.Timeout | undefined;
  #failures = 0;

  constructor(options: {
    collectionId: string;
    unsplash: Unsplash;
    file: string;
    intervalMs: number;
    log: Log;
    now?: () => number;
  }) {
    this.collectionId = options.collectionId;
    this.#unsplash = options.unsplash;
    this.#file = options.file;
    this.#intervalMs = options.intervalMs;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
  }

  get size() {
    return this.#photos.length;
  }

  get syncedAt() {
    return this.#syncedAt;
  }

  sample(count: number): Photo[] {
    return sample(this.#photos, count);
  }

  async load() {
    let stored: StoredCollection;
    try {
      stored = JSON.parse(await readFile(this.#file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#log.warn("Couldn't read the stored curated collection", { error: String(err) });
      }
      return;
    }
    // the configured collection changed since the file was written
    if (stored.collectionId !== this.collectionId || !Array.isArray(stored.photos)) {
      return;
    }
    this.#photos = stored.photos;
    this.#syncedAt = stored.syncedAt;
    this.#log.info("Loaded the curated collection", {
      photos: this.size,
      syncedAt: this.#syncedAt,
    });
  }

  // Concurrent calls share one sync. A failed sync leaves the current photos in place.
  sync(): Promise<void> {
    this.#syncing ??= this.#fetchAll().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  // Syncs right away when the stored photos are missing or older than the interval, then
  // every interval.
  start() {
    const age = this.#syncedAt === null ? Infinity : this.#now() - this.#syncedAt;
    this.#schedule(Math.max(this.#intervalMs - age, 0));
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(delay: number) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#tick(), delay);
    this.#timer.unref();
  }

  async #tick() {
    try {
      await this.sync();
      this.#failures = 0;
      this.#schedule(this.#intervalMs);
    } catch (err) {
      this.#failures++;
      const delay =
        this.size === 0
          ? EMPTY_RETRY_MS[Math.min(this.#failures - 1, EMPTY_RETRY_MS.length - 1)]!
          : RETRY_MS;
      this.#log.error("Curated sync failed", { error: String(err), retryInMs: delay });
      this.#schedule(delay);
    }
  }

  async #fetchAll() {
    const priority: Priority = this.size === 0 ? "curatedEmpty" : "curatedSync";
    const byId = new Map<string, Photo>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { photos, next } = await this.#unsplash.collectionPage(
        this.collectionId,
        page,
        priority,
      );
      // a photo added during the sync shifts the pages, so one may come twice
      for (const photo of photos) {
        byId.set(photo.id, photo);
      }
      if (!next) {
        break;
      }
    }
    if (byId.size === 0) {
      throw new Error("The curated collection has no photos");
    }

    const stored: StoredCollection = {
      collectionId: this.collectionId,
      syncedAt: this.#now(),
      photos: [...byId.values()],
    };
    await this.#save(stored);
    this.#photos = stored.photos;
    this.#syncedAt = stored.syncedAt;
    this.#log.info("Synced the curated collection", { photos: this.size });
  }

  // Written next to the file and renamed over it, so a crash never leaves half a file
  async #save(stored: StoredCollection) {
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, JSON.stringify(stored));
    await rename(tmp, this.#file);
  }
}
