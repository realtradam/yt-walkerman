/**
 * src/adapters/metadataApi.ts — injected browser effect: MusicBrainz HTTP client.
 *
 * Wraps `fetch` against `/api/metadata` (same origin — the Vite proxy forwards
 * to the backend). Injected into the segment-editor feature so the pure logic
 * never touches the network. Holds no business logic: three thin calls that
 * mirror the Phase 7 backend endpoints exactly —
 *
 *   - `search`  (POST /api/metadata/search)        → recording/release text search
 *   - `release`  (GET  /api/metadata/release/:mbid) → full ReleaseDetail incl. tracks
 *   - `matchAlbum` (POST /api/metadata/match-album) → per-segment AlbumMatchResult
 *
 * MusicBrainz is rate-limited to ~1 req/sec SERVER-SIDE; the backend serializes
 * + spaces requests, so a single search may take ~1s. Callers must show a
 * loading state (the sidebar / match-album dialog own that UI state). Upstream
 * MB errors surface here as HTTP 502 `{ error }` — read as a thrown `Error`.
 *
 * The factory accepts a base URL so tests/SSR can swap the endpoint; the default
 * is the relative `/api/metadata` used in dev and prod.
 */
import type {
	AlbumMatchResult,
	MatchAlbumRequest,
	MetadataResult,
	MetadataSearchRequest,
	ReleaseDetail,
} from "@yt-music/contract";

export interface MetadataSearchResponse {
	results: MetadataResult[];
}

export interface MetadataApi {
	/** Search MusicBrainz for recordings or releases (POST /api/metadata/search). */
	search(req: MetadataSearchRequest): Promise<MetadataResult[]>;
	/** Fetch a release's full detail + global track list (GET /api/metadata/release/:mbid). */
	release(mbid: string): Promise<ReleaseDetail>;
	/** Match a CutDraft's segments against a release's tracks (POST /api/metadata/match-album). */
	matchAlbum(req: MatchAlbumRequest): Promise<AlbumMatchResult>;
}

export function createMetadataApi(baseUrl = "/api/metadata"): MetadataApi {
	return {
		async search(req: MetadataSearchRequest): Promise<MetadataResult[]> {
			const res = await fetch(`${baseUrl}/search`, {
				method: "POST",
				headers: { "Content-Type": "application/json", accept: "application/json" },
				body: JSON.stringify(req),
			});
			if (!res.ok) {
				throw new Error(await readError(res, "metadata search"));
			}
			const data = (await res.json()) as MetadataSearchResponse;
			return data.results;
		},
		async release(mbid: string): Promise<ReleaseDetail> {
			const res = await fetch(`${baseUrl}/release/${encodeURIComponent(mbid)}`, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) {
				throw new Error(await readError(res, "release fetch"));
			}
			return (await res.json()) as ReleaseDetail;
		},
		async matchAlbum(req: MatchAlbumRequest): Promise<AlbumMatchResult> {
			const res = await fetch(`${baseUrl}/match-album`, {
				method: "POST",
				headers: { "Content-Type": "application/json", accept: "application/json" },
				body: JSON.stringify(req),
			});
			if (!res.ok) {
				throw new Error(await readError(res, "album match"));
			}
			return (await res.json()) as AlbumMatchResult;
		},
	};
}

/**
 * The backend returns HTTP 502 `{ error }` on MusicBrainz upstream failures.
 * Prefer that message when present so the UI surfaces the real cause; otherwise
 * fall back to status + statusText. Reads the body once.
 */
async function readError(res: Response, label: string): Promise<string> {
	let detail = "";
	try {
		const body = (await res.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error.trim()) detail = body.error.trim();
	} catch {
		// non-JSON body — fall through to status text
	}
	const tail = detail || `${res.status} ${res.statusText}`.trim();
	return `${label} failed: ${tail}`;
}
