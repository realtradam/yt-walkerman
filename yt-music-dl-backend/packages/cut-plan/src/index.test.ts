import type { Chapter, CutDraft, SponsorSegment, VideoInfo } from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import {
	CutPlanError,
	categoryLabel,
	computeDefaultDraft,
	computeKeepRanges,
	finalizeCutPlan,
	parseChapterTitle,
} from "./index.js";

const baseInfo: VideoInfo = {
	id: "7yzGBaiAMfw",
	title: "2 Mello - PHD - PORTABLE HEADPHONE DANCEFLOOR - Full Album (OFFICIAL)",
	uploader: "2 Mello",
	duration: 1795,
	thumbnail: "https://i.ytimg.com/vi/7yzGBaiAMfw/maxresdefault.jpg",
	webpageUrl: "https://www.youtube.com/watch?v=7yzGBaiAMfw",
};

// Real chapters from the test video (https://youtu.be/7yzGBaiAMfw).
const realChapters: Chapter[] = [
	{ title: "rainy nite rhapsody", startTime: 0, endTime: 291 },
	{ title: "bad flute", startTime: 291, endTime: 578 },
	{ title: "that's just it", startTime: 578, endTime: 818 },
	{ title: "who that!", startTime: 818, endTime: 1104 },
	{ title: "dreamin + meant2b", startTime: 1104, endTime: 1354 },
	{ title: "last chance 2nite", startTime: 1354, endTime: 1587 },
	{ title: "we luv to bounce", startTime: 1587, endTime: 1795 },
];

// ─── parseChapterTitle ──────────────────────────────────────────────────────

describe("parseChapterTitle (pure)", () => {
	it("extracts an 'Artist - Song' prefix", () => {
		expect(parseChapterTitle("Rick Astley - Never Gonna Give You Up")).toEqual({
			artist: "Rick Astley",
			track: "Never Gonna Give You Up",
		});
	});

	it("strips a leading track number '01. '", () => {
		expect(parseChapterTitle("01. Song Name")).toEqual({
			track: "Song Name",
			trackNumber: 1,
		});
	});

	it("strips a leading track number '01 - '", () => {
		expect(parseChapterTitle("01 - Song Name")).toEqual({
			track: "Song Name",
			trackNumber: 1,
		});
	});

	it("handles 'Artist - 01. Song Name'", () => {
		expect(parseChapterTitle("Artist - 01. Song Name")).toEqual({
			artist: "Artist",
			track: "Song Name",
			trackNumber: 1,
		});
	});

	it("strips trailing '(Official Audio)'", () => {
		expect(parseChapterTitle("Song Name (Official Audio)")).toEqual({
			track: "Song Name",
		});
	});

	it("strips a leading chapter timestamp '00:00 '", () => {
		expect(parseChapterTitle("00:00 Song Name")).toEqual({
			track: "Song Name",
		});
	});

	it("strips a longer timestamp '1:02:30 '", () => {
		expect(parseChapterTitle("1:02:30 Song Name")).toEqual({
			track: "Song Name",
		});
	});

	it("strips multiple trailing parentheticals", () => {
		expect(parseChapterTitle("Song Name (Official Audio) [HD]")).toEqual({
			track: "Song Name",
		});
	});

	it("handles '(01) Song Name'", () => {
		expect(parseChapterTitle("(01) Song Name")).toEqual({
			track: "Song Name",
			trackNumber: 1,
		});
	});

	it("handles the full messy pattern", () => {
		expect(parseChapterTitle("Artist - 03. Song Name (Official Audio)")).toEqual({
			artist: "Artist",
			track: "Song Name",
			trackNumber: 3,
		});
	});

	it("parses the real chapter titles from the test video", () => {
		expect(parseChapterTitle("rainy nite rhapsody")).toEqual({
			track: "rainy nite rhapsody",
		});
		expect(parseChapterTitle("dreamin + meant2b")).toEqual({
			track: "dreamin + meant2b",
		});
		expect(parseChapterTitle("who that!")).toEqual({ track: "who that!" });
	});

	it("splits on the first ' - ' keeping the rest as the track", () => {
		expect(parseChapterTitle("Artist - Song - Subtitle")).toEqual({
			artist: "Artist",
			track: "Song - Subtitle",
		});
	});

	it("does not treat a bare title as having an artist", () => {
		const r = parseChapterTitle("just a song");
		expect(r.artist).toBeUndefined();
		expect(r.track).toBe("just a song");
	});

	it("returns the original when everything is stripped away", () => {
		const r = parseChapterTitle("(Official Audio)");
		expect(r.track.length).toBeGreaterThan(0);
	});
});

// ─── computeKeepRanges ───────────────────────────────────────────────────────

describe("computeKeepRanges (pure)", () => {
	const chapter = { start: 100, end: 300 };

	it("returns the whole chapter when there are no segments", () => {
		expect(computeKeepRanges(chapter, [])).toEqual([{ start: 100, end: 300 }]);
	});

	it("splits into two ranges when one segment is fully inside", () => {
		expect(computeKeepRanges(chapter, [{ start: 150, end: 200 }])).toEqual([
			{ start: 100, end: 150 },
			{ start: 200, end: 300 },
		]);
	});

	it("clips a segment straddling the left boundary to one range", () => {
		expect(computeKeepRanges(chapter, [{ start: 0, end: 150 }])).toEqual([
			{ start: 150, end: 300 },
		]);
	});

	it("clips a segment straddling the right boundary to one range", () => {
		expect(computeKeepRanges(chapter, [{ start: 250, end: 400 }])).toEqual([
			{ start: 100, end: 250 },
		]);
	});

	it("clips a segment covering the whole chapter to no ranges", () => {
		expect(computeKeepRanges(chapter, [{ start: 0, end: 400 }])).toEqual([]);
	});

	it("merges adjacent/overlapping segments into one gap", () => {
		expect(
			computeKeepRanges(chapter, [
				{ start: 150, end: 175 },
				{ start: 170, end: 200 },
			]),
		).toEqual([
			{ start: 100, end: 150 },
			{ start: 200, end: 300 },
		]);
	});

	it("ignores segments outside the chapter entirely", () => {
		expect(
			computeKeepRanges(chapter, [
				{ start: 0, end: 50 },
				{ start: 350, end: 400 },
			]),
		).toEqual([{ start: 100, end: 300 }]);
	});

	it("handles a segment touching both boundaries as a no-keep", () => {
		expect(computeKeepRanges(chapter, [{ start: 100, end: 300 }])).toEqual([]);
	});

	it("handles multiple internal segments", () => {
		expect(
			computeKeepRanges(chapter, [
				{ start: 130, end: 150 },
				{ start: 200, end: 230 },
			]),
		).toEqual([
			{ start: 100, end: 130 },
			{ start: 150, end: 200 },
			{ start: 230, end: 300 },
		]);
	});

	it("returns empty for a zero-length chapter", () => {
		expect(computeKeepRanges({ start: 100, end: 100 }, [])).toEqual([]);
	});

	it("merges exactly-touching adjacent segments into one gap", () => {
		// [150,175] + [175,200] touch at 175 → one merged gap [150,200]
		expect(
			computeKeepRanges(chapter, [
				{ start: 150, end: 175 },
				{ start: 175, end: 200 },
			]),
		).toEqual([
			{ start: 100, end: 150 },
			{ start: 200, end: 300 },
		]);
	});

	it("returns [] when multiple segments together cover the whole chapter", () => {
		expect(
			computeKeepRanges(chapter, [
				{ start: 100, end: 200 },
				{ start: 200, end: 300 },
			]),
		).toEqual([]);
	});

	it("drops a zero-length segment (start == end)", () => {
		expect(computeKeepRanges(chapter, [{ start: 150, end: 150 }])).toEqual([
			{ start: 100, end: 300 },
		]);
	});

	it("handles unsorted input segments (sorts internally)", () => {
		expect(
			computeKeepRanges(chapter, [
				{ start: 200, end: 230 },
				{ start: 130, end: 150 },
			]),
		).toEqual([
			{ start: 100, end: 130 },
			{ start: 150, end: 200 },
			{ start: 230, end: 300 },
		]);
	});

	it("handles a segment at the chapter start ending inside", () => {
		expect(computeKeepRanges(chapter, [{ start: 100, end: 150 }])).toEqual([
			{ start: 150, end: 300 },
		]);
	});

	it("handles a segment at the chapter end starting inside", () => {
		expect(computeKeepRanges(chapter, [{ start: 250, end: 300 }])).toEqual([
			{ start: 100, end: 250 },
		]);
	});
});

// ─── categoryLabel ───────────────────────────────────────────────────────────

describe("categoryLabel (pure)", () => {
	it("labels each known category", () => {
		expect(categoryLabel("sponsor")).toBe("Sponsor");
		expect(categoryLabel("music_offtopic")).toBe("Non-music");
		expect(categoryLabel("intro")).toBe("Intro");
		expect(categoryLabel("manual")).toBe("Manual cut");
	});
});

// ─── computeDefaultDraft ─────────────────────────────────────────────────────

describe("computeDefaultDraft (pure)", () => {
	it("produces one segment per chapter with parsed titles", () => {
		const draft = computeDefaultDraft(baseInfo, realChapters, []);
		expect(draft.segments).toHaveLength(7);
		expect(draft.segments[0]).toMatchObject({
			title: "rainy nite rhapsody",
			artist: "2 Mello",
			album: "2 Mello",
			trackNumber: 1,
			start: 0,
			end: 291,
		});
		expect(draft.segments[6]?.trackNumber).toBe(7);
	});

	it("defaults album art to the video thumbnail", () => {
		const draft = computeDefaultDraft(baseInfo, realChapters, []);
		expect(draft.segments[0]?.albumArt).toEqual({ kind: "video-thumbnail" });
		expect(draft.globalAlbumArt).toEqual({ kind: "video-thumbnail" });
	});

	it("sets source video id + duration for the timeline", () => {
		const draft = computeDefaultDraft(baseInfo, realChapters, []);
		expect(draft.sourceVideoId).toBe("7yzGBaiAMfw");
		expect(draft.sourceDuration).toBe(1795);
	});

	it("falls back to one whole-video segment when there are no chapters", () => {
		const draft = computeDefaultDraft(baseInfo, [], []);
		expect(draft.segments).toHaveLength(1);
		expect(draft.segments[0]).toMatchObject({
			title: baseInfo.title,
			start: 0,
			end: 1795,
		});
	});

	it("parses artist + track number from messy chapter titles", () => {
		const messy: Chapter[] = [
			{
				title: "Rick Astley - 01. Never Gonna Give You Up (Official Audio)",
				startTime: 0,
				endTime: 213,
			},
		];
		const draft = computeDefaultDraft(baseInfo, messy, []);
		expect(draft.segments[0]).toMatchObject({
			artist: "Rick Astley",
			title: "Never Gonna Give You Up",
			trackNumber: 1,
		});
	});

	it("pre-flags overlapping sponsor segments as removed (enabled: true)", () => {
		const sponsors: SponsorSegment[] = [
			{ start: 50, end: 60, category: "sponsor", uuid: "s1" },
			{ start: 400, end: 420, category: "music_offtopic", uuid: "s2" },
			// outside all chapters — should not appear anywhere
			{ start: 5000, end: 5100, category: "intro", uuid: "s3" },
		];
		const draft = computeDefaultDraft(baseInfo, realChapters, sponsors);
		// First chapter [0,291] overlaps s1 only.
		const seg0 = draft.segments[0];
		expect(seg0?.removedSegments).toHaveLength(1);
		expect(seg0?.removedSegments[0]).toMatchObject({
			uuid: "s1",
			category: "sponsor",
			enabled: true,
			label: "Sponsor",
		});
		// Second chapter [291,578] overlaps s2 only.
		const seg1 = draft.segments[1];
		expect(seg1?.removedSegments).toHaveLength(1);
		expect(seg1?.removedSegments[0]).toMatchObject({
			uuid: "s2",
			category: "music_offtopic",
			enabled: true,
			label: "Non-music",
		});
		// s3 overlaps nothing.
		const others = draft.segments.slice(2).flatMap((s) => s.removedSegments);
		expect(others).toHaveLength(0);
	});
});

// ─── finalizeCutPlan ─────────────────────────────────────────────────────────

function draftFrom(
	segments: Array<{
		title: string;
		start: number;
		end: number;
		removed?: Array<{ start: number; end: number; enabled: boolean }>;
	}>,
): CutDraft {
	return {
		sourceVideoId: "x",
		sourceDuration: 1000,
		globalAlbum: "GA",
		globalArtist: "GArt",
		globalAlbumArt: { kind: "video-thumbnail" },
		segments: segments.map((s, i) => ({
			id: `seg-${i}`,
			title: s.title,
			artist: "",
			album: "",
			trackNumber: i + 1,
			albumArt: { kind: "video-thumbnail" },
			start: s.start,
			end: s.end,
			removedSegments:
				s.removed?.map((r, j) => ({
					uuid: `r${i}-${j}`,
					start: r.start,
					end: r.end,
					category: "sponsor" as const,
					enabled: r.enabled,
					label: "Sponsor",
				})) ?? [],
		})),
	};
}

describe("finalizeCutPlan (pure)", () => {
	it("derives keep-ranges from a clean two-segment draft", () => {
		const draft = draftFrom([
			{ title: "A", start: 0, end: 100 },
			{ title: "B", start: 100, end: 200 },
		]);
		const plan = finalizeCutPlan(draft);
		expect(plan.segments).toHaveLength(2);
		expect(plan.segments[0]?.keepRanges).toEqual([{ start: 0, end: 100 }]);
		expect(plan.segments[1]?.keepRanges).toEqual([{ start: 100, end: 200 }]);
	});

	it("applies global album/artist when the segment fields are blank", () => {
		const draft = draftFrom([{ title: "A", start: 0, end: 100 }]);
		const plan = finalizeCutPlan(draft);
		expect(plan.segments[0]?.album).toBe("GA");
		expect(plan.segments[0]?.artist).toBe("GArt");
	});

	it("computes two keep-ranges when a removed segment is enabled", () => {
		const draft = draftFrom([
			{
				title: "A",
				start: 0,
				end: 100,
				removed: [{ start: 30, end: 50, enabled: true }],
			},
		]);
		const plan = finalizeCutPlan(draft);
		expect(plan.segments[0]?.keepRanges).toEqual([
			{ start: 0, end: 30 },
			{ start: 50, end: 100 },
		]);
	});

	it("keeps the whole segment when removed segments are disabled", () => {
		const draft = draftFrom([
			{
				title: "A",
				start: 0,
				end: 100,
				removed: [{ start: 30, end: 50, enabled: false }],
			},
		]);
		const plan = finalizeCutPlan(draft);
		expect(plan.segments[0]?.keepRanges).toEqual([{ start: 0, end: 100 }]);
	});

	it("allows touching segments (end == next start)", () => {
		const draft = draftFrom([
			{ title: "A", start: 0, end: 100 },
			{ title: "B", start: 100, end: 200 },
		]);
		expect(() => finalizeCutPlan(draft)).not.toThrow();
	});

	it("throws CutPlanError on overlapping segments", () => {
		const draft = draftFrom([
			{ title: "A", start: 0, end: 150 },
			{ title: "B", start: 100, end: 200 },
		]);
		expect(() => finalizeCutPlan(draft)).toThrow(CutPlanError);
		expect(() => finalizeCutPlan(draft)).toThrow(/overlap/);
	});

	it("throws CutPlanError when a segment has nothing to keep", () => {
		const draft = draftFrom([
			{
				title: "A",
				start: 0,
				end: 100,
				removed: [{ start: 0, end: 100, enabled: true }],
			},
		]);
		expect(() => finalizeCutPlan(draft)).toThrow(CutPlanError);
		expect(() => finalizeCutPlan(draft)).toThrow(/nothing to keep/);
	});

	it("throws CutPlanError on an empty draft", () => {
		const draft: CutDraft = {
			sourceVideoId: "x",
			sourceDuration: 0,
			globalAlbum: "",
			globalArtist: "",
			globalAlbumArt: { kind: "video-thumbnail" },
			segments: [],
		};
		expect(() => finalizeCutPlan(draft)).toThrow(CutPlanError);
	});

	it("round-trips the real test-video draft through finalization", () => {
		const draft = computeDefaultDraft(baseInfo, realChapters, []);
		const plan = finalizeCutPlan(draft);
		expect(plan.segments).toHaveLength(7);
		// Each real chapter → one keep range == the chapter bounds.
		for (const [i, seg] of plan.segments.entries()) {
			const ch = realChapters[i];
			expect(seg.keepRanges).toEqual([{ start: ch?.startTime, end: ch?.endTime }]);
		}
	});
});

// ─── SponsorBlock → cut-plan pipeline (end-to-end) ───────────────────────────

describe("SponsorBlock → computeDefaultDraft → finalizeCutPlan (pure pipeline)", () => {
	it("round-trips a draft WITH sponsor segments to correct keep-ranges", () => {
		// Sponsor inside chapter 1 [0,291], non-music inside chapter 2 [291,578].
		const sponsors: SponsorSegment[] = [
			{ start: 50, end: 60, category: "sponsor", uuid: "s1" },
			{ start: 400, end: 420, category: "music_offtopic", uuid: "s2" },
		];
		const draft = computeDefaultDraft(baseInfo, realChapters, sponsors);
		const plan = finalizeCutPlan(draft);

		// Chapter 1: [0,291] minus [50,60] → [0,50] + [60,291]
		expect(plan.segments[0]?.keepRanges).toEqual([
			{ start: 0, end: 50 },
			{ start: 60, end: 291 },
		]);
		// Chapter 2: [291,578] minus [400,420] → [291,400] + [420,578]
		expect(plan.segments[1]?.keepRanges).toEqual([
			{ start: 291, end: 400 },
			{ start: 420, end: 578 },
		]);
		// Chapters 3-7 have no sponsors → one keep range == chapter bounds.
		expect(plan.segments[2]?.keepRanges).toEqual([{ start: 578, end: 818 }]);
	});

	it("a sponsor spanning a chapter boundary appears in both chapters, clipped", () => {
		// A sponsor [250, 350] spans the boundary between chapter 1 [0,291] and
		// chapter 2 [291,578]. computeDefaultDraft flags it in BOTH chapters;
		// finalizeCutPlan clips it to each chapter's bounds via computeKeepRanges.
		const sponsors: SponsorSegment[] = [
			{ start: 250, end: 350, category: "sponsor", uuid: "span1" },
		];
		const draft = computeDefaultDraft(baseInfo, realChapters, sponsors);

		// Both chapters see the boundary-spanning segment.
		expect(draft.segments[0]?.removedSegments).toHaveLength(1);
		expect(draft.segments[0]?.removedSegments[0]?.uuid).toBe("span1");
		expect(draft.segments[1]?.removedSegments).toHaveLength(1);
		expect(draft.segments[1]?.removedSegments[0]?.uuid).toBe("span1");

		const plan = finalizeCutPlan(draft);
		// Chapter 1: [0,291] minus [250,291] (clipped) → [0,250]
		expect(plan.segments[0]?.keepRanges).toEqual([{ start: 0, end: 250 }]);
		// Chapter 2: [291,578] minus [291,350] (clipped) → [350,578]
		expect(plan.segments[1]?.keepRanges).toEqual([{ start: 350, end: 578 }]);
	});

	it("a disabled removed segment is kept (not cut)", () => {
		const sponsors: SponsorSegment[] = [{ start: 50, end: 60, category: "sponsor", uuid: "s1" }];
		const draft = computeDefaultDraft(baseInfo, realChapters, sponsors);
		// User toggles the sponsor OFF (wants to keep it).
		const seg0 = draft.segments[0];
		expect(seg0).toBeDefined();
		const removed0 = seg0?.removedSegments[0];
		expect(removed0).toBeDefined();
		if (seg0 && removed0) removed0.enabled = false;

		const plan = finalizeCutPlan(draft);
		// The whole chapter is kept — the disabled segment is not removed.
		expect(plan.segments[0]?.keepRanges).toEqual([{ start: 0, end: 291 }]);
	});

	it("a video with no sponsor segments produces a clean draft with no removedSegments", () => {
		const draft = computeDefaultDraft(baseInfo, realChapters, []);
		const plan = finalizeCutPlan(draft);
		expect(plan.segments).toHaveLength(7);
		for (const seg of plan.segments) {
			expect(seg.keepRanges).toHaveLength(1);
		}
		for (const seg of draft.segments) {
			expect(seg.removedSegments).toHaveLength(0);
		}
	});

	it("all default-removed categories are enabled, filler is not", () => {
		// filler is NOT in REMOVED_BY_DEFAULT — it's aggressive/optional.
		const sponsors: SponsorSegment[] = [
			{ start: 10, end: 20, category: "sponsor", uuid: "a" },
			{ start: 30, end: 40, category: "selfpromo", uuid: "b" },
			{ start: 50, end: 55, category: "interaction", uuid: "c" },
			{ start: 60, end: 70, category: "intro", uuid: "d" },
			{ start: 80, end: 90, category: "outro", uuid: "e" },
			{ start: 100, end: 110, category: "music_offtopic", uuid: "f" },
			{ start: 120, end: 130, category: "preview", uuid: "g" },
			{ start: 140, end: 150, category: "filler", uuid: "h" },
		];
		// Use one big chapter so all segments overlap it.
		const chapters: Chapter[] = [{ title: "Whole", startTime: 0, endTime: 200 }];
		const draft = computeDefaultDraft(baseInfo, chapters, sponsors);
		const removed = draft.segments[0]?.removedSegments ?? [];
		// All 8 appear in the draft (they overlap); filler defaults to disabled.
		expect(removed).toHaveLength(8);
		for (const r of removed) {
			if (r.category === "filler") {
				expect(r.enabled).toBe(false);
			} else {
				expect(r.enabled).toBe(true);
			}
		}
	});
});
