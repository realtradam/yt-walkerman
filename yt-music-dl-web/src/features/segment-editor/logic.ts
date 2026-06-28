/**
 * src/features/segment-editor/logic.ts — PURE: CutDraft edit reducers.
 *
 * The segment editor (GLOSSARY: "the FE feature module that renders the
 * CutDraft timeline and applies the pure edit reducers") is a thin Svelte
 * component over THIS module. Everything here is pure `(draft, action) → draft`
 * with zero DOM / fetch / WebSocket / Svelte — unit-tested with no mocks
 * (dispatch "pure core" principle).
 *
 * New entities (segments / removed-segments) need unique ids. Id generation is
 * a side-effect (RNG), so the reducer never mints ids itself: actions that
 * create entities CARRY the new id, minted by the caller (the component uses
 * `crypto.randomUUID()`). This keeps the reducer pure + deterministic + testable.
 */
import type {
	AlbumArtRef,
	CutDraft,
	RemovedSegmentDraft,
	SegmentDraft,
	SponsorCategory,
} from "@yt-music/contract";
import { formatDuration } from "../library/logic.js";

// ─── Actions ────────────────────────────────────────────────────────────────

/**
 * The discriminated union of all edits the user can make to a `CutDraft`.
 * Mirrors the download feature's `reduce(state, event)` shape: one `reduce`
 * folds any action over the draft. The GLOSSARY calls these "edit reducers"
 * (`editSegmentTitle`, `addSegment`, `splitSegment`, …) — each is an action
 * variant here.
 */
export type EditAction =
	// per-segment field edits
	| { type: "editSegmentTitle"; segmentId: string; title: string }
	| { type: "editSegmentArtist"; segmentId: string; artist: string }
	| { type: "editSegmentAlbum"; segmentId: string; album: string }
	| { type: "editSegmentTrackNumber"; segmentId: string; trackNumber: number }
	| { type: "editSegmentAlbumArt"; segmentId: string; albumArt: AlbumArtRef }
	// segment lifecycle / shape
	| { type: "trimSegment"; segmentId: string; start: number; end: number }
	| { type: "addSegment"; segment: SegmentDraft; index?: number }
	| { type: "removeSegment"; segmentId: string }
	| { type: "splitSegment"; segmentId: string; at: number; newSegmentId: string }
	| { type: "mergeSegments"; firstId: string; secondId: string }
	| { type: "moveSegment"; segmentId: string; direction: "up" | "down" }
	| { type: "renumberTracks" }
	// removed (skip) segments within a song
	| { type: "toggleRemovedSegment"; segmentId: string; removedUuid: string }
	| { type: "addRemovedSegment"; segmentId: string; removed: RemovedSegmentDraft }
	| { type: "removeRemovedSegment"; segmentId: string; removedUuid: string }
	// global album/artist/art — set the global field, and apply-to-all variants
	| { type: "setGlobalAlbum"; album: string }
	| { type: "setGlobalArtist"; artist: string }
	| { type: "setGlobalAlbumArt"; albumArt: AlbumArtRef }
	| { type: "applyGlobalAlbum"; album: string }
	| { type: "applyGlobalArtist"; artist: string }
	| { type: "applyGlobalAlbumArt"; albumArt: AlbumArtRef }
	| { type: "applyAllGlobals" };

// ─── Reducer ─────────────────────────────────────────────────────────────────

/** Apply one edit to the draft. Pure: (draft, action) → draft. No-op on bad ids. */
export function reduce(draft: CutDraft, action: EditAction): CutDraft {
	switch (action.type) {
		case "editSegmentTitle":
			return mapSegment(draft, action.segmentId, (s) => ({ ...s, title: action.title }));
		case "editSegmentArtist":
			return mapSegment(draft, action.segmentId, (s) => ({ ...s, artist: action.artist }));
		case "editSegmentAlbum":
			return mapSegment(draft, action.segmentId, (s) => ({ ...s, album: action.album }));
		case "editSegmentTrackNumber":
			return mapSegment(draft, action.segmentId, (s) => ({
				...s,
				trackNumber: action.trackNumber,
			}));
		case "editSegmentAlbumArt":
			return mapSegment(draft, action.segmentId, (s) => ({ ...s, albumArt: action.albumArt }));

		case "trimSegment":
			return mapSegment(draft, action.segmentId, (s) => {
				const start = clamp(action.start, 0, draft.sourceDuration);
				const end = clamp(action.end, 0, draft.sourceDuration);
				const lo = Math.min(start, end);
				const hi = Math.max(start, end);
				if (hi <= lo) return s; // refuse zero/negative length
				// re-clamp existing skips into the new range, drop emptied ones
				const removedSegments = s.removedSegments
					.map((r) => ({ ...r, start: clamp(r.start, lo, hi), end: clamp(r.end, lo, hi) }))
					.filter((r) => r.end > r.start);
				return { ...s, start: lo, end: hi, removedSegments };
			});

		case "addSegment": {
			const at = clamp(action.index ?? draft.segments.length, 0, draft.segments.length);
			const segments = [
				...draft.segments.slice(0, at),
				action.segment,
				...draft.segments.slice(at),
			];
			return renumber({ ...draft, segments });
		}

		case "removeSegment": {
			const before = draft.segments.length;
			const segments = draft.segments.filter((s) => s.id !== action.segmentId);
			if (segments.length === before) return draft; // nothing removed → no-op
			return renumber({ ...draft, segments });
		}

		case "splitSegment": {
			const idx = draft.segments.findIndex((s) => s.id === action.segmentId);
			const seg = idx >= 0 ? draft.segments[idx] : undefined;
			if (!seg) return draft;
			const at = clamp(action.at, seg.start + 1, seg.end - 1);
			if (at <= seg.start || at >= seg.end) return draft; // too short to split
			const first: SegmentDraft = {
				...seg,
				end: at,
				removedSegments: reassignRemoved(seg.removedSegments, at).first,
			};
			const second: SegmentDraft = {
				...seg,
				id: action.newSegmentId,
				start: at,
				removedSegments: reassignRemoved(seg.removedSegments, at).second,
			};
			const segments = [
				...draft.segments.slice(0, idx),
				first,
				second,
				...draft.segments.slice(idx + 1),
			];
			return renumber({ ...draft, segments });
		}

		case "mergeSegments": {
			const i = draft.segments.findIndex((s) => s.id === action.firstId);
			const j = draft.segments.findIndex((s) => s.id === action.secondId);
			const first = i >= 0 ? draft.segments[i] : undefined;
			const second = j >= 0 ? draft.segments[j] : undefined;
			if (!first || !second || j !== i + 1) return draft; // must be adjacent
			const mergedRemoved = dedupeRemoved([
				...first.removedSegments,
				...second.removedSegments,
			]).map((r) => ({
				...r,
				start: clamp(r.start, first.start, second.end),
				end: clamp(r.end, first.start, second.end),
			}));
			const merged: SegmentDraft = {
				...first,
				end: second.end,
				removedSegments: mergedRemoved,
			};
			const segments = [...draft.segments.slice(0, i), merged, ...draft.segments.slice(j + 1)];
			return renumber({ ...draft, segments });
		}

		case "moveSegment": {
			const i = draft.segments.findIndex((s) => s.id === action.segmentId);
			if (i < 0) return draft;
			const j = action.direction === "up" ? i - 1 : i + 1;
			const a = draft.segments[i];
			const b = draft.segments[j];
			if (!a || !b) return draft;
			const segments = [...draft.segments];
			segments[i] = b;
			segments[j] = a;
			return renumber({ ...draft, segments });
		}

		case "renumberTracks":
			return renumber(draft);

		case "toggleRemovedSegment":
			return mapSegment(draft, action.segmentId, (s) => ({
				...s,
				removedSegments: s.removedSegments.map((r) =>
					r.uuid === action.removedUuid ? { ...r, enabled: !r.enabled } : r,
				),
			}));
		case "addRemovedSegment":
			return mapSegment(draft, action.segmentId, (s) => ({
				...s,
				removedSegments: [...s.removedSegments, action.removed],
			}));
		case "removeRemovedSegment":
			return mapSegment(draft, action.segmentId, (s) => ({
				...s,
				removedSegments: s.removedSegments.filter((r) => r.uuid !== action.removedUuid),
			}));

		case "setGlobalAlbum":
			return { ...draft, globalAlbum: action.album };
		case "setGlobalArtist":
			return { ...draft, globalArtist: action.artist };
		case "setGlobalAlbumArt":
			return { ...draft, globalAlbumArt: action.albumArt };
		case "applyGlobalAlbum":
			return {
				...draft,
				globalAlbum: action.album,
				segments: draft.segments.map((s) => ({ ...s, album: action.album })),
			};
		case "applyGlobalArtist":
			return {
				...draft,
				globalArtist: action.artist,
				segments: draft.segments.map((s) => ({ ...s, artist: action.artist })),
			};
		case "applyGlobalAlbumArt":
			return {
				...draft,
				globalAlbumArt: action.albumArt,
				segments: draft.segments.map((s) => ({ ...s, albumArt: action.albumArt })),
			};
		case "applyAllGlobals":
			return {
				...draft,
				segments: draft.segments.map((s) => ({
					...s,
					album: draft.globalAlbum,
					artist: draft.globalArtist,
					albumArt: draft.globalAlbumArt,
				})),
			};

		default: {
			const _exhaustive: never = action;
			return _exhaustive;
		}
	}
}

// ─── Pure helpers (internal) ─────────────────────────────────────────────────

/** Clamp `n` into `[min, max]`; if the range is inverted, returns `min`. */
function clamp(n: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.max(min, Math.min(max, n));
}

/** Renumber every segment's trackNumber to 1..N in array order. Pure. */
function renumber(draft: CutDraft): CutDraft {
	return {
		...draft,
		segments: draft.segments.map((s, i) => ({ ...s, trackNumber: i + 1 })),
	};
}

/** Replace one segment by id with the result of `fn`; unchanged draft if absent. */
function mapSegment(draft: CutDraft, id: string, fn: (s: SegmentDraft) => SegmentDraft): CutDraft {
	let found = false;
	const segments = draft.segments.map((s) => {
		if (s.id === id) {
			found = true;
			return fn(s);
		}
		return s;
	});
	return found ? { ...draft, segments } : draft;
}

/**
 * When splitting a segment at `at`, each existing skip goes to whichever half
 * contains its midpoint (clamped to that half). A straddling skip is not
 * duplicated (avoiding uuid collisions) — the user can re-add the other part.
 */
function reassignRemoved(
	removed: RemovedSegmentDraft[],
	at: number,
): { first: RemovedSegmentDraft[]; second: RemovedSegmentDraft[] } {
	const first: RemovedSegmentDraft[] = [];
	const second: RemovedSegmentDraft[] = [];
	for (const r of removed) {
		const mid = (r.start + r.end) / 2;
		if (mid < at) {
			const end = Math.min(r.end, at);
			if (end > r.start) first.push({ ...r, end });
		} else {
			const start = Math.max(r.start, at);
			if (r.end > start) second.push({ ...r, start });
		}
	}
	return { first, second };
}

/** Concatenate skips, dropping later duplicates by uuid. Pure. */
function dedupeRemoved(removed: RemovedSegmentDraft[]): RemovedSegmentDraft[] {
	const seen = new Set<string>();
	const out: RemovedSegmentDraft[] = [];
	for (const r of removed) {
		if (seen.has(r.uuid)) continue;
		seen.add(r.uuid);
		out.push(r);
	}
	return out;
}

// ─── View-model helpers (pure) ───────────────────────────────────────────────
// Pre-compute display strings so the component never formats inline.

/** Wall-clock length of the segment (seconds). Pure. */
export function segmentDuration(seg: SegmentDraft): number {
	return Math.max(0, seg.end - seg.start);
}

/** Total length of enabled skips within a segment (clamped to its range). Pure. */
export function removedDuration(seg: SegmentDraft): number {
	return seg.removedSegments
		.filter((r) => r.enabled)
		.reduce((sum, r) => {
			const lo = Math.max(r.start, seg.start);
			const hi = Math.min(r.end, seg.end);
			return sum + Math.max(0, hi - lo);
		}, 0);
}

/** Segment length minus enabled skips (the audio actually kept). Pure. */
export function effectiveDuration(seg: SegmentDraft): number {
	return Math.max(0, segmentDuration(seg) - removedDuration(seg));
}

/** `"1:05 – 3:42"` style label for the segment's time range. Pure. */
export function formatRange(seg: SegmentDraft): string {
	return `${formatDuration(seg.start)} – ${formatDuration(seg.end)}`;
}

/** `m:ss` label for the segment's effective (kept) duration. Pure. */
export function durationLabel(seg: SegmentDraft): string {
	return formatDuration(effectiveDuration(seg));
}

/** Sum of effective durations across all segments. Pure. */
export function totalDuration(draft: CutDraft): number {
	return draft.segments.reduce((sum, s) => sum + effectiveDuration(s), 0);
}

// ─── SponsorBlock category view-model (pure) ────────────────────────────────

/**
 * Human-friendly label for a removed-segment category (GLOSSARY: a
 * `RemovedSegmentDraft.category` — a `SponsorCategory` or `"manual"`). The
 * backend's SponsorBlock pipeline sets these on the skips it injects into the
 * CutDraft; the editor renders this alongside each skip. Pure.
 *
 * Mirrors the backend's own labels (Sponsor / Intro / Non-music / …) — never
 * redefines a backend term, just formats one for display.
 */
export function categoryLabel(category: SponsorCategory | "manual"): string {
	switch (category) {
		case "sponsor":
			return "Sponsor";
		case "selfpromo":
			return "Self-promo";
		case "interaction":
			return "Interaction";
		case "intro":
			return "Intro";
		case "outro":
			return "Outro";
		case "preview":
			return "Preview";
		case "music_offtopic":
			return "Non-music";
		case "filler":
			return "Filler";
		case "manual":
			return "Manual";
		default: {
			const _exhaustive: never = category;
			return _exhaustive;
		}
	}
}

/**
 * One positioned region to render on a segment's timeline bar. Pure
 * view-model: the component never does ratio math itself — it just lays these
 * out by `leftPct` / `widthPct`. `enabled` marks the skips that WILL be cut
 * (the "red/dimmed segment on the timeline" the editor highlights).
 */
export interface TimelineRegion {
	uuid: string;
	/** Left edge as a percentage of the segment's duration (0..100). */
	leftPct: number;
	/** Width as a percentage of the segment's duration (0..100). */
	widthPct: number;
	enabled: boolean;
	category: SponsorCategory | "manual";
	label: string;
}

/**
 * Compute positioned timeline regions for a segment's skips, each clamped into
 * the segment's `[start, end]` range. Pure: (segment) → regions. Skips that
 * fall entirely outside the segment are dropped; zero-length overlaps are
 * dropped. Returns `[]` for a zero/negative-length segment.
 */
export function removedRegions(seg: SegmentDraft): TimelineRegion[] {
	const dur = segmentDuration(seg);
	if (dur <= 0) return [];
	const regions: TimelineRegion[] = [];
	for (const r of seg.removedSegments) {
		const lo = Math.max(r.start, seg.start);
		const hi = Math.min(r.end, seg.end);
		if (hi <= lo) continue; // no overlap with the segment
		regions.push({
			uuid: r.uuid,
			leftPct: ((lo - seg.start) / dur) * 100,
			widthPct: ((hi - lo) / dur) * 100,
			enabled: r.enabled,
			category: r.category,
			label: r.label,
		});
	}
	return regions;
}

// ─── Factories (pure; caller supplies the id) ────────────────────────────────

/** Build a blank segment with the given id + defaults. Pure. */
export function newSegment(
	id: string,
	start: number,
	end: number,
	defaults: { artist: string; album: string; albumArt: AlbumArtRef },
): SegmentDraft {
	return {
		id,
		title: "",
		artist: defaults.artist,
		album: defaults.album,
		trackNumber: 0,
		albumArt: defaults.albumArt,
		start,
		end,
		removedSegments: [],
	};
}

/** Build a skip with the given uuid. Pure. */
export function newRemovedSegment(
	uuid: string,
	start: number,
	end: number,
	label = "Skip",
	category: SponsorCategory | "manual" = "manual",
): RemovedSegmentDraft {
	return { uuid, start, end, category, enabled: true, label };
}

// ─── Validation (pure) ───────────────────────────────────────────────────────

/** One problem found in the draft, scoped to a segment (or "" for global). */
export interface ValidationIssue {
	segmentId: string;
	message: string;
}

/**
 * Validate the draft before confirming. Returns issues (empty = valid). Pure.
 * Used to gate the Confirm button and surface per-segment problems. Does NOT
 * duplicate the backend's final CutPlan validation — it catches obvious FE
 * mistakes (empty titles, inverted/empty ranges, skips outside a segment).
 */
export function validateDraft(draft: CutDraft): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const s of draft.segments) {
		if (!s.title.trim()) {
			issues.push({ segmentId: s.id, message: "Title is empty" });
		}
		if (s.end <= s.start) {
			issues.push({ segmentId: s.id, message: "End must be after start" });
		}
		if (s.start < 0 || s.end > draft.sourceDuration) {
			issues.push({ segmentId: s.id, message: "Range is outside the source video" });
		}
		for (const r of s.removedSegments) {
			if (r.end <= r.start) {
				issues.push({ segmentId: s.id, message: `Skip "${r.label}" has an invalid range` });
			}
		}
	}
	return issues;
}
