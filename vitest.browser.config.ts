import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // DOM budgets are wall-clock bounded; avoid six browser processes competing
    // with the real Obsidian acceptance instance on the same test machine.
    maxWorkers: 2,
    include: ["tests/browser/*.browser.ts"],
    testTimeout: 10_000
  }
});
