import type { CuratedCollection } from "./curated.ts";
import { DECK_COOLDOWN_MS, type ClientLimits, type DeckVerdict } from "./limits.ts";
import type { Photo } from "./photo.ts";
import { UnsplashError, type Unsplash } from "./unsplash.ts";

// Photos in one response. The extension rotates through them on its own and asks for the
// next deck when it runs low.
export const DECK_SIZE = 30;

// A collection Unsplash didn't find, or an empty one, is not asked about again for this long
const NOT_FOUND_TTL_MS = 60 * 60_000;
// How long a collection checked to be public and not empty is trusted. /photos/random doesn't
// check it itself, so a collection deleted or made private in the meantime gets random
// photos (or still its own) until then.
const CHECKED_TTL_MS = 6 * 60 * 60_000;
// What the extension is told to wait when the budget ran out
const BUDGET_RETRY_MS = 5 * 60_000;

export type DeckResult =
  | { kind: "ok"; photos: Photo[] }
  | { kind: "notFound" }
  // the client asked too often
  | { kind: "tooMany"; retryAfterMs: number }
  // no curated photos yet: the first sync hasn't succeeded
  | { kind: "noCurated"; retryAfterMs: number }
  // our budget estimate or Unsplash's rate limit turned the request away, and why
  | { kind: "budget"; retryAfterMs: number; reason: string }
  | { kind: "upstream"; message: string };

export class Decks {
  readonly #curated: CuratedCollection;
  readonly #unsplash: Unsplash;
  readonly #limits: ClientLimits;
  readonly #now: () => number;
  // collection id → until when
  readonly #notFound = new Map<string, number>();
  readonly #checked = new Map<string, number>();
  // install id + collection id → its last deck, served again until a new one may be fetched
  readonly #decks = new Map<string, { until: number; deck: Promise<DeckResult> }>();

  constructor(options: {
    curated: CuratedCollection;
    unsplash: Unsplash;
    limits: ClientLimits;
    now?: () => number;
  }) {
    this.#curated = options.curated;
    this.#unsplash = options.unsplash;
    this.#limits = options.limits;
    this.#now = options.now ?? Date.now;
  }

  curated(): DeckResult {
    if (this.#curated.size === 0) {
      return { kind: "noCurated", retryAfterMs: 60_000 };
    }
    return { kind: "ok", photos: this.#curated.sample(DECK_SIZE) };
  }

  // A random deck of the user's collection, straight from Unsplash, so a photo added to the
  // collection can come in the next deck. Asked again within the cooldown (parallel tabs, a
  // collection switched back to), the install gets the same deck rather than a refusal. The
  // first deck of a collection costs one more request, to check that it is a public
  // collection with photos.
  async collection(id: string, installId: string, ip: string): Promise<DeckResult> {
    // the curated collection entered by hand is served from what we have
    if (id === this.#curated.collectionId && this.#curated.size > 0) {
      return this.curated();
    }
    const notFoundUntil = this.#notFound.get(id);
    if (notFoundUntil !== undefined) {
      if (notFoundUntil > this.#now()) {
        return { kind: "notFound" };
      }
      this.#notFound.delete(id);
    }

    // neither id has spaces
    const key = `${installId} ${id}`;
    const last = this.#decks.get(key);
    if (last && last.until > this.#now()) {
      return last.deck;
    }

    const verdict = this.#limits.reserveDeck(installId, ip, id);
    if (!verdict.ok) {
      return { kind: "tooMany", retryAfterMs: verdict.retryAfterMs };
    }

    // Kept before Unsplash answers (no await so far), so parallel requests wait for this one. Only a deck is
    // served again: after a failure the install may ask again right away.
    const deck = this.#fetch(id, verdict);
    const entry = { until: this.#now() + DECK_COOLDOWN_MS, deck };
    this.#decks.set(key, entry);
    const forget = () => {
      if (this.#decks.get(key) === entry) {
        this.#decks.delete(key);
      }
    };
    deck.then((result) => result.kind !== "ok" && forget(), forget);
    return deck;
  }

  async #fetch(id: string, verdict: Extract<DeckVerdict, { ok: true }>): Promise<DeckResult> {
    try {
      const priority = verdict.first ? "firstDeck" : "deck";
      if (!this.#isChecked(id)) {
        // only that it exists and is public: its total_photos lags behind photos just added,
        // and an empty one is told by /photos/random
        await this.#unsplash.collection(id, priority);
        this.#checked.set(id, this.#now() + CHECKED_TTL_MS);
      }
      const photos = await this.#unsplash.randomFromCollection(id, DECK_SIZE, priority);
      return { kind: "ok", photos };
    } catch (err) {
      // a collection that isn't there counts as a deck: asking again won't change the answer
      if (err instanceof UnsplashError && err.kind === "notFound") {
        this.#checked.delete(id);
        this.#notFound.set(id, this.#now() + NOT_FOUND_TTL_MS);
        return { kind: "notFound" };
      }
      verdict.release();
      if (!(err instanceof UnsplashError)) {
        throw err;
      }
      if (err.kind === "rateLimited") {
        return { kind: "budget", retryAfterMs: BUDGET_RETRY_MS, reason: err.message };
      }
      return { kind: "upstream", message: err.message };
    }
  }

  #isChecked(id: string): boolean {
    const until = this.#checked.get(id);
    return until !== undefined && until > this.#now();
  }

  sweep() {
    const now = this.#now();
    for (const map of [this.#notFound, this.#checked]) {
      for (const [id, until] of map) {
        if (until <= now) {
          map.delete(id);
        }
      }
    }
    for (const [key, { until }] of this.#decks) {
      if (until <= now) {
        this.#decks.delete(key);
      }
    }
  }
}
