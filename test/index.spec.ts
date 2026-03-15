import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("fitbit-metrics worker", () => {
  it("responds on / with info text", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("/metrics");
  });
});
