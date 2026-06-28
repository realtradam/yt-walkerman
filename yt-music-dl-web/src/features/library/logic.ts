/**
 * src/features/library/logic.ts — PURE: library view-model + rename reducers.
 *
 * No DOM, no fetch, no WebSocket — pure (input → output). Unit-tested with
 * zero mocks (dispatch "pure core" principle). The Svelte component is a thin
 * wrapper over this: it fetches the raw `Track[]` (via the injected adapter),
 * derives a display model here, and builds rename PATCH bodies via
 * `toUpdateRequest` (only changed fields) / applies them optimistically via
 * `updateTrack`.
 */
import type { Track, UpdateTrackRequest } from "@yt-music/contract";

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
