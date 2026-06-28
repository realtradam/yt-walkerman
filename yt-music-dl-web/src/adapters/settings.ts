/**
 * src/adapters/settings.ts — injected browser effect: settings HTTP client.
 *
 * Wraps `fetch` against `/api/settings` (same origin — the Vite proxy forwards
 * to the backend). Injected into the settings feature so the pure logic never
 * touches the network. Holds no business logic: `fetchSettings` (GET) returns
 * the persisted settings (or env-derived defaults), and `saveSettings` (PUT)
 * persists `{ outputDir, format, pathTemplate }` and returns the stored value.
 *
 * The factory accepts a base URL so tests/SSR can swap the endpoint; the
 * default is the relative `/api/settings` used in dev and prod.
 */
import type { SaveSettingsRequest, Settings } from "@yt-music/contract";

export interface SettingsApi {
	/** Load the current settings (GET /api/settings). */
	fetchSettings(): Promise<Settings>;
	/** Persist settings (PUT /api/settings); returns the persisted Settings. */
	saveSettings(settings: Settings): Promise<Settings>;
}

export function createSettingsApi(baseUrl = "/api/settings"): SettingsApi {
	return {
		async fetchSettings(): Promise<Settings> {
			const res = await fetch(baseUrl, { headers: { accept: "application/json" } });
			if (!res.ok) {
				throw new Error(`settings load failed: ${res.status} ${res.statusText}`.trim());
			}
			return (await res.json()) as Settings;
		},
		async saveSettings(settings): Promise<Settings> {
			const res = await fetch(baseUrl, {
				method: "PUT",
				headers: { "Content-Type": "application/json", accept: "application/json" },
				body: JSON.stringify({ settings } satisfies SaveSettingsRequest),
			});
			if (!res.ok) {
				throw new Error(`settings save failed: ${res.status} ${res.statusText}`.trim());
			}
			return (await res.json()) as Settings;
		},
	};
}
