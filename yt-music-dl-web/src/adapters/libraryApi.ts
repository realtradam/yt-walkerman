/**
 * src/adapters/libraryApi.ts — injected browser effect: library HTTP client.
 *
 * Wraps `fetch` against `/api/library` (same origin — the Vite proxy forwards
 * to the backend). Injected into the library feature so the pure logic never
 * touches the network. Holds no business logic: `list` (GET), `rename`
 * (PATCH /:id — rewrites tags + moves the file to the templated path; the
 * returned Track has a NEW id derived from its path), and `organize`
 * (POST /organize — bulk-move every file to the template; returns the fresh
 * track list).
 *
 * The factory accepts a base URL so tests/SSR can swap the endpoint; the
 * default is the relative `/api/library` used in dev and prod.
 */
import type {
	OrganizeResponse,
	Track,
	UpdateTrackRequest,
	UpdateTrackResponse,
} from "@yt-music/contract";

export interface LibraryResponse {
	tracks: Track[];
}

export interface LibraryApi {
	/** Fetch the library track list (GET /api/library). */
	list(): Promise<Track[]>;
	/**
	 * Rename one track (PATCH /api/library/:id): rewrite its tags + move the file
	 * to the path dictated by the current template. Returns the updated track,
	 * which has a NEW id + path (the id is derived from the path). 404 if unknown.
	 */
	rename(id: string, fields: UpdateTrackRequest): Promise<Track>;
	/** Bulk-organize (POST /api/library/organize): move every file to the template. */
	organize(): Promise<OrganizeResponse>;
}

export function createLibraryApi(baseUrl = "/api/library"): LibraryApi {
	return {
		async list(): Promise<Track[]> {
			const res = await fetch(baseUrl, { headers: { accept: "application/json" } });
			if (!res.ok) {
				throw new Error(`library request failed: ${res.status} ${res.statusText}`.trim());
			}
			const data = (await res.json()) as LibraryResponse;
			return data.tracks;
		},
		async rename(id, fields): Promise<Track> {
			// Encode defensively: the id is path-derived and could in principle
			// contain URL-unsafe characters.
			const res = await fetch(`${baseUrl}/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", accept: "application/json" },
				body: JSON.stringify(fields),
			});
			if (!res.ok) {
				throw new Error(`rename failed: ${res.status} ${res.statusText}`.trim());
			}
			const data = (await res.json()) as UpdateTrackResponse;
			return data.track;
		},
		async organize(): Promise<OrganizeResponse> {
			const res = await fetch(`${baseUrl}/organize`, {
				method: "POST",
				headers: { accept: "application/json" },
			});
			if (!res.ok) {
				throw new Error(`organize failed: ${res.status} ${res.statusText}`.trim());
			}
			return (await res.json()) as OrganizeResponse;
		},
	};
}
