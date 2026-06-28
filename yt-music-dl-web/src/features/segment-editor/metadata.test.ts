import type {
	AlbumMatch,
	AlbumMatchResult,
	CutDraft,
	MetadataResult,
	ReleaseDetail,
	ReleaseTrack,
	SegmentDraft,
} from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import type { EditAction } from "./logic.js";
import {
	albumMatchActions,
	buildRecordingSearch,
	buildReleaseSearch,
	fillActions,
	fillFromResult,
	initialSearchState,
	matchedSegmentCount,
	reduceSearch,
	sidebarItems,
	toSidebarItem,
	youtubeItem,
} from "./metadata.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

function seg(
	id: string,
	title: string,
	artist = "Artist",
	album = "Album",
	track = 1,
): SegmentDraft {
	return {
		id,
		title,
		artist,
		album,
		trackNumber: track,
		albumArt: { kind: "video-thumbnail" },
		start: 0,
		end: 100,
		removedSegments: [],
	};
}

function draft(): CutDraft {
	return {
		sourceVideoId: "vid",
		sourceDuration: 600,
		globalAlbum: "Global Album",
		globalArtist: "Global Artist",
		globalAlbumArt: { kind: "video-thumbnail" },
		segments: [seg("s1", "First", "Artist", "Album", 1), seg("s2", "Second", "Artist", "Album", 2)],
	};
}

function mbResult(
	id: string,
	title: string,
	artist = "Some Artist",
	album?: string,
	trackNumber?: number,
	score = 80,
): MetadataResult {
	// exactOptionalPropertyTypes: include album/trackNumber only when present.
	const r: MetadataResult = { id, type: "recording", title, artist, score };
	if (album !== undefined) r.album = album;
	if (trackNumber !== undefined) r.trackNumber = trackNumber;
	return r;
}

function track(position: number, title: string, recordingId = `rec-${position}`): ReleaseTrack {
	return { position, title, recordingId };
}

function release(
	id: string,
	title = "Release Title",
	artist = "Release Artist",
	tracks: ReleaseTrack[] = [],
): ReleaseDetail {
	return { id, title, artist, tracks };
}

function match(
	segmentIndex: number,
	t: ReleaseTrack,
	confidence: AlbumMatch["confidence"],
): AlbumMatch {
	return { segmentIndex, track: t, confidence };
}

/** Titles of the edits an action list would apply, in order, for readability. */
function editedFields(actions: EditAction[]): string[] {
	return actions.map((a) => a.type);
}

// ─── search state machine ───────────────────────────────────────────────────

describe("metadata search state machine (pure)", () => {
	it("initialSearchState defaults to idle with an empty query", () => {
		expect(initialSearchState()).toEqual({ status: "idle", query: "", results: [] });
	});

	it("initialSearchState accepts a prefilled query", () => {
		expect(initialSearchState("hello")).toEqual({ status: "idle", query: "hello", results: [] });
	});

	it("setQuery updates only the query (keeps results, status)", () => {
		const s = reduceSearch(initialSearchState("a"), {
			type: "searchOk",
			results: [mbResult("1", "T")],
		});
		const next = reduceSearch(s, { type: "setQuery", query: "b" });
		expect(next.query).toBe("b");
		expect(next.status).toBe("results");
		expect(next.results).toHaveLength(1);
	});

	it("searchStarted marks searching and carries the query, clearing prior error", () => {
		const s = reduceSearch(initialSearchState(), { type: "searchFailed", error: "boom" });
		const next = reduceSearch(s, { type: "searchStarted", query: "q" });
		expect(next.status).toBe("searching");
		expect(next.query).toBe("q");
		expect(next.error).toBeUndefined();
		// prior results are retained while loading
		expect(next.results).toEqual([]);
	});

	it("searchStarted retains previous results while loading", () => {
		const ok = reduceSearch(initialSearchState(), {
			type: "searchOk",
			results: [mbResult("1", "Old")],
		});
		const next = reduceSearch(ok, { type: "searchStarted", query: "new" });
		expect(next.status).toBe("searching");
		expect(next.results).toEqual([mbResult("1", "Old")]);
	});

	it("searchOk stores results and flips to results status", () => {
		const s = reduceSearch(initialSearchState("q"), { type: "searchStarted", query: "q" });
		const next = reduceSearch(s, {
			type: "searchOk",
			results: [mbResult("1", "A"), mbResult("2", "B")],
		});
		expect(next.status).toBe("results");
		expect(next.results).toHaveLength(2);
		expect(next.error).toBeUndefined();
	});

	it("searchFailed clears results and stores the error", () => {
		const s = reduceSearch(initialSearchState("q"), {
			type: "searchOk",
			results: [mbResult("1", "A")],
		});
		const next = reduceSearch(s, { type: "searchFailed", error: "502" });
		expect(next.status).toBe("error");
		expect(next.results).toEqual([]);
		expect(next.error).toBe("502");
	});
});

// ─── request builders ────────────────────────────────────────────────────────

describe("buildRecordingSearch (pure)", () => {
	it("uses the query when non-blank, segment artist as the hint", () => {
		const s = seg("s1", "Chapter Title", "Seg Artist");
		const req = buildRecordingSearch(s, "user query", "Global Artist");
		expect(req).toEqual({ query: "user query", artist: "Seg Artist", type: "recording" });
	});

	it("falls back to the segment title when the query is blank", () => {
		const s = seg("s1", "Chapter Title", "Seg Artist");
		const req = buildRecordingSearch(s, "   ", "Global Artist");
		expect(req.query).toBe("Chapter Title");
		expect(req.artist).toBe("Seg Artist");
		expect(req.type).toBe("recording");
	});

	it("falls back to the global artist when the segment artist is blank", () => {
		const s = seg("s1", "Chapter Title", "");
		const req = buildRecordingSearch(s, "", "Global Artist");
		expect(req.query).toBe("Chapter Title");
		expect(req.artist).toBe("Global Artist");
	});

	it("omits artist when neither segment nor global artist is set", () => {
		const s = seg("s1", "Chapter Title", "");
		const req = buildRecordingSearch(s, "", "");
		expect(req.query).toBe("Chapter Title");
		expect(req.artist).toBeUndefined();
	});

	it("omits artist when both are blank and query comes from the box", () => {
		const s = seg("s1", "", "");
		const req = buildRecordingSearch(s, "free text", "");
		expect(req.query).toBe("free text");
		expect(req.artist).toBeUndefined();
	});
});

describe("buildReleaseSearch (pure)", () => {
	it("uses album + artist inputs when provided", () => {
		const req = buildReleaseSearch("Dark Side", "Pink Floyd", "Global Album", "Global Artist");
		expect(req).toEqual({ query: "Dark Side", artist: "Pink Floyd", type: "release" });
	});

	it("falls back to global album / global artist when inputs are blank", () => {
		const req = buildReleaseSearch("   ", "", "Global Album", "Global Artist");
		expect(req.query).toBe("Global Album");
		expect(req.artist).toBe("Global Artist");
		expect(req.type).toBe("release");
	});

	it("omits artist when neither input nor global artist is set", () => {
		const req = buildReleaseSearch("Some Album", "", "", "");
		expect(req.query).toBe("Some Album");
		expect(req.artist).toBeUndefined();
		expect(req.type).toBe("release");
	});
});

// ─── sidebar view-model ──────────────────────────────────────────────────────

describe("sidebarItems (pure)", () => {
	it("puts the Generated-from-YouTube entry first, then MB results in order", () => {
		const s = seg("s1", "Chapter", "Seg Artist", "Seg Album", 3);
		const r1 = mbResult("m1", "MB One", "A");
		const r2 = mbResult("m2", "MB Two", "B");
		const items = sidebarItems(s, [r1, r2]);
		expect(items).toHaveLength(3);
		expect(items[0]?.source).toBe("youtube");
		expect(items[0]?.title).toBe("Chapter");
		expect(items[0]?.artist).toBe("Seg Artist");
		expect(items[0]?.album).toBe("Seg Album");
		expect(items[0]?.trackNumber).toBe(3);
		expect(items[0]?.score).toBeUndefined();
		expect(items[0]?.id).toBeUndefined();
		expect(items[1]).toEqual(toSidebarItem(r1));
		expect(items[2]).toEqual(toSidebarItem(r2));
	});

	it("has the YouTube entry even with no MB results", () => {
		const items = sidebarItems(seg("s1", "Solo"), []);
		expect(items).toHaveLength(1);
		expect(items[0]?.source).toBe("youtube");
	});

	it("toSidebarItem maps every field of an MB result", () => {
		const r = mbResult("m1", "Title", "Artist", "Album", 7, 92);
		expect(toSidebarItem(r)).toEqual({
			source: "musicbrainz",
			id: "m1",
			title: "Title",
			artist: "Artist",
			album: "Album",
			trackNumber: 7,
			score: 92,
		});
	});

	it("toSidebarItem omits album/trackNumber when the result lacks them", () => {
		const r: MetadataResult = { id: "m1", type: "recording", title: "T", artist: "A", score: 50 };
		const item = toSidebarItem(r);
		expect(item.album).toBeUndefined();
		expect(item.trackNumber).toBeUndefined();
		expect(item.score).toBe(50);
	});

	it("youtubeItem reflects the segment's current parsed fields", () => {
		const item = youtubeItem(seg("s1", "Title", "Artist", "Album", 5));
		expect(item).toEqual({
			source: "youtube",
			title: "Title",
			artist: "Artist",
			album: "Album",
			trackNumber: 5,
		});
	});
});

// ─── click-to-fill ───────────────────────────────────────────────────────────

describe("fillActions (pure)", () => {
	it("returns no edits for the Generated-from-YouTube entry (leaves fields unchanged)", () => {
		const actions = fillActions("s1", youtubeItem(seg("s1", "Title", "Artist", "Album", 1)));
		expect(actions).toEqual([]);
	});

	it("sets title + artist always, album + trackNumber when present", () => {
		const item = toSidebarItem(mbResult("m1", "MB Title", "MB Artist", "MB Album", 9, 88));
		const actions = fillActions("s2", item);
		expect(editedFields(actions)).toEqual([
			"editSegmentTitle",
			"editSegmentArtist",
			"editSegmentAlbum",
			"editSegmentTrackNumber",
		]);
		expect(actions[0]).toEqual({ type: "editSegmentTitle", segmentId: "s2", title: "MB Title" });
		expect(actions[1]).toEqual({ type: "editSegmentArtist", segmentId: "s2", artist: "MB Artist" });
		expect(actions[2]).toEqual({ type: "editSegmentAlbum", segmentId: "s2", album: "MB Album" });
		expect(actions[3]).toEqual({
			type: "editSegmentTrackNumber",
			segmentId: "s2",
			trackNumber: 9,
		});
	});

	it("omits album edit when the result has no album", () => {
		const r: MetadataResult = { id: "m1", type: "recording", title: "T", artist: "A", score: 70 };
		const actions = fillActions("s1", toSidebarItem(r));
		expect(editedFields(actions)).toEqual(["editSegmentTitle", "editSegmentArtist"]);
		expect(actions.some((a) => a.type === "editSegmentAlbum")).toBe(false);
	});

	it("omits trackNumber edit when the result has no trackNumber", () => {
		const r: MetadataResult = {
			id: "m1",
			type: "recording",
			title: "T",
			artist: "A",
			album: "Al",
			score: 70,
		};
		const actions = fillActions("s1", toSidebarItem(r));
		expect(editedFields(actions)).toEqual([
			"editSegmentTitle",
			"editSegmentArtist",
			"editSegmentAlbum",
		]);
		expect(actions.some((a) => a.type === "editSegmentTrackNumber")).toBe(false);
	});

	it("fillFromResult matches fillActions(toSidebarItem)", () => {
		const r = mbResult("m1", "T", "A", "Al", 2, 90);
		expect(fillFromResult("s1", r)).toEqual(fillActions("s1", toSidebarItem(r)));
	});
});

// ─── match-album → actions ───────────────────────────────────────────────────

describe("albumMatchActions (pure)", () => {
	it("fills every position/title match; skips none", () => {
		const d = draft(); // s1, s2
		const rel = release("rel1", "Album Title", "Album Artist", [
			track(1, "Track One"),
			track(2, "Track Two"),
		]);
		const result: AlbumMatchResult = {
			matches: [
				match(0, track(1, "Track One"), "position"),
				match(1, track(2, "Track Two"), "position"),
			],
		};
		const actions = albumMatchActions(d, rel, result);
		// 2 segments × 4 fields
		expect(actions).toHaveLength(8);
		// segment 0 (s1)
		expect(actions[0]).toEqual({ type: "editSegmentTitle", segmentId: "s1", title: "Track One" });
		expect(actions[1]).toEqual({
			type: "editSegmentArtist",
			segmentId: "s1",
			artist: "Album Artist",
		});
		expect(actions[2]).toEqual({ type: "editSegmentAlbum", segmentId: "s1", album: "Album Title" });
		expect(actions[3]).toEqual({ type: "editSegmentTrackNumber", segmentId: "s1", trackNumber: 1 });
		// segment 1 (s2)
		expect(actions[4]).toEqual({ type: "editSegmentTitle", segmentId: "s2", title: "Track Two" });
		expect(actions[5]).toEqual({
			type: "editSegmentArtist",
			segmentId: "s2",
			artist: "Album Artist",
		});
		expect(actions[6]).toEqual({ type: "editSegmentAlbum", segmentId: "s2", album: "Album Title" });
		expect(actions[7]).toEqual({ type: "editSegmentTrackNumber", segmentId: "s2", trackNumber: 2 });
	});

	it("skips none-confidence matches (leaves those segments as-is)", () => {
		const d = draft(); // s1, s2
		const rel = release("rel1", "Album", "Artist", [track(1, "One"), track(2, "Two")]);
		const result: AlbumMatchResult = {
			matches: [match(0, track(1, "One"), "title"), match(1, track(2, "Two"), "none")],
		};
		const actions = albumMatchActions(d, rel, result);
		expect(actions).toHaveLength(4); // only segment 0
		expect(actions.every((a) => "segmentId" in a && a.segmentId === "s1")).toBe(true);
	});

	it("handles a mix of position, title, and none", () => {
		const d = draft();
		const rel = release("rel1", "Album", "Artist", [track(1, "A"), track(2, "B")]);
		const result: AlbumMatchResult = {
			matches: [match(0, track(1, "A"), "position"), match(1, track(2, "B"), "none")],
		};
		const actions = albumMatchActions(d, rel, result);
		expect(actions).toHaveLength(4);
		expect(actions[0]).toEqual({ type: "editSegmentTitle", segmentId: "s1", title: "A" });
	});

	it("skips matches whose segmentIndex is out of range", () => {
		const d = draft(); // 2 segments
		const rel = release("rel1", "Album", "Artist", [track(1, "A")]);
		const result: AlbumMatchResult = {
			matches: [match(5, track(1, "A"), "position")], // index 5 doesn't exist
		};
		expect(albumMatchActions(d, rel, result)).toEqual([]);
	});

	it("returns no edits for an empty match list", () => {
		const d = draft();
		const rel = release("rel1", "Album", "Artist", []);
		expect(albumMatchActions(d, rel, { matches: [] })).toEqual([]);
	});

	it("uses release.title + release.artist for album + artist fields", () => {
		const d = draft();
		const rel = release("rel1", "The Album", "The Artist", [track(3, "Track")]);
		const result: AlbumMatchResult = { matches: [match(0, track(3, "Track"), "position")] };
		const actions = albumMatchActions(d, rel, result);
		expect(actions[1]).toEqual({
			type: "editSegmentArtist",
			segmentId: "s1",
			artist: "The Artist",
		});
		expect(actions[2]).toEqual({ type: "editSegmentAlbum", segmentId: "s1", album: "The Album" });
	});
});

describe("matchedSegmentCount (pure)", () => {
	it("counts position + title, excludes none", () => {
		const result: AlbumMatchResult = {
			matches: [
				match(0, track(1, "A"), "position"),
				match(1, track(2, "B"), "title"),
				match(2, track(3, "C"), "none"),
			],
		};
		expect(matchedSegmentCount(result)).toBe(2);
	});

	it("is 0 for an all-none result", () => {
		const result: AlbumMatchResult = {
			matches: [match(0, track(1, "A"), "none"), match(1, track(2, "B"), "none")],
		};
		expect(matchedSegmentCount(result)).toBe(0);
	});

	it("is 0 for an empty match list", () => {
		expect(matchedSegmentCount({ matches: [] })).toBe(0);
	});
});
