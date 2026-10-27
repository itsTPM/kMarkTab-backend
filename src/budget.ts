// The Unsplash key's hourly request budget, shared by every kind of request. Each kind has
// a watermark, a share of the hourly limit: it may spend only while more than that remains,
// so background work stops first and the curated collection can always be fetched when there
// is none. Shares rather than counts, so a demo key (50 an hour) works the same way as a
// production one (1000).
export type Priority = "curatedEmpty" | "firstDeck" | "deck" | "curatedSync";

const WATERMARKS: Record<Priority, number> = {
  // the server has no curated photos at all
  curatedEmpty: 0,
  // the user just chose a collection and is waiting for it
  firstDeck: 0.05,
  // a regular deck of the user's collection
  deck: 0.15,
  // the scheduled curated sync: it can wait for the next hour
  curatedSync: 0.3,
};

// Unsplash doesn't say when its window resets. Once the estimate stops a request, one
// request every PROBE_MS still goes through, and its response headers bring the real count.
const PROBE_MS = 5 * 60 * 1000;

export class Budget {
  readonly #now: () => number;
  #limit: number;
  #remaining: number;
  #updatedAt = 0;

  // The limit is assumed until Unsplash's first response tells the real one
  constructor(limit = 1000, now = Date.now) {
    this.#limit = limit;
    this.#remaining = limit;
    this.#now = now;
  }

  canSpend(priority: Priority): boolean {
    return (
      this.#remaining > WATERMARKS[priority] * this.#limit ||
      this.#now() - this.#updatedAt >= PROBE_MS
    );
  }

  // Counted before the request is sent, so a burst of parallel requests sees each other.
  spend() {
    this.#remaining = Math.max(this.#remaining - 1, 0);
    this.#updatedAt = this.#now();
  }

  // From X-Ratelimit-Remaining / X-Ratelimit-Limit
  update(remaining: number, limit?: number) {
    this.#remaining = remaining;
    if (limit !== undefined) {
      this.#limit = limit;
    }
    this.#updatedAt = this.#now();
  }

  exhaust() {
    this.update(0);
  }

  snapshot() {
    return { limit: this.#limit, remaining: this.#remaining, updatedAt: this.#updatedAt || null };
  }
}
