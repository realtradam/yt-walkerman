/**
 * src/features/segment-editor/metadata.ts — PURE: MusicBrainz sidebar + match logic.
 *
 * Everything here is pure `input → output`: the search state machine, the
 * search-request builders, the sidebar view-model (the "Generated from YouTube"
 * entry + MB result cards), and the cut-plan edits that result from clicking a
 * card or applying a whole-album match. Zero DOM / fetch / WebSocket / Svelte —
 * the injected `MetadataApi` (`src/adapters/metadataApi.ts`) is the only side-effect,
 * called from the thin components, which wire the results back through `onaction`
 * (the composition root folds the pure `reduce`).
 *
 * Vocabulary (GLOSSARY, adopted verbatim from the backend): a `MetadataResult`
 * is one MB search hit; a `ReleaseDetail` is a release + its GLOBAL track list;
 * an `AlbumMatch` pairs one `SegmentDraft` (by `segmentIndex`) with one
 * `ReleaseTrack` at a `confidence` of "position" | "title" | "none".
 */
import type {
	AlbumMatchResult,
	CutDraft,
	MetadataResult,
	MetadataSearchRequest,
	ReleaseDetail,
	SegmentDraft,
} from "@yt-music/contract";
import type { EditAction } from "./logic.js";

// ─── Sidebar search state machine (pure) ──────────────────────────────────────

export type SearchStatus = "idle" | "searching" | "results" | "error";

/**
 * The sidebar's view of one MB search. `query` is the live text in the search
 * box; `results` are the last successful search's hits (kept across a re-search
 * so the list doesn't blank while loading). Pure: transitions come only through
 * `reduceSearch`.
 */
export interface SearchState {
	status: SearchStatus;
	query: string;
	results: MetadataResult[];
	error?: string;
}

export function initialSearchState(query = ""): SearchState {
	return { status: "idle", query, results: [] };
}

export type SearchEvent =
	| { type: "setQuery"; query: string }
	| { type: "searchStarted"; query: string }
	| { type: "searchOk"; results: MetadataResult[] }
	| { type: "searchFailed"; error: string };

/** Fold one search event into the sidebar state. Pure: (state, event) → state. */
export function reduceSearch(state: SearchState, event: SearchEvent): SearchState {
	switch (event.type) {
		case "setQuery":
			return { ...state, query: event.query };
		case "searchStarted":
			// Omit `error` (exactOptionalPropertyTypes) rather than set undefined.
			return { status: "searching", query: event.query, results: state.results };
		case "searchOk":
			return { status: "results", query: state.query, results: event.results };
		case "searchFailed":
			return { status: "error", query: state.query, results: [], error: event.error };
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

// ─── Search-request builders (pure) ──────────────────────────────────────────

/**
 * Build the recording-search request for a segment's sidebar. `query` is the
 * search-box text (falling back to the segment title when blank). The search is
 * title-only — no artist hint is sent. For YouTube downloads the segment/global
 * artist is the channel name (e.g. 'Official YouTube Channel'), which MusicBrainz
 * has no artist for, so a Lucene `artist:"…" AND recording:"…"` query returns
 * zero results. Mirrors the backend's `MetadataSearchRequest`.
 *
 * `globalArtist` is retained in the signature for backward compatibility (the
 * caller still passes it) but is now unused. Pure: (segment, query, globalArtist) → request.
 */
export function buildRecordingSearch(
	segment: SegmentDraft,
	query: string,
	// Prefixed `_` to satisfy Biome's noUnusedFunctionParameters: retained in the
	// signature for backward compatibility (the caller still passes it) but the
	// artist hint is no longer sent — see the doc comment above.
	_globalArtist: string,
): MetadataSearchRequest {
	const q = query.trim() || segment.title.trim();
	return { query: q, type: "recording" };
}

/**
 * Build the release-search request for the "Match Album" dialog. `album` is the
 * album-name search text (falling back to the global album). The search is
 * album-only — no artist hint is sent. For YouTube downloads the draft's global
 * artist is the channel name, and the dialog prefills its artist box with it, so
 * sending it as a Lucene `artist:"…"` hint yields zero MB release results.
 *
 * `artist` and `globalArtist` are retained in the signature for backward
 * compatibility (the caller still passes them) but are now unused.
 * Pure: (album, artist, globalAlbum, globalArtist) → request.
 */
export function buildReleaseSearch(
	album: string,
	// Prefixed `_` to satisfy Biome's noUnusedFunctionParameters: retained in the
	// signature for backward compatibility (the caller still passes them) but the
	// artist hint is no longer sent — see the doc comment above.
	_artist: string,
	globalAlbum: string,
	_globalArtist: string,
): MetadataSearchRequest {
	const q = album.trim() || globalAlbum.trim();
	return { query: q, type: "release" };
}

// ─── Sidebar view-model (pure) ───────────────────────────────────────────────

/**
 * One row in the sidebar's results list. The "Generated from YouTube" entry
 * (GLOSSARY: the chapter-parsed title the backend put on the segment) is always
 * first and carries no MBID/score; MB result cards follow. A unified shape so
 * the component renders one `{#each}` over `sidebarItems`.
 */
export interface SidebarItem {
	source: "youtube" | "musicbrainz";
	title: string;
	artist: string;
	album?: string;
	trackNumber?: number;
	/** MB relevance score (0-100); absent for the YouTube entry. */
	score?: number;
	/** MusicBrainz MBID; absent for the YouTube entry. */
	id?: string;
}

/** The "Generated from YouTube" entry: the segment's current parsed fields. Pure. */
export function youtubeItem(segment: SegmentDraft): SidebarItem {
	return {
		source: "youtube",
		title: segment.title,
		artist: segment.artist,
		album: segment.album,
		trackNumber: segment.trackNumber,
	};
}

/** Map one MB result to a sidebar row. Pure. */
export function toSidebarItem(result: MetadataResult): SidebarItem {
	// exactOptionalPropertyTypes: include album/trackNumber only when present
	// (MB omits these from lightweight recording search entries).
	const item: SidebarItem = {
		source: "musicbrainz",
		id: result.id,
		title: result.title,
		artist: result.artist,
		score: result.score,
	};
	if (result.album !== undefined) item.album = result.album;
	if (result.trackNumber !== undefined) item.trackNumber = result.trackNumber;
	return item;
}

/**
 * The full sidebar list: the "Generated from YouTube" entry first, then the MB
 * recording-search results in the backend's relevance order. Pure.
 */
export function sidebarItems(segment: SegmentDraft, results: MetadataResult[]): SidebarItem[] {
	return [youtubeItem(segment), ...results.map(toSidebarItem)];
}

// ─── Click-to-fill (pure → EditAction[]) ─────────────────────────────────────

/**
 * The cut-plan edits that fill a segment from one sidebar item.
 *
 * - "Generated from YouTube": leaves the segment fields unchanged (the item
 *   already mirrors the segment's current parsed values) → no edits.
 * - MusicBrainz result: sets title + artist always; album + trackNumber only
 *   when the result actually carries them (MB omits these from lightweight
 *   recording search entries).
 *
 * Pure: (segmentId, item) → actions. Dispatched by the component through
 * `onaction`; the composition root folds each over the pure `reduce`.
 */
export function fillActions(segmentId: string, item: SidebarItem): EditAction[] {
	if (item.source === "youtube") return []; // no-op — fields already hold these values
	const actions: EditAction[] = [
		{ type: "editSegmentTitle", segmentId, title: item.title },
		{ type: "editSegmentArtist", segmentId, artist: item.artist },
	];
	if (item.album !== undefined) {
		actions.push({ type: "editSegmentAlbum", segmentId, album: item.album });
	}
	if (item.trackNumber !== undefined) {
		actions.push({ type: "editSegmentTrackNumber", segmentId, trackNumber: item.trackNumber });
	}
	return actions;
}

/**
 * Convenience: the cut-plan edits that fill a segment directly from an MB result,
 * without going through the sidebar view-model. Used where a result is applied
 * without a sidebar round-trip. Pure: (segmentId, result) → actions.
 */
export function fillFromResult(segmentId: string, result: MetadataResult): EditAction[] {
	return fillActions(segmentId, toSidebarItem(result));
}

// ─── Match-album → cut-plan edits (pure → EditAction[]) ──────────────────────

/**
 * The cut-plan edits that apply a whole-album match. For every match whose
 * `confidence` is "position" or "title", fills the segment's
 * title = track.title, artist = release.artist, album = release.title,
 * trackNumber = track.position. "none"-confidence matches are skipped (those
 * segments are left as-is). Matches reference segments by `segmentIndex`, which
 * is resolved to the segment id via the (unchanged) draft passed to the backend.
 *
 * Pure: (draft, release, matchResult) → actions. Dispatched through `onaction`.
 */
export function albumMatchActions(
	draft: CutDraft,
	release: ReleaseDetail,
	matchResult: AlbumMatchResult,
): EditAction[] {
	const actions: EditAction[] = [];
	for (const match of matchResult.matches) {
		if (match.confidence === "none") continue;
		const segment = draft.segments[match.segmentIndex];
		if (!segment) continue; // index out of range → skip defensively
		const track = match.track;
		actions.push({ type: "editSegmentTitle", segmentId: segment.id, title: track.title });
		actions.push({ type: "editSegmentArtist", segmentId: segment.id, artist: release.artist });
		actions.push({ type: "editSegmentAlbum", segmentId: segment.id, album: release.title });
		actions.push({
			type: "editSegmentTrackNumber",
			segmentId: segment.id,
			trackNumber: track.position,
		});
	}
	return actions;
}

/**
 * Count how many segments a match result would actually fill (confidence
 * "position" or "title"). Display-only helper for the match-album dialog's
 * "N of M segments matched" summary. Pure.
 */
export function matchedSegmentCount(matchResult: AlbumMatchResult): number {
	return matchResult.matches.filter((m) => m.confidence !== "none").length;
}
