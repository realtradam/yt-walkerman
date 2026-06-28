/**
 * @yt-music/cut-plan — PURE CORE.
 *
 * The decision logic for album splitting: chapter-title parsing, default-draft
 * computation, keep-range interval math, and final-cut-plan derivation. Pure
 * `input → output` with ZERO I/O (no fs, no sqlite, no subprocess, no network).
 * Fully unit-tested with zero mocks (a test that mocks our own module is a
 * DESIGN BUG — see AGENTS.md).
 *
 * The ffmpeg executor (@yt-music/cutter) and the SponsorBlock fetch
 * (@yt-music/sponsorblock) are the injected effects that consume this core's
 * output. See .research/06 + .research/07.
 */
import type {
	AlbumArtRef,
	Chapter,
	CutDraft,
	CutPlan,
	CutSegment,
	KeepRange,
	SponsorCategory,
	SponsorSegment,
	VideoInfo,
} from "@yt-music/contract";

// ─── Chapter-title parsing ───────────────────────────────────────────────────

/** Result of parsing a raw YouTube chapter title into structured fields. */
export interface ParsedTitle {
	artist?: string | undefined;
	track: string;
	trackNumber?: number | undefined;
}

/**
 * Clean a messy YouTube chapter title into structured fields.
 *
 * Handles the common album-video patterns (see .research/06):
 *   "Artist - Song Name"            → { artist: "Artist", track: "Song Name" }
 *   "01. Song Name"                 → { track: "Song Name", trackNumber: 1 }
 *   "Artist - 01. Song Name"        → { artist, track, trackNumber }
 *   "Song Name (Official Audio)"    → { track: "Song Name" }
 *   "00:00 Song Name"               → { track: "Song Name" }
 *
 * Pure: (raw) → ParsedTitle. Strips leading timestamps, leading track numbers,
 * an "Artist - " prefix, and trailing parentheticals/brackets.
 */
export function parseChapterTitle(raw: string): ParsedTitle {
	let s = raw.trim();

	// 1. Strip a leading chapter timestamp like "00:00 " or "1:02:30 ".
	s = s.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, "");

	// 2. Split on the first " - " to detect an artist prefix.
	let artist: string | undefined;
	let trackNumber: number | undefined;
	const dashIdx = s.indexOf(" - ");
	if (dashIdx >= 0) {
		const left = s.slice(0, dashIdx).trim();
		const right = s.slice(dashIdx + 3).trim();
		if (/^\d{1,3}$/.test(left)) {
			// "01 - Song" → left is a track number, not an artist.
			trackNumber = Number.parseInt(left, 10);
			s = right;
		} else if (left.length > 0) {
			artist = left;
			s = right;
		}
	}

	// 3. Strip a leading track number: "01. ", "01 - ", "01: ", "(01) ", "[01] ".
	// Bracketed numbers may be followed by just a space; bare numbers require a
	// separator (".", "-", ":") so a title like "10 Years" is not misparsed.
	const numMatch =
		s.match(/^\(\s*(\d{1,3})\s*\)\s+/) ??
		s.match(/^\[\s*(\d{1,3})\s*\]\s+/) ??
		s.match(/^(\d{1,3})\s*[.\-:]\s+/);
	if (numMatch && trackNumber === undefined) {
		trackNumber = Number.parseInt(numMatch[1] ?? "", 10);
		s = s.slice(numMatch[0].length);
	}

	// 4. Strip trailing parentheticals/brackets: "(Official Audio)", "[HD]", ... .
	// Repeat to peel multiple suffixes.
	for (let i = 0; i < 4; i++) {
		const before = s;
		s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
		s = s.replace(/\s*\[[^\]]*]\s*$/, "").trim();
		if (s === before) break;
	}
	s = s.trim();

	// Fall back to the (timestamp-stripped) original if everything was stripped.
	const fallback = raw
		.trim()
		.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, "")
		.trim();
	if (s.length === 0) s = fallback;

	const result: ParsedTitle = { track: s };
	if (artist !== undefined) result.artist = artist;
	if (trackNumber !== undefined && Number.isFinite(trackNumber)) {
		result.trackNumber = trackNumber;
	}
	return result;
}

// ─── Keep-range interval math ────────────────────────────────────────────────

/**
 * Given a chapter's (or segment's) time range and the sponsor segments that
 * overlap it, compute the sub-ranges to KEEP (the gaps between removed
 * segments). Pure interval subtraction: chapter minus segments.
 *
 * Segments outside the chapter are ignored; segments straddling a boundary are
 * clipped to the chapter. Adjacent/overlapping segments are merged first.
 */
export function computeKeepRanges(
	chapter: { start: number; end: number },
	segments: { start: number; end: number }[],
): KeepRange[] {
	const { start: cStart, end: cEnd } = chapter;
	if (cEnd <= cStart) return [];

	// Clip each segment to the chapter bounds, drop non-overlapping ones.
	const clipped: { start: number; end: number }[] = [];
	for (const seg of segments) {
		const s = Math.max(seg.start, cStart);
		const e = Math.min(seg.end, cEnd);
		if (e > s) clipped.push({ start: s, end: e });
	}
	if (clipped.length === 0) return [{ start: cStart, end: cEnd }];

	// Sort by start, then merge overlapping/adjacent.
	clipped.sort((a, b) => a.start - b.start);
	const merged: { start: number; end: number }[] = [];
	for (const seg of clipped) {
		const last = merged.at(-1);
		if (last && seg.start <= last.end) {
			last.end = Math.max(last.end, seg.end);
		} else {
			merged.push({ start: seg.start, end: seg.end });
		}
	}

	// Keep ranges = the gaps between merged segments within [cStart, cEnd].
	const keep: KeepRange[] = [];
	let cursor = cStart;
	for (const seg of merged) {
		if (seg.start > cursor) keep.push({ start: cursor, end: seg.start });
		cursor = Math.max(cursor, seg.end);
	}
	if (cursor < cEnd) keep.push({ start: cursor, end: cEnd });
	return keep;
}

// ─── Category labels ─────────────────────────────────────────────────────────

/**
 * Human-readable label for a sponsor category (or "manual" cut points).
 * Pure: (category) → label.
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
			return "Manual cut";
		default: {
			const _exhaustive: never = category;
			return String(_exhaustive);
		}
	}
}

// ─── Default draft ───────────────────────────────────────────────────────────

/** Categories that default to being removed (enabled: true) for a music app. */
const REMOVED_BY_DEFAULT: ReadonlySet<SponsorCategory> = new Set([
	"sponsor",
	"selfpromo",
	"interaction",
	"intro",
	"outro",
	"music_offtopic",
	"preview",
]);

/**
 * Produce sensible default SegmentDrafts from a video's chapters + sponsor
 * segments: one segment per chapter (or one for the whole video if no
 * chapters), parsed titles, uploader as artist, video thumbnail as album art,
 * track numbers from index, and any overlapping sponsor segments pre-flagged
 * for removal (enabled: true).
 *
 * Pure: (info, chapters, sponsorSegments) → CutDraft.
 */
export function computeDefaultDraft(
	info: VideoInfo,
	chapters: Chapter[],
	sponsorSegments: SponsorSegment[],
): CutDraft {
	const videoArt: AlbumArtRef = { kind: "video-thumbnail" };
	const globalArtist = info.uploader;

	const chs: { title: string; startTime: number; endTime: number }[] =
		chapters.length > 0 ? chapters : [{ title: info.title, startTime: 0, endTime: info.duration }];

	const segments = chs.map((ch, i) => {
		// Only chapter titles get the messy-title parser; the whole-video
		// fallback uses the raw video title verbatim.
		const parsed = chapters.length > 0 ? parseChapterTitle(ch.title) : { track: ch.title };
		const overlapping = sponsorSegments.filter(
			(seg) => seg.end > ch.startTime && seg.start < ch.endTime,
		);
		const removedSegments = overlapping.map((seg) => ({
			uuid: seg.uuid,
			start: seg.start,
			end: seg.end,
			category: seg.category,
			enabled: REMOVED_BY_DEFAULT.has(seg.category),
			label: categoryLabel(seg.category),
		}));
		return {
			id: `seg-${i}`,
			title: parsed.track.length > 0 ? parsed.track : ch.title,
			artist: parsed.artist ?? info.uploader,
			album: info.uploader,
			trackNumber: parsed.trackNumber ?? i + 1,
			albumArt: videoArt,
			start: ch.startTime,
			end: ch.endTime,
			removedSegments,
		};
	});

	return {
		sourceVideoId: info.id,
		sourceDuration: info.duration,
		segments,
		globalAlbum: info.uploader,
		globalAlbumArt: videoArt,
		globalArtist,
	};
}

// ─── Finalize the cut plan ───────────────────────────────────────────────────

/** Error thrown when a confirmed CutDraft cannot be turned into a valid plan. */
export class CutPlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CutPlanError";
	}
}

/**
 * Resolve the user-confirmed CutDraft into a finalized, validated CutPlan:
 * applies global-field fallbacks, computes the final keep-ranges per segment
 * from its enabled removedSegments, and validates that segments are
 * non-overlapping and each has at least one keep-range.
 *
 * Pure: (draft) → CutPlan. Throws CutPlanError on an invalid plan.
 */
export function finalizeCutPlan(draft: CutDraft): CutPlan {
	if (draft.segments.length === 0) {
		throw new CutPlanError("cut plan has no segments");
	}

	// Validate non-overlapping segment boundaries (touching is allowed:
	// end == next start is fine; only start < prev end is an error).
	const sorted = [...draft.segments].sort((a, b) => a.start - b.start);
	let prev: CutDraft["segments"][number] | null = null;
	for (const cur of sorted) {
		if (prev !== null && cur.start < prev.end) {
			throw new CutPlanError("segments overlap — fix boundaries before cutting");
		}
		prev = cur;
	}

	// Resolve global-field fallbacks + compute final keep-ranges per segment.
	const cutSegments: CutSegment[] = [];
	for (const seg of draft.segments) {
		const artist = seg.artist.trim() || draft.globalArtist.trim();
		const album = seg.album.trim() || draft.globalAlbum.trim();
		const removed = seg.removedSegments.filter((r) => r.enabled);
		const keepRanges = computeKeepRanges(
			{ start: seg.start, end: seg.end },
			removed.map((r) => ({ start: r.start, end: r.end })),
		);
		if (keepRanges.length === 0) {
			throw new CutPlanError(`segment "${seg.title}" has nothing to keep (all ranges removed)`);
		}
		cutSegments.push({
			title: seg.title,
			artist,
			album,
			trackNumber: seg.trackNumber,
			albumArt: seg.albumArt,
			keepRanges,
		});
	}

	return { segments: cutSegments };
}
