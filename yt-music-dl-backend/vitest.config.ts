import { defineConfig } from "vitest/config";

// Vitest runs in Node — packages using Bun-only APIs (bun:sqlite) are tested
// separately via `bun run test:bun`. Mirrors dispatch-backend's split.
export default defineConfig({
	test: {
		include: ["packages/**/src/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/*.bun.test.ts"],
	},
});
