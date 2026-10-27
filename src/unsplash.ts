import type { Budget, Priority } from "./budget.ts";
import { toPhoto, type Photo, type UnsplashPhoto } from "./photo.ts";

const API = "https://api.unsplash.com";
// The most Unsplash returns per page; a larger per_page silently gets its default of 10
const PAGE_SIZE = 30;
const TIMEOUT_MS = 10_000;

export type UnsplashErrorKind =
  // no such collection, a private one, or one without photos
  | "notFound"
  // our budget estimate or Unsplash itself refused the request
  | "rateLimited"
  // a network error, a timeout or an unexpected response
  | "upstream";

export class UnsplashError extends Error {
  readonly kind: UnsplashErrorKind;

  constructor(kind: UnsplashErrorKind, message: string) {
    super(message);
    this.name = "UnsplashError";
    this.kind = kind;
  }
}

export interface Collection {
  id: string;
  totalPhotos: number;
}

export interface Page {
  photos: Photo[];
  // whether there are more pages after this one
  next: boolean;
}

export interface Unsplash {
  // Public collections only: a private one is "notFound" like a missing one
  collection(id: string, priority: Priority): Promise<Collection>;
  collectionPage(id: string, page: number, priority: Priority): Promise<Page>;
  randomFromCollection(id: string, count: number, priority: Priority): Promise<Photo[]>;
}

export function createUnsplash(options: {
  accessKey: string;
  budget: Budget;
  fetch?: typeof globalThis.fetch;
}): Unsplash {
  const { accessKey, budget, fetch = globalThis.fetch } = options;

  async function request(
    path: string,
    priority: Priority,
  ): Promise<{ data: unknown; res: Response }> {
    if (!budget.canSpend(priority)) {
      throw new UnsplashError("rateLimited", `Budget is saved for higher priorities (${priority})`);
    }
    budget.spend();

    let res: Response;
    try {
      res = await fetch(API + path, {
        headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // fetch's own message is just "fetch failed"; the reason (ENOTFOUND, ECONNRESET…) is the cause
      const cause =
        err instanceof Error && err.cause !== undefined ? ` (${String(err.cause)})` : "";
      throw new UnsplashError("upstream", `Request failed: ${String(err)}${cause}`);
    }

    const remaining = headerNumber(res, "X-Ratelimit-Remaining");
    if (remaining !== undefined) {
      budget.update(remaining, headerNumber(res, "X-Ratelimit-Limit"));
    }

    if (res.status === 404) {
      throw new UnsplashError("notFound", "Not found");
    }
    if (res.status === 403 || res.status === 429) {
      const text = await res.text().catch(() => "");
      // a 403 is also what an invalid key gets; only the rate limit one is "rateLimited"
      if (res.status === 429 || remaining === 0 || /rate limit/i.test(text)) {
        budget.exhaust();
        throw new UnsplashError("rateLimited", "Unsplash rate limit exceeded");
      }
      throw new UnsplashError(
        "upstream",
        `Unsplash responded ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      throw new UnsplashError("upstream", `Unsplash responded ${res.status}`);
    }
    try {
      return { data: await res.json(), res };
    } catch {
      throw new UnsplashError("upstream", "Unsplash responded with invalid JSON");
    }
  }

  function photos(data: unknown): Photo[] {
    if (!Array.isArray(data)) {
      throw new UnsplashError("upstream", "Unsplash responded with an unexpected shape");
    }
    try {
      return (data as UnsplashPhoto[]).map(toPhoto);
    } catch {
      throw new UnsplashError("upstream", "Unsplash responded with an unexpected shape");
    }
  }

  return {
    async collection(id, priority) {
      const { data: raw } = await request(`/collections/${encodeURIComponent(id)}`, priority);
      const data = raw as {
        id?: unknown;
        total_photos?: unknown;
      } | null;
      if (typeof data?.id !== "string" || typeof data.total_photos !== "number") {
        throw new UnsplashError("upstream", "Unsplash responded with an unexpected shape");
      }
      return { id: data.id, totalPhotos: data.total_photos };
    },

    async collectionPage(id, page, priority) {
      const path = `/collections/${encodeURIComponent(id)}/photos?per_page=${PAGE_SIZE}&page=${page}`;
      const { data, res } = await request(path, priority);
      const result = photos(data);
      // Link: <…page=2…>; rel="next", <…page=6…>; rel="last". Without the header, which
      // shouldn't happen, the pages are fetched until an empty one.
      const link = res.headers.get("Link");
      return { photos: result, next: link === null ? result.length > 0 : /rel="next"/.test(link) };
    },

    // Unsplash doesn't check the collection here: for a missing id it returns photos from all
    // of Unsplash, for a private one that collection's photos. Check with collection() first.
    async randomFromCollection(id, count, priority) {
      const path = `/photos/random?collections=${encodeURIComponent(id)}&count=${count}`;
      const result = photos((await request(path, priority)).data);
      // Unsplash answers 404 for an empty collection; an empty array would mean the same
      if (result.length === 0) {
        throw new UnsplashError("notFound", "The collection has no photos");
      }
      return result;
    },
  };
}

function headerNumber(res: Response, name: string): number | undefined {
  const value = res.headers.get(name);
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
