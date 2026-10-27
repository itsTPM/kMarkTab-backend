import type { Photo, UnsplashPhoto } from "../src/photo.ts";
import type { Unsplash } from "../src/unsplash.ts";

export function rawPhoto(id: string): UnsplashPhoto {
  return {
    id,
    width: 6000,
    height: 4000,
    color: "#a0b0c0",
    blur_hash: "LKO2?U%2Tw=w",
    alt_description: `photo ${id}`,
    urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=x` },
    links: { html: `https://unsplash.com/photos/${id}` },
    user: { name: `Author ${id}`, links: { html: `https://unsplash.com/@author${id}` } },
  };
}

export function photo(id: string): Photo {
  return {
    id,
    url: `https://images.unsplash.com/photo-${id}?ixid=x`,
    width: 6000,
    height: 4000,
    color: "#a0b0c0",
    blurHash: null,
    alt: null,
    link: `https://unsplash.com/photos/${id}`,
    author: { name: `Author ${id}`, link: `https://unsplash.com/@author${id}` },
  };
}

export function photos(prefix: string, count: number): Photo[] {
  return Array.from({ length: count }, (_, i) => photo(`${prefix}${i}`));
}

// An Unsplash whose methods each test replaces as needed
export function fakeUnsplash(overrides: Partial<Unsplash> = {}): Unsplash {
  return {
    collection: () => Promise.reject(new Error("collection not expected")),
    collectionPage: () => Promise.reject(new Error("collectionPage not expected")),
    randomFromCollection: () => Promise.reject(new Error("randomFromCollection not expected")),
    ...overrides,
  };
}

export class Clock {
  time = Date.UTC(2026, 9, 18, 12);
  now = () => this.time;
  advance(ms: number) {
    this.time += ms;
  }
}
