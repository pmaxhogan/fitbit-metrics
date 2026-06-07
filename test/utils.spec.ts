import { describe, it, expect } from "vitest";
import { dateRange } from "../src/utils";

const MS_PER_DAY = 86400000;

/** Whole days from date-only string `a` to `b` (both parsed as UTC midnight). */
function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / MS_PER_DAY;
}

describe("dateRange", () => {
  it("defaults to a 30-day window ending yesterday", () => {
    const { start, end } = dateRange();
    expect(daysBetween(start, end)).toBe(30);
    const expectedEnd = new Date(Date.now() - MS_PER_DAY).toISOString().slice(0, 10);
    expect(end).toBe(expectedEnd);
  });

  it("treats daysAgo=0 as the default (current) behavior", () => {
    expect(dateRange(0)).toEqual(dateRange());
  });

  it("shifts the whole 30-day window back by daysAgo days", () => {
    const current = dateRange(0);
    const older = dateRange(30);

    // Still a 30-day-wide window...
    expect(daysBetween(older.start, older.end)).toBe(30);
    // ...just shifted 30 days earlier on both ends.
    expect(daysBetween(older.end, current.end)).toBe(30);
    expect(daysBetween(older.start, current.start)).toBe(30);
    // Adjacent windows meet at one boundary day.
    expect(older.end).toBe(current.start);
  });
});
