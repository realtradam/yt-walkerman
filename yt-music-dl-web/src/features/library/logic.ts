/**
 * src/features/library/logic.ts — PURE: library view-model + rename reducers
 * + MusicBrainz metadata search helpers.
 *
 * No DOM, no fetch, no WebSocket — pure (input → output). Unit-tested with
 * zero mocks (dispatch "pure core" principle). The Svelte component is a thin
 * wrapper over this: it fetches the raw `Track[]` (via the injected adapter),
 * derives a display model here, and builds rename PATCH bodies via
 * `toUpdateRequest` (only changed fields) / applies them optimistically via
 * `updateTrack`. The MusicBrainz sidebar + match-album helpers
 * (buildTrackSearch, trackSidebarItems, toUpdateRequestFromItem, tracksToDraft,
 * albumMatchToUpdates) mirror the segment editor's metadata.ts but operate on
 * a Track and produce UpdateTrackRequest bodies; the shared search state
 * machine + SidebarItem view-model are re-exported from metadata.ts.
 */
import type {
	AlbumArtRef,
	AlbumMatchResult,
	CutDraft,
	MetadataResult,
	MetadataSearchRequest,
	ReleaseDetail,
	Track,
	UpdateTrackRequest,
} from "@yt-music/contract";
import type { SidebarItem } from "../segment-editor/metadata.js";
import { toSidebarItem } from "../segment-editor/metadata.js";

// Re-export the shared search state machine + sidebar view-model from the
// segment editor's pure metadata module, so the library's sidebar + match-album
// components import everything from one place (./logic.js). No runtime circular
// dependency: metadata.ts's only import from logic.ts is `import type`, erased.
export type { SearchEvent, SearchState, SidebarItem } from "../segment-editor/metadata.js";
export {
	buildReleaseSearch,
	initialSearchState,
	matchedSegmentCount,
	reduceSearch,
	toSidebarItem,
} from "../segment-editor/metadata.js";

/**
 * One row in the library browse view. Derived from a `Track` (GLOSSARY: a
 * library entry — a tagged audio file in the output collection). Pre-formats
 * the track number + duration so the component never computes display strings.
 */
export interface TrackRow {
	id: string;
	title: string;
	artist: string;
	album: string;
	/** Pre-formatted track number ("3") or "—" when absent. */
	trackLabel: string;
	durationLabel: string;
	format: string;
}

export const EMPTY_ROWS: TrackRow[] = [];

/**
 * Format a duration in seconds as `m:ss` (or `h:mm:ss` past an hour).
 * Pure: NaN / negative / Infinity → em dash placeholder. Used for both
 * `Track.duration` and `VideoInfo.duration` (both seconds).
 */
export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "—";
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, "0");
	if (h > 0) {
		return `${h}:${String(m).padStart(2, "0")}:${ss}`;
	}
	return `${m}:${ss}`;
}

/**
 * Display label for a track number: the number, or "—" when absent
 * (`Track.track` is optional — GLOSSARY: 1-based; absent when unknown). Pure.
 */
export function trackNumberLabel(track?: number): string {
	return track == null ? "—" : String(track);
}

/** Derive the display row for one track. Pure. */
export function toTrackRow(track: Track): TrackRow {
	return {
		id: track.id,
		title: track.title,
		artist: track.artist,
		album: track.album,
		trackLabel: trackNumberLabel(track.track),
		durationLabel: formatDuration(track.duration),
		format: track.format,
	};
}

/** Derive display rows for a whole library. Pure. */
export function toRows(tracks: Track[]): TrackRow[] {
	return tracks.map(toTrackRow);
}

// ─── Rename (PATCH /api/library/:id) ─────────────────────────────────────────

/**
 * The inline rename form state. `track` is the raw input string ("" = none) so
 * the component can bind it to a text field without number-coercion surprises;
 * `parseTrackNumber` turns it into a number when building the PATCH body.
 */
export interface TrackEditForm {
	title: string;
	artist: string;
	album: string;
	track: string;
}

/** Seed an edit form from a track's current values. Pure. */
export function toTrackEditForm(track: Track): TrackEditForm {
	return {
		title: track.title,
		artist: track.artist,
		album: track.album,
		track: track.track != null ? String(track.track) : "",
	};
}

/**
 * Parse a track-number input. "" or whitespace → undefined (no change);
 * a valid integer ≥ 1 → that number; anything else → undefined (invalid, so the
 * caller can show a hint and skip sending the field). Pure.
 */
export function parseTrackNumber(input: string): number | undefined {
	const t = input.trim();
	if (t === "") return undefined;
	const n = Number(t);
	if (!Number.isInteger(n) || n < 1) return undefined;
	return n;
}

/** True when the track input is non-empty but invalid. Pure. */
export function hasTrackInputError(input: string): boolean {
	return input.trim() !== "" && parseTrackNumber(input) === undefined;
}

/**
 * Build a PATCH /api/library/:id body (`UpdateTrackRequest`) from the edit
 * form: only fields that differ from the original are included, so the backend
 * leaves the rest untouched. The track field is sent only when the input is a
 * valid integer ≥ 1 AND it differs from the original. Pure.
 */
export function toUpdateRequest(original: Track, form: TrackEditForm): UpdateTrackRequest {
	const req: UpdateTrackRequest = {};
	if (form.title !== original.title) req.title = form.title;
	if (form.artist !== original.artist) req.artist = form.artist;
	if (form.album !== original.album) req.album = form.album;
	const n = parseTrackNumber(form.track);
	if (n !== undefined && n !== original.track) req.track = n;
	return req;
}

/**
 * Apply a rename diff to a track, returning a new track with only the provided
 * fields changed (id + path are LEFT AS-IS — the backend derives the new id +
 * path after the move; this is for an optimistic local update). Pure:
 * (track, fields) → track. Used to reflect edits instantly before the backend
 * responds with the moved file's authoritative new id + path.
 */
export function updateTrack(track: Track, fields: UpdateTrackRequest): Track {
	return {
		...track,
		...(fields.title !== undefined ? { title: fields.title } : {}),
		...(fields.artist !== undefined ? { artist: fields.artist } : {}),
		...(fields.album !== undefined ? { album: fields.album } : {}),
		...(fields.track !== undefined ? { track: fields.track } : {}),
	};
}

// ─── MusicBrainz metadata search (pure) ──────────────────────────────────────
//
// These mirror the segment editor's metadata.ts helpers (buildRecordingSearch,
// youtubeItem, sidebarItems, fillActions, albumMatchActions) but operate on a
// library Track (not a SegmentDraft) and produce UpdateTrackRequest bodies
// (not EditAction[]). The shared search state machine (SearchState, reduceSearch,
// initialSearchState) + the SidebarItem view-model + toSidebarItem are reused
// directly from ../segment-editor/metadata.js — no duplication. (No runtime
// circular dependency: metadata.ts's only import from logic.ts is
// `import type { EditAction }`, erased at runtime.)

/**
 * Build the recording-search request for a track's metadata sidebar. `query`
 * is the search-box text (falling back to the track's title when blank).
 *
 * The track's `artist` is NEVER sent as a hint: for a downloaded YouTube track
 * it is the channel name (e.g. "おかもとえみ Official YouTube Channel"), which
 * MusicBrainz has no artist by, so a Lucene `artist:"<channel>"` clause
 * returns zero results. The search is title-only; the user can refine the query
 * manually in the sidebar if needed. Pure: (track, query) → request.
 */
export function buildTrackSearch(track: Track, query: string): MetadataSearchRequest {
	const q = query.trim() || track.title.trim();
	return { query: q, type: "recording" };
}

/**
 * The "Current tags" sidebar entry: the track's existing metadata. Mirrors the
 * segment editor's youtubeItem (the "Generated from YouTube" entry) but for a
 * library Track. Uses source: "youtube" so the sidebar treats it as the
 * non-fillable current entry (toUpdateRequestFromItem returns an empty body
 * for it); the library sidebar component renders it with a "Current" badge.
 * Pure: (track) → item.
 */
export function trackToCurrentItem(track: Track): SidebarItem {
	const item: SidebarItem = {
		source: "youtube",
		title: track.title,
		artist: track.artist,
		album: track.album,
	};
	if (track.track !== undefined) item.trackNumber = track.track;
	return item;
}

/**
 * The full sidebar list for a track: the "Current tags" entry first, then the
 * MB recording-search results in the backend's relevance order. Mirrors
 * sidebarItems from metadata.ts. Pure: (track, results) → items.
 */
export function trackSidebarItems(track: Track, results: MetadataResult[]): SidebarItem[] {
	return [trackToCurrentItem(track), ...results.map(toSidebarItem)];
}

/**
 * Build a PATCH /api/library/:id body (UpdateTrackRequest) from a clicked
 * sidebar item. The "Current tags" entry (source: "youtube") produces an empty
 * body (no-op); an MB result sets title + artist always, album + track only
 * when the result actually carries them. When the result has a Cover Art
 * Archive `artUrl`, it is included so the backend downloads + embeds the
 * front cover. Mirrors fillActions from metadata.ts but produces an
 * UpdateTrackRequest (a PATCH body) instead of EditAction[] (in-memory draft
 * edits). Pure: (item) → request.
 */
export function toUpdateRequestFromItem(item: SidebarItem): UpdateTrackRequest {
	if (item.source === "youtube") return {}; // no-op — current tags
	const req: UpdateTrackRequest = {
		title: item.title,
		artist: item.artist,
	};
	if (item.album !== undefined) req.album = item.album;
	if (item.trackNumber !== undefined) req.track = item.trackNumber;
	if (item.artUrl !== undefined) req.artUrl = item.artUrl;
	return req;
}

// ─── Match Album (pure) ──────────────────────────────────────────────────────

/**
 * Convert library tracks to a CutDraft so the backend's match-album endpoint
 * (which expects a CutDraft) can match them against a release's track list.
 * Each track becomes a minimal SegmentDraft — only the fields the matcher uses
 * (title, artist, album, trackNumber) carry real data; albumArt/start/end/
 * removedSegments are dummies (the matcher ignores them). The segment id is
 * set to the track id, and the array order is preserved so matchResult
 * segmentIndex references align with the tracks array. Pure: (tracks) → draft.
 */
export function tracksToDraft(tracks: Track[]): CutDraft {
	const dummyArt: AlbumArtRef = { kind: "video-thumbnail" };
	return {
		sourceVideoId: "",
		sourceDuration: 0,
		globalAlbum: "",
		globalArtist: "",
		globalAlbumArt: dummyArt,
		segments: tracks.map((t) => ({
			id: t.id,
			title: t.title,
			artist: t.artist,
			album: t.album,
			// SegmentDraft.trackNumber is a required number; Track.track is
			// optional. Default to 0 (the matcher uses segmentIndex for
			// position matching, not trackNumber).
			trackNumber: t.track ?? 0,
			albumArt: dummyArt,
			start: 0,
			end: t.duration,
			removedSegments: [],
		})),
	};
}

/**
 * Per-track update produced by an album match: the track's id + the PATCH body
 * to apply. Used by the LibraryMatchAlbumDialog's onapply callback.
 */
export interface TrackUpdate {
	id: string;
	request: UpdateTrackRequest;
}

/**
 * Convert an album match result to per-track UpdateTrackRequests. For every
 * match whose `confidence` is "position" or "title", build a PATCH body
 * setting title = track.title, artist = release.artist, album = release.title,
 * track = track.position. "none"-confidence matches are skipped (those tracks
 * are left as-is). Matches reference tracks by `segmentIndex`, which aligns
 * with the tracks array (tracksToDraft preserves order). Mirrors
 * albumMatchActions from metadata.ts but produces TrackUpdate[] instead of
 * EditAction[]. Pure: (tracks, release, matchResult) → updates.
 */
export function albumMatchToUpdates(
	tracks: Track[],
	release: ReleaseDetail,
	matchResult: AlbumMatchResult,
): TrackUpdate[] {
	const updates: TrackUpdate[] = [];
	for (const match of matchResult.matches) {
		if (match.confidence === "none") continue;
		const track = tracks[match.segmentIndex];
		if (!track) continue; // index out of range → skip defensively
		updates.push({
			id: track.id,
			request: {
				title: match.track.title,
				artist: release.artist,
				album: release.title,
				track: match.track.position,
			},
		});
	}
	return updates;
}
