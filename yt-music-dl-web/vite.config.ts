import { execSync } from "node:child_process";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The frontend is the single entry point (plain HTTP, reachable over Tailscale
// at http://arch-razer:24304 or http://localhost:24304). It proxies /api, /ws,
// /health to the backend on localhost — one origin, no CORS, no mixed-content.
const BACKEND_TARGET = process.env.YTMDL_BACKEND_TARGET ?? "http://127.0.0.1:24303";

export default defineConfig({
	plugins: [tailwindcss(), svelte()],
	server: {
		port: 24304,
		host: true,
		allowedHosts: true,
		proxy: {
			"/api": { target: BACKEND_TARGET, changeOrigin: true },
			"/ws": { target: BACKEND_TARGET, changeOrigin: true, ws: true },
			"/health": { target: BACKEND_TARGET, changeOrigin: true },
		},
	},
	define: {
		__APP_VERSION__: JSON.stringify(getGitShortHash()),
	},
});

function getGitShortHash(): string {
	try {
		return execSync("git rev-parse --short=5 HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "dev";
	}
}
