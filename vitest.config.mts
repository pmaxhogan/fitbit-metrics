import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    // The Workers pool supports istanbul coverage only (not v8).
    coverage: { provider: "istanbul", include: ["src/**"] },
  },
});
