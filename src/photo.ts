// What the extension gets for each photo: enough to show it and credit its author.
export interface Photo {
  id: string;
  // urls.raw: the extension adds its own imgix parameters (w, q, fit…)
  url: string;
  width: number;
  height: number;
  color: string | null;
  blurHash: string | null;
  alt: string | null;
  // the photo's page on Unsplash
  link: string;
  author: { name: string; link: string };
}

// The fields we read from Unsplash's photo object. Collection pages return the short
// form of it, /photos/random the full one; both have these.
export interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  color?: string | null;
  blur_hash?: string | null;
  alt_description?: string | null;
  description?: string | null;
  urls: { raw: string };
  links: { html: string };
  user: { name: string; links: { html: string } };
}

export function toPhoto(raw: UnsplashPhoto): Photo {
  return {
    id: raw.id,
    url: raw.urls.raw,
    width: raw.width,
    height: raw.height,
    color: raw.color ?? null,
    blurHash: raw.blur_hash ?? null,
    alt: raw.alt_description ?? raw.description ?? null,
    link: raw.links.html,
    author: { name: raw.user.name, link: raw.user.links.html },
  };
}

// Unsplash ids: numeric for old collections, 11 characters of [A-Za-z0-9_-] for new ones.
// Anything else never reaches Unsplash.
const COLLECTION_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function isCollectionId(value: string): boolean {
  return COLLECTION_ID.test(value);
}

// A random sample without repeats (partial Fisher–Yates)
export function sample<T>(items: readonly T[], count: number, random = Math.random): T[] {
  const pool = items.slice();
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}
