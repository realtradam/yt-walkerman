import type {
	CutDraft,
	RemovedSegmentDraft,
	SegmentDraft,
	SponsorCategory,
} from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import {
	categoryLabel,
	durationLabel,
	effectiveDuration,
	formatRange,
	newRemovedSegment,
	newSegment,
	reduce,
	removedDuration,
	removedRegions,
	segmentDuration,
	totalDuration,
	validateDraft,
} from "./logic.js";

// ─── fixtures ────────────────────────────────────────────────────────────────
// All-required-fields objects (no Partial spreads — exactOptionalPropertyTypes
// is on). Tests spread a fresh base and override specific fields.

function baseDraft(): CutDraft {
	return {
		sourceVideoId: "vid",
		sourceDuration: 600,
		globalAlbum: "Album",
		globalArtist: "Artist",
		globalAlbumArt: { kind: "video-thumbnail" },
		segments: [seg("s1", 1, 0, 200), seg("s2", 2, 200, 400), seg("s3", 3, 400, 600)],
	};
}

function seg(
	id: string,
	track: number,
	start: number,
	end: number,
	title = id.toUpperCase(),
): SegmentDraft {
	return {
		id,
		title,
		artist: "Artist",
		album: "Album",
		trackNumber: track,
		albumArt: { kind: "video-thumbnail" },
		start,
		end,
		removedSegments: [],
	};
}

/** A SponsorBlock-category skip (the kind the backend's draft now delivers). */
function sponsSkip(
	uuid: string,
	start: number,
	end: number,
	category: SponsorCategory,
	enabled = true,
	label?: string,
): RemovedSegmentDraft {
	return {
		uuid,
		start,
		end,
		category,
		enabled,
		label: label ?? categoryLabel(category),
	};
}

describe("segment-editor logic (pure)", () => {
	describe("per-segment field edits", () => {
		it("editSegmentTitle sets the title", () => {
			const d = reduce(baseDraft(), { type: "editSegmentTitle", segmentId: "s1", title: "New" });
			expect(d.segments[0]?.title).toBe("New");
		});

		it("editSegmentArtist / Album / TrackNumber / AlbumArt update fields", () => {
			let d = reduce(baseDraft(), { type: "editSegmentArtist", segmentId: "s2", artist: "X" });
			expect(d.segments[1]?.artist).toBe("X");
			d = reduce(d, { type: "editSegmentAlbum", segmentId: "s2", album: "Y" });
			expect(d.segments[1]?.album).toBe("Y");
			d = reduce(d, { type: "editSegmentTrackNumber", segmentId: "s2", trackNumber: 99 });
			expect(d.segments[1]?.trackNumber).toBe(99);
			d = reduce(d, {
				type: "editSegmentAlbumArt",
				segmentId: "s2",
				albumArt: { kind: "url", url: "https://x/a.png" },
			});
			expect(d.segments[1]?.albumArt).toEqual({ kind: "url", url: "https://x/a.png" });
		});

		it("field edits on an unknown id are no-ops", () => {
			const d = baseDraft();
			expect(reduce(d, { type: "editSegmentTitle", segmentId: "nope", title: "x" })).toBe(d);
		});
	});

	describe("trimSegment", () => {
		it("sets the range ordered + clamped to source", () => {
			const d = reduce(baseDraft(), {
				type: "trimSegment",
				segmentId: "s1",
				start: 500,
				end: -5,
			});
			expect(d.segments[0]?.start).toBe(0);
			expect(d.segments[0]?.end).toBe(500);
		});

		it("refuses zero/negative length (no-op)", () => {
			const d = baseDraft();
			const out = reduce(d, { type: "trimSegment", segmentId: "s1", start: 100, end: 100 });
			expect(out.segments[0]?.start).toBe(0);
			expect(out.segments[0]?.end).toBe(200);
		});

		it("re-clamps existing skips into the new range and drops emptied ones", () => {
			const draft: CutDraft = {
				...baseDraft(),
				segments: [
					{
						...seg("s1", 1, 0, 200),
						removedSegments: [
							{ uuid: "k1", start: 10, end: 20, category: "manual", enabled: true, label: "a" },
							{ uuid: "k2", start: 150, end: 180, category: "manual", enabled: true, label: "b" },
						],
					},
				],
			};
			const d = reduce(draft, { type: "trimSegment", segmentId: "s1", start: 0, end: 100 });
			const rs = d.segments[0]?.removedSegments ?? [];
			expect(rs).toHaveLength(1);
			expect(rs[0]?.uuid).toBe("k1");
		});
	});

	describe("addSegment", () => {
		it("appends at the end by default and renumbers", () => {
			const extra = newSegment("s4", 600, 700, {
				artist: "A",
				album: "L",
				albumArt: { kind: "video-thumbnail" },
			});
			const d = reduce(baseDraft(), { type: "addSegment", segment: extra });
			expect(d.segments.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
			expect(d.segments[3]?.trackNumber).toBe(4);
		});

		it("inserts at an explicit index and renumbers", () => {
			const extra = newSegment("s0", 0, 1, {
				artist: "A",
				album: "L",
				albumArt: { kind: "video-thumbnail" },
			});
			const d = reduce(baseDraft(), { type: "addSegment", segment: extra, index: 0 });
			expect(d.segments.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3"]);
			expect(d.segments[0]?.trackNumber).toBe(1);
			expect(d.segments[1]?.trackNumber).toBe(2);
		});
	});

	describe("removeSegment", () => {
		it("removes by id and renumbers", () => {
			const d = reduce(baseDraft(), { type: "removeSegment", segmentId: "s2" });
			expect(d.segments.map((s) => s.id)).toEqual(["s1", "s3"]);
			expect(d.segments.map((s) => s.trackNumber)).toEqual([1, 2]);
		});

		it("unknown id is a no-op", () => {
			const d = baseDraft();
			expect(reduce(d, { type: "removeSegment", segmentId: "nope" })).toBe(d);
		});
	});

	describe("splitSegment", () => {
		it("splits at `at`, inserting a new segment after, and renumbers", () => {
			const d = reduce(baseDraft(), {
				type: "splitSegment",
				segmentId: "s2",
				at: 300,
				newSegmentId: "s2b",
			});
			expect(d.segments.map((s) => s.id)).toEqual(["s1", "s2", "s2b", "s3"]);
			expect(d.segments[1]?.start).toBe(200);
			expect(d.segments[1]?.end).toBe(300);
			expect(d.segments[2]?.start).toBe(300);
			expect(d.segments[2]?.end).toBe(400);
			expect(d.segments.map((s) => s.trackNumber)).toEqual([1, 2, 3, 4]);
		});

		it("clamps `at` into the segment", () => {
			const d = reduce(baseDraft(), {
				type: "splitSegment",
				segmentId: "s2",
				at: 9999,
				newSegmentId: "s2b",
			});
			expect(d.segments[1]?.end).toBe(399);
			expect(d.segments[2]?.start).toBe(399);
		});

		it("assigns skips to the half containing their midpoint", () => {
			const draft: CutDraft = {
				...baseDraft(),
				segments: [
					{
						...seg("s1", 1, 0, 200),
						removedSegments: [
							{ uuid: "k1", start: 10, end: 20, category: "manual", enabled: true, label: "first" },
							{
								uuid: "k2",
								start: 150,
								end: 180,
								category: "manual",
								enabled: true,
								label: "second",
							},
						],
					},
				],
			};
			const d = reduce(draft, {
				type: "splitSegment",
				segmentId: "s1",
				at: 100,
				newSegmentId: "s1b",
			});
			expect(d.segments[0]?.removedSegments.map((r) => r.uuid)).toEqual(["k1"]);
			expect(d.segments[1]?.removedSegments.map((r) => r.uuid)).toEqual(["k2"]);
		});

		it("is a no-op when the segment is too short", () => {
			const draft: CutDraft = { ...baseDraft(), segments: [seg("s1", 1, 0, 1)] };
			const d = reduce(draft, { type: "splitSegment", segmentId: "s1", at: 0, newSegmentId: "x" });
			expect(d).toBe(draft);
		});

		it("is a no-op on unknown id", () => {
			const d = baseDraft();
			expect(
				reduce(d, { type: "splitSegment", segmentId: "nope", at: 10, newSegmentId: "x" }),
			).toBe(d);
		});
	});

	describe("mergeSegments", () => {
		it("merges two adjacent segments into one spanning both, renumbers", () => {
			const d = reduce(baseDraft(), { type: "mergeSegments", firstId: "s1", secondId: "s2" });
			expect(d.segments.map((s) => s.id)).toEqual(["s1", "s3"]);
			expect(d.segments[0]?.start).toBe(0);
			expect(d.segments[0]?.end).toBe(400);
			expect(d.segments.map((s) => s.trackNumber)).toEqual([1, 2]);
		});

		it("dedupes + clamps removed segments across the merge", () => {
			const draft: CutDraft = {
				...baseDraft(),
				segments: [
					{
						...seg("s1", 1, 0, 200),
						removedSegments: [
							{ uuid: "k1", start: 10, end: 20, category: "manual", enabled: true, label: "a" },
						],
					},
					{
						...seg("s2", 2, 200, 400),
						removedSegments: [
							{ uuid: "k1", start: 10, end: 20, category: "manual", enabled: true, label: "dup" },
							{ uuid: "k2", start: 250, end: 260, category: "manual", enabled: true, label: "b" },
						],
					},
				],
			};
			const d = reduce(draft, { type: "mergeSegments", firstId: "s1", secondId: "s2" });
			const rs = d.segments[0]?.removedSegments ?? [];
			expect(rs.map((r) => r.uuid)).toEqual(["k1", "k2"]);
			// k1 was clamped from [10,20] into [0,400] (unchanged here)
			expect(rs[0]?.start).toBe(10);
		});

		it("refuses to merge non-adjacent segments", () => {
			const d = baseDraft();
			expect(reduce(d, { type: "mergeSegments", firstId: "s1", secondId: "s3" })).toBe(d);
		});

		it("refuses to merge unknown ids", () => {
			const d = baseDraft();
			expect(reduce(d, { type: "mergeSegments", firstId: "nope", secondId: "s2" })).toBe(d);
		});
	});

	describe("moveSegment", () => {
		it("moves a segment up and renumbers", () => {
			const d = reduce(baseDraft(), { type: "moveSegment", segmentId: "s2", direction: "up" });
			expect(d.segments.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);
			expect(d.segments.map((s) => s.trackNumber)).toEqual([1, 2, 3]);
		});

		it("moving the first segment up is a no-op", () => {
			const d = baseDraft();
			expect(reduce(d, { type: "moveSegment", segmentId: "s1", direction: "up" })).toBe(d);
		});

		it("moving the last segment down is a no-op", () => {
			const d = baseDraft();
			expect(reduce(d, { type: "moveSegment", segmentId: "s3", direction: "down" })).toBe(d);
		});
	});

	describe("removed (skip) segments", () => {
		const withSkip: CutDraft = {
			...baseDraft(),
			segments: [
				{
					...seg("s1", 1, 0, 200),
					removedSegments: [
						{ uuid: "k1", start: 10, end: 20, category: "manual", enabled: true, label: "Skip" },
					],
				},
			],
		};

		it("toggleRemovedSegment flips enabled", () => {
			const d = reduce(withSkip, {
				type: "toggleRemovedSegment",
				segmentId: "s1",
				removedUuid: "k1",
			});
			expect(d.segments[0]?.removedSegments[0]?.enabled).toBe(false);
		});

		it("addRemovedSegment appends", () => {
			const r = newRemovedSegment("k2", 30, 40, "Intro");
			const d = reduce(withSkip, { type: "addRemovedSegment", segmentId: "s1", removed: r });
			expect(d.segments[0]?.removedSegments.map((x) => x.uuid)).toEqual(["k1", "k2"]);
		});

		it("removeRemovedSegment filters by uuid", () => {
			const d = reduce(withSkip, {
				type: "removeRemovedSegment",
				segmentId: "s1",
				removedUuid: "k1",
			});
			expect(d.segments[0]?.removedSegments).toEqual([]);
		});

		it("skip actions on an unknown segment are no-ops", () => {
			const d = withSkip;
			expect(
				reduce(d, { type: "toggleRemovedSegment", segmentId: "nope", removedUuid: "k1" }),
			).toBe(d);
		});
	});

	describe("SponsorBlock category handling", () => {
		// The backend's split-by-chapters pipeline now injects skips with real
		// SponsorBlock categories into the CutDraft. The reducers carry `category`
		// through unchanged (they spread the skip), so a toggle must NOT drop it.

		it("toggleRemovedSegment preserves the SponsorBlock category", () => {
			const draft: CutDraft = {
				...baseDraft(),
				segments: [
					{
						...seg("s1", 1, 0, 200),
						removedSegments: [sponsSkip("k1", 10, 30, "sponsor")],
					},
				],
			};
			const d = reduce(draft, {
				type: "toggleRemovedSegment",
				segmentId: "s1",
				removedUuid: "k1",
			});
			const r = d.segments[0]?.removedSegments[0];
			expect(r?.enabled).toBe(false);
			expect(r?.category).toBe("sponsor"); // category survives the toggle
		});

		it("addRemovedSegment round-trips a SponsorBlock category", () => {
			const draft: CutDraft = { ...baseDraft(), segments: [seg("s1", 1, 0, 200)] };
			const d = reduce(draft, {
				type: "addRemovedSegment",
				segmentId: "s1",
				removed: sponsSkip("k9", 5, 15, "music_offtopic"),
			});
			const r = d.segments[0]?.removedSegments[0];
			expect(r).toMatchObject({ uuid: "k9", category: "music_offtopic", enabled: true });
		});

		it("removeRemovedSegment removes only the targeted SponsorBlock skip", () => {
			const draft: CutDraft = {
				...baseDraft(),
				segments: [
					{
						...seg("s1", 1, 0, 200),
						removedSegments: [sponsSkip("k1", 10, 20, "intro"), sponsSkip("k2", 30, 40, "outro")],
					},
				],
			};
			const d = reduce(draft, {
				type: "removeRemovedSegment",
				segmentId: "s1",
				removedUuid: "k1",
			});
			expect(d.segments[0]?.removedSegments.map((r) => r.uuid)).toEqual(["k2"]);
		});
	});

	describe("globals", () => {
		it("setGlobal* set the global field only", () => {
			let d = reduce(baseDraft(), { type: "setGlobalAlbum", album: "G1" });
			expect(d.globalAlbum).toBe("G1");
			expect(d.segments[0]?.album).toBe("Album"); // segments untouched
			d = reduce(d, { type: "setGlobalArtist", artist: "GA" });
			expect(d.globalArtist).toBe("GA");
			d = reduce(d, { type: "setGlobalAlbumArt", albumArt: { kind: "url", url: "u" } });
			expect(d.globalAlbumArt).toEqual({ kind: "url", url: "u" });
		});

		it("applyGlobalAlbum sets global + all segments", () => {
			const d = reduce(baseDraft(), { type: "applyGlobalAlbum", album: "All" });
			expect(d.globalAlbum).toBe("All");
			expect(d.segments.every((s) => s.album === "All")).toBe(true);
		});

		it("applyGlobalArtist / applyGlobalAlbumArt apply to all", () => {
			const art = { kind: "url" as const, url: "c" };
			let d = reduce(baseDraft(), { type: "applyGlobalArtist", artist: "Ar" });
			expect(d.segments.every((s) => s.artist === "Ar")).toBe(true);
			d = reduce(d, { type: "applyGlobalAlbumArt", albumArt: art });
			expect(d.segments.every((s) => s.albumArt === art)).toBe(true);
		});

		it("applyAllGlobals pushes current globals to every segment", () => {
			let d = reduce(baseDraft(), { type: "setGlobalAlbum", album: "GA" });
			d = reduce(d, { type: "setGlobalArtist", artist: "GAr" });
			d = reduce(d, { type: "applyAllGlobals" });
			expect(d.segments.every((s) => s.album === "GA" && s.artist === "GAr")).toBe(true);
		});
	});

	describe("view-model helpers", () => {
		it("segmentDuration / effectiveDuration / removedDuration", () => {
			const s: SegmentDraft = {
				...seg("s1", 1, 0, 100),
				removedSegments: [
					{ uuid: "k1", start: 10, end: 20, category: "manual", enabled: true, label: "a" },
					{ uuid: "k2", start: 30, end: 40, category: "manual", enabled: false, label: "b" },
				],
			};
			expect(segmentDuration(s)).toBe(100);
			expect(removedDuration(s)).toBe(10); // only enabled k1
			expect(effectiveDuration(s)).toBe(90);
		});

		it("formatRange / durationLabel format as m:ss", () => {
			const s = seg("s1", 1, 65, 185);
			expect(formatRange(s)).toBe("1:05 – 3:05");
			expect(durationLabel(s)).toBe("2:00");
		});

		it("totalDuration sums effective durations", () => {
			expect(totalDuration(baseDraft())).toBe(600);
		});
	});

	describe("categoryLabel", () => {
		it("maps every SponsorBlock category + manual to a friendly label", () => {
			const cases: Array<[SponsorCategory | "manual", string]> = [
				["sponsor", "Sponsor"],
				["selfpromo", "Self-promo"],
				["interaction", "Interaction"],
				["intro", "Intro"],
				["outro", "Outro"],
				["preview", "Preview"],
				["music_offtopic", "Non-music"],
				["filler", "Filler"],
				["manual", "Manual"],
			];
			for (const [cat, expected] of cases) {
				expect(categoryLabel(cat)).toBe(expected);
			}
		});
	});

	describe("removedRegions (timeline view-model)", () => {
		it("positions skips as percentages of the segment duration", () => {
			const s: SegmentDraft = {
				...seg("s1", 1, 0, 100),
				removedSegments: [
					sponsSkip("k1", 10, 30, "sponsor"), // first 10→30 → left 10%, width 20%
					sponsSkip("k2", 60, 80, "intro"), // → left 60%, width 20%
				],
			};
			const regions = removedRegions(s);
			expect(regions).toHaveLength(2);
			expect(regions[0]).toMatchObject({ uuid: "k1", leftPct: 10, widthPct: 20, enabled: true });
			expect(regions[1]).toMatchObject({
				uuid: "k2",
				leftPct: 60,
				widthPct: 20,
				category: "intro",
			});
		});

		it("clamps skips into the segment range", () => {
			const s: SegmentDraft = {
				...seg("s1", 1, 100, 200),
				removedSegments: [
					sponsSkip("k1", 50, 150, "sponsor"), // straddles start → clamped to [100,150]
					sponsSkip("k2", 180, 300, "outro"), // straddles end → clamped to [180,200]
				],
			};
			const regions = removedRegions(s);
			expect(regions[0]).toMatchObject({ leftPct: 0, widthPct: 50 }); // 100→150 over dur 100
			expect(regions[1]).toMatchObject({ leftPct: 80, widthPct: 20 }); // 180→200 over dur 100
		});

		it("drops skips with no overlap with the segment", () => {
			const s: SegmentDraft = {
				...seg("s1", 1, 100, 200),
				removedSegments: [
					sponsSkip("k1", 0, 50, "sponsor"), // entirely before
					sponsSkip("k2", 250, 300, "intro"), // entirely after
					sponsSkip("k3", 120, 130, "outro"), // valid, kept
				],
			};
			expect(removedRegions(s).map((r) => r.uuid)).toEqual(["k3"]);
		});

		it("carries enabled state through to the region", () => {
			const s: SegmentDraft = {
				...seg("s1", 1, 0, 100),
				removedSegments: [
					sponsSkip("k1", 10, 20, "sponsor", true),
					sponsSkip("k2", 30, 40, "intro", false),
				],
			};
			const regions = removedRegions(s);
			expect(regions.find((r) => r.uuid === "k1")?.enabled).toBe(true);
			expect(regions.find((r) => r.uuid === "k2")?.enabled).toBe(false);
		});

		it("returns [] for a zero/negative-length segment", () => {
			const s: SegmentDraft = {
				...seg("s1", 1, 50, 50),
				removedSegments: [sponsSkip("k1", 10, 20, "sponsor")],
			};
			expect(removedRegions(s)).toEqual([]);
		});
	});

	describe("validateDraft", () => {
		it("a clean draft is valid", () => {
			expect(validateDraft(baseDraft())).toEqual([]);
		});

		it("flags an empty title", () => {
			const d: CutDraft = { ...baseDraft(), segments: [seg("s1", 1, 0, 100, "")] };
			expect(validateDraft(d).some((i) => i.message === "Title is empty")).toBe(true);
		});

		it("flags an inverted range", () => {
			const d: CutDraft = { ...baseDraft(), segments: [seg("s1", 1, 100, 50)] };
			expect(validateDraft(d).some((i) => i.message === "End must be after start")).toBe(true);
		});

		it("flags a range outside the source", () => {
			const d: CutDraft = { ...baseDraft(), segments: [seg("s1", 1, 0, 9999)] };
			expect(validateDraft(d).some((i) => i.message.includes("outside the source"))).toBe(true);
		});

		it("does not flag a skip extending past its segment (backend clips it)", () => {
			const d: CutDraft = {
				...baseDraft(),
				segments: [
					{
						...seg("s1", 1, 0, 100),
						removedSegments: [
							{ uuid: "k1", start: 90, end: 150, category: "manual", enabled: true, label: "x" },
						],
					},
				],
			};
			expect(validateDraft(d).some((i) => i.message.includes("outside the segment"))).toBe(false);
		});
	});

	describe("factories", () => {
		it("newSegment builds a blank segment with defaults", () => {
			const s = newSegment("id", 0, 10, {
				artist: "A",
				album: "L",
				albumArt: { kind: "video-thumbnail" },
			});
			expect(s).toMatchObject({ id: "id", title: "", artist: "A", album: "L", trackNumber: 0 });
			expect(s.removedSegments).toEqual([]);
		});

		it("newRemovedSegment builds an enabled skip", () => {
			const r = newRemovedSegment("u", 1, 2, "Intro");
			expect(r).toMatchObject({
				uuid: "u",
				start: 1,
				end: 2,
				enabled: true,
				label: "Intro",
				category: "manual",
			});
		});
	});
});
