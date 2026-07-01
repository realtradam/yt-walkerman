/**
 * @yt-music/musicbrainz — thin MusicBrainz web service client.
 *
 * Text-only metadata lookup via the MusicBrainz API (no fingerprinting). We
 * search by artist + recording/release title, then fetch full release details
 * with track listings for album match-all.
 *
 * PURE CORE (zero I/O, unit-tested): buildRecordingSearchUrl,
 * buildReleaseSearchUrl, buildReleaseLookupUrl, parseRecordingSearch,
 * parseReleaseSearch, parseReleaseDetail, matchAlbumToDraft. These take JSON
 * (already fetched) and return contract types — no fs / network / subprocess.
 *
 * INJECTED SHELL: createMusicBrainzClient wraps an injectable `fetch` and
 * rate-limits to 1 request per second (MusicBrainz's hard rate limit). Tests
 * stub the OUTERMOST edge (the fetch) and never touch the pure parsers.
 *
 * See .research/08-musicbrainz-integration.md.
 */
import type {
	AlbumMatch,
	AlbumMatchResult,
	CutDraft,
	MetadataResult,
	ReleaseDetail,
	ReleaseTrack,
} from "@yt-music/contract";

const DEFAULT_BASE_URL = "https://musicbrainz.org/ws/2";
const DEFAULT_LIMIT = 25;
const DEFAULT_USER_AGENT = "yt-music-dl/1.0 ( https://github.com/realtradam/yt-walkerman )";
const DEFAULT_MIN_INTERVAL = 1000; // 1 second — MusicBrainz rate limit

// ─── Pure core: URL building ─────────────────────────────────────────────────

/**
 * Build a Lucene query string for a MusicBrainz search. When an artist hint is
 * given, it is folded in as `artist:"<artist>" AND <entity>:"<query>"`; with no
 * artist the query is passed through verbatim (so callers may supply their own
 * Lucene expression).
 *
 * Pure: (entity, query, artist) → query string.
 */
function buildLuceneQuery(entity: "recording" | "release", query: string, artist?: string): string {
	if (artist && artist.length > 0) {
		return `artist:"${artist}" AND ${entity}:"${query}"`;
	}
	return query;
}

/**
 * Build the full URL for a recording search.
 *
 * Pure: (query, artist?, limit?, baseUrl?) → URL string.
 */
export function buildRecordingSearchUrl(
	query: string,
	artist?: string,
	limit: number = DEFAULT_LIMIT,
	baseUrl: string = DEFAULT_BASE_URL,
): string {
	const q = buildLuceneQuery("recording", query, artist);
	return `${baseUrl}/recording?query=${encodeURIComponent(q)}&limit=${limit}&fmt=json`;
}

/**
 * Build the full URL for a release search.
 *
 * Pure: (query, artist?, limit?, baseUrl?) → URL string.
 */
export function buildReleaseSearchUrl(
	query: string,
	artist?: string,
	limit: number = DEFAULT_LIMIT,
	baseUrl: string = DEFAULT_BASE_URL,
): string {
	const q = buildLuceneQuery("release", query, artist);
	return `${baseUrl}/release?query=${encodeURIComponent(q)}&limit=${limit}&fmt=json`;
}

/**
 * Build the full URL for a release lookup (with recordings + artist-credits +
 * release-groups, so the track list is included).
 *
 * Pure: (mbid, baseUrl?) → URL string.
 */
export function buildReleaseLookupUrl(mbid: string, baseUrl: string = DEFAULT_BASE_URL): string {
	return `${baseUrl}/release/${encodeURIComponent(mbid)}?inc=recordings+artist-credits+release-groups&fmt=json`;
}

// ─── Pure core: parsing ──────────────────────────────────────────────────────

/** The raw MusicBrainz artist-credit shape (subset we consume). */
interface MbArtistCredit {
	name?: string;
	joinphrase?: string;
	artist?: { name?: string };
}

/** The raw MusicBrainz recording shape (subset we consume). */
interface MbRecording {
	id?: string;
	title?: string;
	score?: number;
	length?: number;
	"artist-credit"?: MbArtistCredit[];
	releases?: Array<{ id?: string; title?: string }>;
}

/** The raw MusicBrainz release (search result) shape. */
interface MbRelease {
	id?: string;
	title?: string;
	score?: number;
	date?: string;
	"artist-credit"?: MbArtistCredit[];
}

/** The raw MusicBrainz track shape (inside a medium). */
interface MbTrack {
	id?: string;
	title?: string;
	position?: number;
	number?: string | number;
	length?: number;
	recording?: { id?: string; title?: string; length?: number };
}

/** The raw MusicBrainz medium shape. */
interface MbMedium {
	position?: number;
	format?: string;
	"track-count"?: number;
	tracks?: MbTrack[];
}

/** The raw MusicBrainz release-detail shape. */
interface MbReleaseDetail {
	id?: string;
	title?: string;
	date?: string;
	"artist-credit"?: MbArtistCredit[];
	media?: MbMedium[];
}

/**
 * Join a MusicBrainz artist-credit array into a single display string.
 * e.g. [{name:"Autechre",joinphrase:" & "},{name:"The Hafler Trio",joinphrase:""}]
 *      → "Autechre & The Hafler Trio"
 *
 * Pure: (artistCredit) → string.
 */
function joinArtistCredit(ac: MbArtistCredit[] | undefined): string {
	if (!Array.isArray(ac)) return "";
	let out = "";
	for (const nc of ac) {
		out += nc?.name ?? nc?.artist?.name ?? "";
		out += nc?.joinphrase ?? "";
	}
	return out;
}

/** The base URL for Cover Art Archive front-cover redirects. */
const COVER_ART_ARCHIVE_BASE = "https://coverartarchive.org/release";

/**
 * Build the Cover Art Archive front-cover URL for a release MBID.
 *
 * The URL follows the CAA convention: `GET /release/<MBID>/front` returns a
 * 307 redirect to the actual JPEG. The image is fetched on demand by the
 * backend (never by the pure parser).
 *
 * Pure: (mbid) → URL string.
 */
export function buildCoverArtUrl(mbid: string): string {
	return `${COVER_ART_ARCHIVE_BASE}/${mbid}/front`;
}

/**
 * Parse a MusicBrainz recording-search JSON response into MetadataResult[].
 *
 * Each recording maps to a result with: id, type "recording", title, artist
 * (from artist-credit), album (first release's title, when present), score,
 * and artUrl (Cover Art Archive URL built from the first release's MBID, when
 * present). trackNumber is not available in recording search results (the
 * release detail lookup is needed for track positions).
 *
 * Pure: (json) → MetadataResult[]. Robust to missing/malformed fields.
 */
export function parseRecordingSearch(json: unknown): MetadataResult[] {
	if (!json || typeof json !== "object") return [];
	const obj = json as { recordings?: MbRecording[] };
	if (!Array.isArray(obj.recordings)) return [];
	const out: MetadataResult[] = [];
	for (const rec of obj.recordings) {
		if (!rec || typeof rec !== "object" || !rec.id || !rec.title) continue;
		const result: MetadataResult = {
			id: rec.id,
			type: "recording",
			title: rec.title,
			artist: joinArtistCredit(rec["artist-credit"]),
			score: typeof rec.score === "number" ? rec.score : 0,
		};
		const firstRelease = rec.releases?.[0];
		if (firstRelease?.title) {
			result.album = firstRelease.title;
		}
		if (firstRelease?.id) {
			result.artUrl = buildCoverArtUrl(firstRelease.id);
		}
		out.push(result);
	}
	return out;
}

/**
 * Parse a MusicBrainz release-search JSON response into MetadataResult[].
 *
 * Each release maps to a result with: id, type "release", title, artist, score,
 * and artUrl (Cover Art Archive URL built from the release's own MBID).
 * album/trackNumber are not applicable to releases.
 *
 * Pure: (json) → MetadataResult[].
 */
export function parseReleaseSearch(json: unknown): MetadataResult[] {
	if (!json || typeof json !== "object") return [];
	const obj = json as { releases?: MbRelease[] };
	if (!Array.isArray(obj.releases)) return [];
	const out: MetadataResult[] = [];
	for (const rel of obj.releases) {
		if (!rel || typeof rel !== "object" || !rel.id || !rel.title) continue;
		out.push({
			id: rel.id,
			type: "release",
			title: rel.title,
			artist: joinArtistCredit(rel["artist-credit"]),
			score: typeof rel.score === "number" ? rel.score : 0,
			artUrl: buildCoverArtUrl(rel.id),
		});
	}
	return out;
}

/**
 * Parse a MusicBrainz release-detail JSON response into ReleaseDetail.
 *
 * Flattens media[].tracks[] into a single track list with a GLOBAL running
 * position (so multi-disc albums have unique 1-based track numbers suitable for
 * 1:1 matching against a CutDraft's segments). Each track's recordingId comes
 * from its `recording.id`.
 *
 * Pure: (json) → ReleaseDetail. Returns an empty-track release if fields are
 * missing, so callers always get a well-formed object.
 */
export function parseReleaseDetail(json: unknown): ReleaseDetail {
	const obj = (json && typeof json === "object" ? json : {}) as MbReleaseDetail;
	const id = obj.id ?? "";
	const title = obj.title ?? "";
	const artist = joinArtistCredit(obj["artist-credit"]);
	const tracks: ReleaseTrack[] = [];
	let globalPosition = 0;
	for (const medium of obj.media ?? []) {
		for (const tr of medium.tracks ?? []) {
			if (!tr || typeof tr !== "object") continue;
			globalPosition++;
			const recordingId = tr.recording?.id ?? tr.id ?? "";
			const track: ReleaseTrack = {
				position: globalPosition,
				title: tr.title ?? "",
				recordingId,
			};
			if (typeof tr.length === "number") {
				track.length = tr.length;
			}
			tracks.push(track);
		}
	}
	const detail: ReleaseDetail = { id, title, artist, tracks };
	if (typeof obj.date === "string" && obj.date.length > 0) {
		detail.date = obj.date;
	}
	return detail;
}

// ─── Pure core: album matching ───────────────────────────────────────────────

/**
 * Normalize a title for fuzzy comparison: lowercase, strip parentheticals and
 * brackets, strip punctuation (keep word chars + spaces), collapse whitespace.
 *
 * Pure: (s) → normalized string.
 */
export function normalizeTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/\s*\([^)]*\)\s*/g, " ") // strip parentheticals
		.replace(/\s*\[[^\]]*]\s*/g, " ") // strip brackets
		.replace(/[^\w\s]/g, "") // strip punctuation (keep word chars + spaces)
		.replace(/\s+/g, " ") // collapse whitespace
		.trim();
}

/**
 * Classic Levenshtein edit distance. Pure: (a, b) → distance.
 */
export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	// Two rolling rows of length n+1 (indices 0..n are always in range).
	const prev: number[] = new Array<number>(n + 1);
	const curr: number[] = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		const ai = a[i - 1];
		for (let j = 1; j <= n; j++) {
			const cost = ai === b[j - 1] ? 0 : 1;
			const del = (prev[j] ?? 0) + 1;
			const ins = (curr[j - 1] ?? 0) + 1;
			const sub = (prev[j - 1] ?? 0) + cost;
			curr[j] = Math.min(del, ins, sub);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
	}
	return prev[n] ?? 0;
}

/**
 * Title similarity in [0,1]: 1 = identical, 0 = no overlap. Uses normalized
 * Levenshtein distance. Pure: (a, b) → similarity.
 */
export function titleSimilarity(a: string, b: string): number {
	const na = normalizeTitle(a);
	const nb = normalizeTitle(b);
	if (na.length === 0 || nb.length === 0) return 0;
	const dist = levenshtein(na, nb);
	const maxLen = Math.max(na.length, nb.length);
	if (maxLen === 0) return 0;
	return 1 - dist / maxLen;
}

/** Minimum normalized similarity to count a title match (vs "none"). */
const TITLE_MATCH_THRESHOLD = 0.3;

/**
 * Match a release's tracks to a CutDraft's segments.
 *
 * 1. If draft.segments.length === release.tracks.length: match by position
 *    (segment[0] → track[0], ...), confidence "position".
 * 2. Otherwise: match by normalized title similarity (greedy, no duplicate
 *    track assignments). Each segment gets its best unassigned track; confidence
 *    "title" when above the threshold, "none" otherwise (the closest track is
 *    still attached so the frontend always has a value to display).
 *
 * Returns one match per segment (empty when segments or tracks are empty).
 *
 * Pure: (draft, release) → AlbumMatchResult.
 */
export function matchAlbumToDraft(draft: CutDraft, release: ReleaseDetail): AlbumMatchResult {
	const segments = draft.segments;
	const tracks = release.tracks;
	if (segments.length === 0 || tracks.length === 0) {
		return { matches: [] };
	}

	// 1. Exact count → positional 1:1 match.
	if (segments.length === tracks.length) {
		const matches: AlbumMatch[] = [];
		for (let i = 0; i < segments.length; i++) {
			const track = tracks[i];
			if (!track) break; // unreachable: lengths are equal
			matches.push({ segmentIndex: i, track, confidence: "position" });
		}
		return { matches };
	}

	// 2. Mismatched counts → greedy title-similarity matching.
	const assigned = new Set<number>();
	const matches: AlbumMatch[] = [];
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (!segment) continue;
		const segTitle = segment.title;
		let bestIdx = -1;
		let bestSim = -1;
		for (let j = 0; j < tracks.length; j++) {
			if (assigned.has(j)) continue;
			const track = tracks[j];
			if (!track) continue;
			const sim = titleSimilarity(segTitle, track.title);
			if (sim > bestSim) {
				bestSim = sim;
				bestIdx = j;
			}
		}
		if (bestIdx >= 0 && bestSim >= TITLE_MATCH_THRESHOLD) {
			assigned.add(bestIdx);
			const track = tracks[bestIdx];
			if (track) matches.push({ segmentIndex: i, track, confidence: "title" });
		} else {
			// No good match (or no unassigned track left): attach the closest
			// track for display purposes but flag low confidence.
			const track = bestIdx >= 0 ? tracks[bestIdx] : tracks[0];
			if (track) matches.push({ segmentIndex: i, track, confidence: "none" });
		}
	}
	return { matches };
}

// ─── Injected shell ─────────────────────────────────────────────────────────

/** A fetch function (the injected network effect). Defaults to global fetch. */
export type FetchFn = (
	url: string,
	init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

/** The MusicBrainz client — injected effect. */
export interface MusicBrainzClient {
	searchRecordings(query: string, artist?: string): Promise<MetadataResult[]>;
	searchReleases(query: string, artist?: string): Promise<MetadataResult[]>;
	getRelease(mbid: string): Promise<ReleaseDetail>;
}

export interface MusicBrainzOptions {
	baseUrl?: string;
	fetch?: FetchFn;
	/** Minimum ms between requests (default 1000 — MusicBrainz rate limit). */
	minInterval?: number;
	userAgent?: string;
}

/**
 * Create a MusicBrainz client. The fetch function is injectable so tests can
 * stub the OUTERMOST edge (network) without touching the pure parsing logic.
 *
 * All requests are serialized through a promise chain and spaced at least
 * `minInterval` ms apart (default 1s) to respect MusicBrainz's rate limit.
 */
export function createMusicBrainzClient(opts: MusicBrainzOptions = {}): MusicBrainzClient {
	const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
	const fetchFn = opts.fetch ?? (globalThis.fetch as FetchFn);
	const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
	const minInterval = opts.minInterval ?? DEFAULT_MIN_INTERVAL;

	let lastRequest = 0;
	let chain: Promise<unknown> = Promise.resolve();

	/** Serialize a request through the chain, enforcing the rate limit. */
	function schedule<T>(run: () => Promise<T>): Promise<T> {
		const p = chain.then(async () => {
			const now = Date.now();
			const wait = minInterval - (now - lastRequest);
			if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
			lastRequest = Date.now();
			return run();
		});
		// Keep the chain alive regardless of this request's outcome.
		chain = p.then(
			() => undefined,
			() => undefined,
		);
		return p as Promise<T>;
	}

	/** Fetch JSON from MusicBrainz with the required User-Agent header. */
	async function fetchJson(url: string): Promise<unknown> {
		const res = await fetchFn(url, {
			method: "GET",
			headers: { "User-Agent": userAgent, Accept: "application/json" },
		});
		if (!res.ok) {
			throw new Error(`MusicBrainz request failed: ${res.status} for ${url}`);
		}
		return res.json();
	}

	return {
		async searchRecordings(query: string, artist?: string): Promise<MetadataResult[]> {
			const url = buildRecordingSearchUrl(query, artist, DEFAULT_LIMIT, baseUrl);
			return schedule(async () => {
				const json = await fetchJson(url);
				return parseRecordingSearch(json);
			});
		},
		async searchReleases(query: string, artist?: string): Promise<MetadataResult[]> {
			const url = buildReleaseSearchUrl(query, artist, DEFAULT_LIMIT, baseUrl);
			return schedule(async () => {
				const json = await fetchJson(url);
				return parseReleaseSearch(json);
			});
		},
		async getRelease(mbid: string): Promise<ReleaseDetail> {
			const url = buildReleaseLookupUrl(mbid, baseUrl);
			return schedule(async () => {
				const json = await fetchJson(url);
				return parseReleaseDetail(json);
			});
		},
	};
}
