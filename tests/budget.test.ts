import { describe, expect, it } from "vitest";

import { Budget } from "../src/budget.ts";
import { Clock } from "./helpers.ts";

describe("Budget", () => {
  it("lets everything through while plenty remains", () => {
    const budget = new Budget(1000);
    expect(budget.canSpend("curatedSync")).toBe(true);
    expect(budget.canSpend("deck")).toBe(true);
  });

  it("stops lower priorities first", () => {
    const clock = new Clock();
    const budget = new Budget(1000, clock.now);
    budget.update(200);
    expect(budget.canSpend("curatedSync")).toBe(false);
    expect(budget.canSpend("deck")).toBe(true);

    budget.update(100);
    expect(budget.canSpend("deck")).toBe(false);
    expect(budget.canSpend("firstDeck")).toBe(true);

    budget.update(1);
    expect(budget.canSpend("firstDeck")).toBe(false);
    expect(budget.canSpend("curatedEmpty")).toBe(true);

    budget.exhaust();
    expect(budget.canSpend("curatedEmpty")).toBe(false);
  });

  it("scales the watermarks with the limit Unsplash reports", () => {
    const clock = new Clock();
    const budget = new Budget(1000, clock.now);
    // a demo key: 50 an hour, so the watermarks are 2.5, 7.5 and 15
    budget.update(42, 50);
    expect(budget.canSpend("curatedSync")).toBe(true);
    budget.update(15, 50);
    expect(budget.canSpend("curatedSync")).toBe(false);
    expect(budget.canSpend("deck")).toBe(true);
    budget.update(7, 50);
    expect(budget.canSpend("deck")).toBe(false);
    expect(budget.canSpend("firstDeck")).toBe(true);
    budget.update(2, 50);
    expect(budget.canSpend("firstDeck")).toBe(false);
    expect(budget.canSpend("curatedEmpty")).toBe(true);
  });

  it("counts requests before their responses arrive", () => {
    const clock = new Clock();
    const budget = new Budget(1000, clock.now);
    budget.update(152);
    budget.spend();
    expect(budget.canSpend("deck")).toBe(true);
    budget.spend();
    expect(budget.canSpend("deck")).toBe(false);
  });

  it("lets one probe through every 5 minutes once the estimate stops requests", () => {
    const clock = new Clock();
    const budget = new Budget(1000, clock.now);
    budget.exhaust();
    clock.advance(5 * 60_000);
    expect(budget.canSpend("curatedSync")).toBe(true);
    budget.spend();
    expect(budget.canSpend("curatedSync")).toBe(false);
  });
});
