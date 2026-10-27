import { describe, expect, it } from "vitest";

import { ClientLimits } from "../src/limits.ts";
import { Clock } from "./helpers.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function setup() {
  const clock = new Clock();
  return { clock, limits: new ClientLimits(clock.now) };
}

// The verdict without the release function, to compare with toEqual
function take(limits: ClientLimits, install: string, ip: string, collection: string) {
  const verdict = limits.reserveDeck(install, ip, collection);
  return verdict.ok ? { ok: true, first: verdict.first } : verdict;
}

describe("ClientLimits", () => {
  it("limits requests per IP per minute", () => {
    const { clock, limits } = setup();
    for (let i = 0; i < 120; i++) {
      expect(limits.request("1.1.1.1").ok).toBe(true);
    }
    expect(limits.request("1.1.1.1")).toEqual({ ok: false, retryAfterMs: MINUTE_MS });
    expect(limits.request("2.2.2.2").ok).toBe(true);
    clock.advance(MINUTE_MS);
    expect(limits.request("1.1.1.1").ok).toBe(true);
  });

  it("marks the first deck of a collection and holds the next one for 5 minutes", () => {
    const { clock, limits } = setup();
    expect(take(limits, "install", "ip", "c1")).toEqual({ ok: true, first: true });
    clock.advance(MINUTE_MS);
    expect(take(limits, "install", "ip", "c1")).toEqual({ ok: false, retryAfterMs: 4 * MINUTE_MS });
    // another collection is not held back
    expect(take(limits, "install", "ip", "c2")).toEqual({ ok: true, first: true });
    clock.advance(4 * MINUTE_MS);
    expect(take(limits, "install", "ip", "c1")).toEqual({ ok: true, first: false });
  });

  it("counts a deck as soon as it is reserved", () => {
    const { limits } = setup();
    expect(take(limits, "install", "ip", "c1")).toEqual({ ok: true, first: true });
    expect(take(limits, "install", "ip", "c1").ok).toBe(false);
  });

  it("doesn't count a released deck", () => {
    const { limits } = setup();
    const verdict = limits.reserveDeck("install", "ip", "c1");
    if (verdict.ok) {
      verdict.release();
    }
    expect(take(limits, "install", "ip", "c1")).toEqual({ ok: true, first: true });
  });

  it("gives the collection its previous deck back on release", () => {
    const { clock, limits } = setup();
    take(limits, "install", "ip", "c1");
    clock.advance(5 * MINUTE_MS);
    const verdict = limits.reserveDeck("install", "ip", "c1");
    if (verdict.ok) {
      verdict.release();
    }
    // still not the first deck, and no cooldown from the released one
    expect(take(limits, "install", "ip", "c1")).toEqual({ ok: true, first: false });
  });

  it("releases the deck from the IP's count too", () => {
    const { limits } = setup();
    for (let i = 0; i < 59; i++) {
      take(limits, `install${i}`, "ip", "c");
    }
    const verdict = limits.reserveDeck("last", "ip", "c");
    if (verdict.ok) {
      verdict.release();
    }
    expect(take(limits, "another", "ip", "c").ok).toBe(true);
  });

  it("allows 10 new collections a day per install", () => {
    const { clock, limits } = setup();
    for (let i = 0; i < 10; i++) {
      expect(take(limits, "install", "ip", `c${i}`).ok).toBe(true);
      clock.advance(MINUTE_MS);
    }
    expect(take(limits, "install", "ip", "c10")).toEqual({
      ok: false,
      retryAfterMs: 24 * HOUR_MS - 10 * MINUTE_MS,
    });
    // the ones already chosen still work
    clock.advance(5 * MINUTE_MS);
    expect(take(limits, "install", "ip", "c9").ok).toBe(true);
  });

  it("allows 48 decks a day per install", () => {
    const { clock, limits } = setup();
    for (let i = 0; i < 48; i++) {
      expect(take(limits, "install", `ip${i}`, "c").ok).toBe(true);
      clock.advance(5 * MINUTE_MS);
    }
    expect(take(limits, "install", "ip", "c").ok).toBe(false);
    clock.advance(24 * HOUR_MS - 48 * 5 * MINUTE_MS);
    expect(take(limits, "install", "ip", "c").ok).toBe(true);
  });

  it("allows 60 decks an hour per IP, whatever the install ids", () => {
    const { clock, limits } = setup();
    for (let i = 0; i < 60; i++) {
      expect(take(limits, `install${i}`, "ip", "c").ok).toBe(true);
    }
    expect(take(limits, "another", "ip", "c")).toEqual({ ok: false, retryAfterMs: HOUR_MS });
    clock.advance(HOUR_MS);
    expect(take(limits, "another", "ip", "c").ok).toBe(true);
  });

  it("forgets what no longer limits anything", () => {
    const { clock, limits } = setup();
    take(limits, "install", "ip", "c");
    clock.advance(25 * HOUR_MS);
    limits.sweep();
    expect(take(limits, "install", "ip", "c")).toEqual({ ok: true, first: true });
  });
});
