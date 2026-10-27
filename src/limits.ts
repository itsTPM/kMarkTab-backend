const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Every endpoint, per IP. Serving the curated collection costs nothing, this only keeps a
// misbehaving client from hogging the process.
const REQUESTS_PER_MINUTE = 120;

// Decks of a user's collection, each one a request to Unsplash. A deck is 30 photos: even with
// a new photo on every tab the extension asks for a few a day.
export const DECK_COOLDOWN_MS = 5 * MINUTE_MS; // per install and collection
const DECKS_PER_DAY = 48; // per install
const NEW_COLLECTIONS_PER_DAY = 10; // per install
// Install ids are made up by the client, so the IP is what bounds a client that makes up many
const DECKS_PER_IP_PER_HOUR = 60;

export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };
export type DeckVerdict =
  // release() takes the deck back, for a request Unsplash didn't answer with photos
  { ok: true; first: boolean; release: () => void } | { ok: false; retryAfterMs: number };

interface Install {
  // when each deck of the last day was fetched
  decks: number[];
  // collection id → when its last deck was fetched, for the collections of the last day
  collections: Map<string, number>;
}

// Kept in memory: a restart forgets them, which costs at most one round of requests.
export class ClientLimits {
  readonly #now: () => number;
  readonly #requests = new Map<string, { start: number; count: number }>();
  readonly #installs = new Map<string, Install>();
  readonly #ipDecks = new Map<string, number[]>();

  constructor(now = Date.now) {
    this.#now = now;
  }

  // Counts the request
  request(ip: string): Verdict {
    const now = this.#now();
    let window = this.#requests.get(ip);
    if (!window || now - window.start >= MINUTE_MS) {
      window = { start: now, count: 0 };
      this.#requests.set(ip, window);
    }
    if (window.count >= REQUESTS_PER_MINUTE) {
      return { ok: false, retryAfterMs: window.start + MINUTE_MS - now };
    }
    window.count++;
    return { ok: true };
  }

  // Counts the deck right away, so parallel requests see each other while Unsplash is asked.
  // A request the budget or Unsplash turned away is released, so it doesn't hold the user back.
  reserveDeck(installId: string, ip: string, collectionId: string): DeckVerdict {
    const now = this.#now();
    const retry: number[] = [];

    const ipDecks = recent(this.#ipDecks.get(ip), now - HOUR_MS);
    if (ipDecks.length >= DECKS_PER_IP_PER_HOUR) {
      retry.push(ipDecks[0]! + HOUR_MS - now);
    }

    const install = this.#install(installId, now);
    const last = install.collections.get(collectionId);
    const first = last === undefined;
    if (first && install.collections.size >= NEW_COLLECTIONS_PER_DAY) {
      retry.push(Math.min(...install.collections.values()) + DAY_MS - now);
    }
    if (!first && now - last < DECK_COOLDOWN_MS) {
      retry.push(last + DECK_COOLDOWN_MS - now);
    }
    if (install.decks.length >= DECKS_PER_DAY) {
      retry.push(install.decks[0]! + DAY_MS - now);
    }
    if (retry.length) {
      return { ok: false, retryAfterMs: Math.max(...retry) };
    }

    install.decks.push(now);
    install.collections.set(collectionId, now);
    ipDecks.push(now);
    this.#ipDecks.set(ip, ipDecks);

    const release = () => {
      // looked up again: #install() and sweep() replace the arrays
      const install = this.#installs.get(installId);
      if (install) {
        removeOne(install.decks, now);
        if (install.collections.get(collectionId) === now) {
          if (first) {
            install.collections.delete(collectionId);
          } else {
            install.collections.set(collectionId, last);
          }
        }
      }
      const ipDecks = this.#ipDecks.get(ip);
      if (ipDecks) {
        removeOne(ipDecks, now);
      }
    };
    return { ok: true, first, release };
  }

  // Drops whatever no longer limits anything; called periodically
  sweep() {
    const now = this.#now();
    for (const [ip, window] of this.#requests) {
      if (now - window.start >= MINUTE_MS) {
        this.#requests.delete(ip);
      }
    }
    for (const [id] of this.#installs) {
      const install = this.#install(id, now);
      if (install.decks.length === 0 && install.collections.size === 0) {
        this.#installs.delete(id);
      }
    }
    for (const [ip, decks] of this.#ipDecks) {
      const left = recent(decks, now - HOUR_MS);
      if (left.length === 0) {
        this.#ipDecks.delete(ip);
      } else {
        this.#ipDecks.set(ip, left);
      }
    }
  }

  // The install's state with entries older than a day dropped
  #install(id: string, now: number): Install {
    let install = this.#installs.get(id);
    if (!install) {
      install = { decks: [], collections: new Map() };
      this.#installs.set(id, install);
    }
    install.decks = recent(install.decks, now - DAY_MS);
    for (const [collectionId, at] of install.collections) {
      if (at <= now - DAY_MS) {
        install.collections.delete(collectionId);
      }
    }
    return install;
  }
}

// The timestamps after `since`, oldest first
function recent(times: number[] | undefined, since: number): number[] {
  return times ? times.filter((t) => t > since) : [];
}

function removeOne(times: number[], time: number) {
  const i = times.indexOf(time);
  if (i !== -1) {
    times.splice(i, 1);
  }
}
