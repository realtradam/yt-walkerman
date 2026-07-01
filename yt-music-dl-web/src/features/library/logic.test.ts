import type {
	AlbumMatch,
	AlbumMatchResult,
	CutDraft,
	MetadataResult,
	ReleaseDetail,
	ReleaseTrack,
	Track,
} from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import {
	albumMatchToUpdates,
	buildTrackSearch,
	EMPTY_ROWS,
	formatDuration,
	hasTrackInputError,
	parseTrackNumber,
	toRows,
	toTrackEditForm,
	toTrackRow,
	toUpdateRequest,
	toUpdateRequestFromItem,
	trackNumberLabel,
	trackSidebarItems,
	tracksToDraft,
	trackToCurrentItem,
	updateTrack,
} from "./logic.js";

const base: Track = {
	id: "t1",
	path: "/music/song.mp3",
	title: "Song",
	artist: "Artist",
	album: "Album",
	duration: 185,
	format: "mp3",
};

describe("library logic (pure)", () => {
	describe("formatDuration", () => {
		it("formats sub-minute seconds as m:ss", () => {
			expect(formatDuration(5)).toBe("0:05");
			expect(formatDuration(59)).toBe("0:59");
		});

		it("formats minutes as m:ss", () => {
			expect(formatDuration(65)).toBe("1:05");
			expect(formatDuration(599)).toBe("9:59");
		});

		it("formats hours as h:mm:ss", () => {
			expect(formatDuration(3600)).toBe("1:00:00");
			expect(formatDuration(3661)).toBe("1:01:01");
		});

		it("floors fractional seconds", () => {
			expect(formatDuration(64.9)).toBe("1:04");
		});

		it("treats zero as 0:00", () => {
			expect(formatDuration(0)).toBe("0:00");
		});

		it("returns placeholder for invalid values", () => {
			expect(formatDuration(Number.NaN)).toBe("—");
			expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
			expect(formatDuration(-1)).toBe("—");
		});
	});

	describe("trackNumberLabel", () => {
		it("shows the number when present", () => {
			expect(trackNumberLabel(1)).toBe("1");
			expect(trackNumberLabel(12)).toBe("12");
		});

		it("shows an em dash when absent", () => {
			expect(trackNumberLabel(undefined)).toBe("—");
		});
	});

	describe("toTrackRow", () => {
		it("derives a display row with pre-formatted duration + track label", () => {
			expect(toTrackRow(base)).toEqual({
				id: "t1",
				title: "Song",
				artist: "Artist",
				album: "Album",
				trackLabel: "—",
				durationLabel: "3:05",
				format: "mp3",
			});
		});

		it("formats the track number when present", () => {
			const row = toTrackRow({ ...base, track: 7 });
			expect(row.trackLabel).toBe("7");
		});

		it("preserves flac format", () => {
			const row = toTrackRow({ ...base, format: "flac" });
			expect(row.format).toBe("flac");
		});
	});

	describe("toRows", () => {
		it("maps an empty library to an empty list", () => {
			expect(toRows([])).toEqual(EMPTY_ROWS);
			expect(toRows([])).toEqual([]);
		});

		it("maps a whole library, preserving order", () => {
			const tracks: Track[] = [
				{ ...base, id: "a", path: "a.mp3", title: "A", artist: "X", album: "L", duration: 1 },
				{
					...base,
					id: "b",
					path: "b.flac",
					title: "B",
					artist: "Y",
					album: "M",
					duration: 3600,
					format: "flac",
				},
			];
			const rows = toRows(tracks);
			expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
			expect(rows[1]?.durationLabel).toBe("1:00:00");
		});
	});

	describe("toTrackEditForm", () => {
		it("seeds from a track with a track number", () => {
			expect(toTrackEditForm({ ...base, track: 3 })).toEqual({
				title: "Song",
				artist: "Artist",
				album: "Album",
				track: "3",
			});
		});

		it("seeds track as empty string when absent", () => {
			expect(toTrackEditForm(base).track).toBe("");
		});
	});

	describe("parseTrackNumber", () => {
		it("parses a positive integer", () => {
			expect(parseTrackNumber("3")).toBe(3);
			expect(parseTrackNumber("  12 ")).toBe(12);
		});

		it("returns undefined for empty / whitespace", () => {
			expect(parseTrackNumber("")).toBeUndefined();
			expect(parseTrackNumber("   ")).toBeUndefined();
		});

		it("rejects zero, negatives, non-integers, and garbage", () => {
			expect(parseTrackNumber("0")).toBeUndefined();
			expect(parseTrackNumber("-1")).toBeUndefined();
			expect(parseTrackNumber("1.5")).toBeUndefined();
			expect(parseTrackNumber("abc")).toBeUndefined();
		});
	});

	describe("hasTrackInputError", () => {
		it("is false for empty and valid input", () => {
			expect(hasTrackInputError("")).toBe(false);
			expect(hasTrackInputError("3")).toBe(false);
		});

		it("is true for non-empty invalid input", () => {
			expect(hasTrackInputError("0")).toBe(true);
			expect(hasTrackInputError("abc")).toBe(true);
		});
	});

	describe("toUpdateRequest", () => {
		const original: Track = { ...base, track: 3 };

		it("includes only changed string fields", () => {
			const req = toUpdateRequest(original, {
				title: "New Title",
				artist: "Artist",
				album: "Album",
				track: "3",
			});
			expect(req).toEqual({ title: "New Title" });
		});

		it("includes the track number when changed", () => {
			const req = toUpdateRequest(original, {
				title: "Song",
				artist: "Artist",
				album: "Album",
				track: "5",
			});
			expect(req).toEqual({ track: 5 });
		});

		it("omits the track field when input is empty (leave unchanged)", () => {
			const req = toUpdateRequest(original, {
				title: "Song",
				artist: "Artist",
				album: "Album",
				track: "",
			});
			expect(req).toEqual({});
			expect("track" in req).toBe(false);
		});

		it("omits the track field when input is invalid", () => {
			const req = toUpdateRequest(original, {
				title: "Song",
				artist: "Artist",
				album: "Album",
				track: "abc",
			});
			expect(req).toEqual({});
			expect("track" in req).toBe(false);
		});

		it("sets the track field where there was none", () => {
			const req = toUpdateRequest(base, {
				title: "Song",
				artist: "Artist",
				album: "Album",
				track: "1",
			});
			expect(req).toEqual({ track: 1 });
		});

		it("returns an empty body when nothing changed", () => {
			expect(toUpdateRequest(original, toTrackEditForm(original))).toEqual({});
		});
	});

	describe("updateTrack", () => {
		it("applies provided fields and leaves the rest (incl. id + path) untouched", () => {
			const next = updateTrack({ ...base, track: 3 }, { title: "New", track: 5 });
			expect(next).toEqual({
				...base,
				track: 5,
				title: "New",
			});
			expect(next.id).toBe("t1");
			expect(next.path).toBe("/music/song.mp3");
		});

		it("does not mutate the input", () => {
			const original = { ...base, track: 3 };
			const next = updateTrack(original, { title: "New" });
			expect(next).not.toBe(original);
			expect(original.title).toBe("Song");
		});

		it("only changes fields that are present in the diff", () => {
			const next = updateTrack({ ...base, track: 3 }, { artist: "Other" });
			expect(next.artist).toBe("Other");
			expect(next.title).toBe("Song");
			expect(next.track).toBe(3);
		});

		it("applies an empty diff as a shallow clone", () => {
			const next = updateTrack(base, {});
			expect(next).toEqual(base);
			expect(next).not.toBe(base);
		});
	});

	// ─── MusicBrainz metadata search helpers (pure) ────────────────────────────

	describe("buildTrackSearch", () => {
		it("uses the query when non-blank, with no artist hint", () => {
			const t: Track = { ...base, artist: "Track Artist" };
			const req = buildTrackSearch(t, "user query");
			expect(req).toEqual({ query: "user query", type: "recording" });
		});

		it("falls back to the track title when the query is blank", () => {
			const t: Track = { ...base, title: "Track Title", artist: "Track Artist" };
			const req = buildTrackSearch(t, "   ");
			expect(req).toEqual({ query: "Track Title", type: "recording" });
		});

		it("sends no artist hint even when the track has a channel-name artist", () => {
			// Library tracks' `artist` is the YouTube channel name; used as an
			// artist hint it yields zero MusicBrainz results — so it is never sent.
			const t: Track = {
				...base,
				title: "sweet moratorium",
				artist: "おかもとえみ Official YouTube Channel",
			};
			const req = buildTrackSearch(t, "");
			expect(req).toEqual({ query: "sweet moratorium", type: "recording" });
			expect("artist" in req).toBe(false);
		});

		it("returns an empty query when both query and title are blank", () => {
			const t: Track = { ...base, title: "", artist: "Track Artist" };
			const req = buildTrackSearch(t, "");
			expect(req).toEqual({ query: "", type: "recording" });
			expect("artist" in req).toBe(false);
		});
	});

	describe("trackToCurrentItem", () => {
		it("maps a track with all fields to a sidebar item", () => {
			const t: Track = { ...base, track: 5 };
			const item = trackToCurrentItem(t);
			expect(item).toEqual({
				source: "youtube",
				title: "Song",
				artist: "Artist",
				album: "Album",
				trackNumber: 5,
			});
		});

		it("omits trackNumber when the track has none", () => {
			const item = trackToCurrentItem(base);
			expect(item.trackNumber).toBeUndefined();
			expect(item.album).toBe("Album");
		});
	});

	describe("trackSidebarItems", () => {
		it("puts the current-tags entry first, then MB results in order", () => {
			const t: Track = { ...base, track: 3 };
			const r1: MetadataResult = {
				id: "m1",
				type: "recording",
				title: "MB One",
				artist: "A",
				score: 80,
			};
			const r2: MetadataResult = {
				id: "m2",
				type: "recording",
				title: "MB Two",
				artist: "B",
				score: 70,
			};
			const items = trackSidebarItems(t, [r1, r2]);
			expect(items).toHaveLength(3);
			expect(items[0]?.source).toBe("youtube");
			expect(items[0]?.title).toBe("Song");
			expect(items[0]?.trackNumber).toBe(3);
			expect(items[1]?.title).toBe("MB One");
			expect(items[2]?.title).toBe("MB Two");
		});

		it("has the current entry even with no MB results", () => {
			const items = trackSidebarItems(base, []);
			expect(items).toHaveLength(1);
			expect(items[0]?.source).toBe("youtube");
		});
	});

	describe("toUpdateRequestFromItem", () => {
		it("returns an empty body for the current-tags entry (no-op)", () => {
			const item = trackToCurrentItem(base);
			expect(toUpdateRequestFromItem(item)).toEqual({});
		});

		it("sets title + artist always, album + track when present", () => {
			const r: MetadataResult = {
				id: "m1",
				type: "recording",
				title: "MB Title",
				artist: "MB Artist",
				album: "MB Album",
				trackNumber: 9,
				score: 88,
			};
			const items = trackSidebarItems(base, [r]);
			const mbItem = items[1];
			if (!mbItem) throw new Error("expected an MB item");
			const req = toUpdateRequestFromItem(mbItem);
			expect(req).toEqual({
				title: "MB Title",
				artist: "MB Artist",
				album: "MB Album",
				track: 9,
			});
		});

		it("omits album when the result has no album", () => {
			const r: MetadataResult = {
				id: "m1",
				type: "recording",
				title: "T",
				artist: "A",
				score: 70,
			};
			const items = trackSidebarItems(base, [r]);
			const mbItem = items[1];
			if (!mbItem) throw new Error("expected an MB item");
			const req = toUpdateRequestFromItem(mbItem);
			expect(req).toEqual({ title: "T", artist: "A" });
			expect("album" in req).toBe(false);
		});

		it("omits track when the result has no trackNumber", () => {
			const r: MetadataResult = {
				id: "m1",
				type: "recording",
				title: "T",
				artist: "A",
				album: "Al",
				score: 70,
			};
			const items = trackSidebarItems(base, [r]);
			const mbItem = items[1];
			if (!mbItem) throw new Error("expected an MB item");
			const req = toUpdateRequestFromItem(mbItem);
			expect(req).toEqual({ title: "T", artist: "A", album: "Al" });
			expect("track" in req).toBe(false);
		});

		it("includes artUrl when the result has one", () => {
			const r: MetadataResult = {
				id: "m1",
				type: "recording",
				title: "T",
				artist: "A",
				score: 70,
				artUrl: "https://coverartarchive.org/release/abc/front",
			};
			const items = trackSidebarItems(base, [r]);
			const mbItem = items[1];
			if (!mbItem) throw new Error("expected an MB item");
			const req = toUpdateRequestFromItem(mbItem);
			expect(req.artUrl).toBe("https://coverartarchive.org/release/abc/front");
		});

		it("omits artUrl when the result has none", () => {
			const r: MetadataResult = {
				id: "m1",
				type: "recording",
				title: "T",
				artist: "A",
				score: 70,
			};
			const items = trackSidebarItems(base, [r]);
			const mbItem = items[1];
			if (!mbItem) throw new Error("expected an MB item");
			const req = toUpdateRequestFromItem(mbItem);
			expect("artUrl" in req).toBe(false);
		});
	});

	// ─── Match Album helpers (pure) ────────────────────────────────────────────

	describe("tracksToDraft", () => {
		it("converts each track to a segment, preserving order and id", () => {
			const tracks: Track[] = [
				{ ...base, id: "t1", title: "A", artist: "X", album: "L", track: 1, duration: 100 },
				{ ...base, id: "t2", title: "B", artist: "Y", album: "M", track: 2, duration: 200 },
			];
			const draft: CutDraft = tracksToDraft(tracks);
			expect(draft.segments).toHaveLength(2);
			expect(draft.segments[0]?.id).toBe("t1");
			expect(draft.segments[0]?.title).toBe("A");
			expect(draft.segments[0]?.artist).toBe("X");
			expect(draft.segments[0]?.album).toBe("L");
			expect(draft.segments[0]?.trackNumber).toBe(1);
			expect(draft.segments[0]?.end).toBe(100);
			expect(draft.segments[1]?.id).toBe("t2");
			expect(draft.segments[1]?.trackNumber).toBe(2);
		});

		it("defaults trackNumber to 0 when the track has none", () => {
			const draft = tracksToDraft([base]);
			expect(draft.segments[0]?.trackNumber).toBe(0);
		});

		it("returns an empty draft for no tracks", () => {
			const draft = tracksToDraft([]);
			expect(draft.segments).toEqual([]);
		});
	});

	describe("albumMatchToUpdates", () => {
		function relTrack(position: number, title: string): ReleaseTrack {
			return { position, title, recordingId: `rec-${position}` };
		}
		function rel(id: string, title: string, artist: string, tracks: ReleaseTrack[]): ReleaseDetail {
			return { id, title, artist, tracks };
		}
		function match(
			segmentIndex: number,
			t: ReleaseTrack,
			confidence: AlbumMatch["confidence"],
		): AlbumMatch {
			return { segmentIndex, track: t, confidence };
		}

		it("fills every position/title match; skips none", () => {
			const tracks: Track[] = [
				{ ...base, id: "t1", title: "A", duration: 100 },
				{ ...base, id: "t2", title: "B", duration: 200 },
			];
			const release = rel("rel1", "Album Title", "Album Artist", [
				relTrack(1, "Track One"),
				relTrack(2, "Track Two"),
			]);
			const result: AlbumMatchResult = {
				matches: [
					match(0, relTrack(1, "Track One"), "position"),
					match(1, relTrack(2, "Track Two"), "position"),
				],
			};
			const updates = albumMatchToUpdates(tracks, release, result);
			expect(updates).toHaveLength(2);
			expect(updates[0]).toEqual({
				id: "t1",
				request: {
					title: "Track One",
					artist: "Album Artist",
					album: "Album Title",
					track: 1,
				},
			});
			expect(updates[1]).toEqual({
				id: "t2",
				request: {
					title: "Track Two",
					artist: "Album Artist",
					album: "Album Title",
					track: 2,
				},
			});
		});

		it("skips none-confidence matches", () => {
			const tracks: Track[] = [
				{ ...base, id: "t1", title: "A", duration: 100 },
				{ ...base, id: "t2", title: "B", duration: 200 },
			];
			const release = rel("rel1", "Album", "Artist", [relTrack(1, "One"), relTrack(2, "Two")]);
			const result: AlbumMatchResult = {
				matches: [match(0, relTrack(1, "One"), "title"), match(1, relTrack(2, "Two"), "none")],
			};
			const updates = albumMatchToUpdates(tracks, release, result);
			expect(updates).toHaveLength(1);
			expect(updates[0]?.id).toBe("t1");
		});

		it("skips matches whose segmentIndex is out of range", () => {
			const tracks: Track[] = [{ ...base, id: "t1", title: "A", duration: 100 }];
			const release = rel("rel1", "Album", "Artist", [relTrack(1, "A")]);
			const result: AlbumMatchResult = {
				matches: [match(5, relTrack(1, "A"), "position")],
			};
			expect(albumMatchToUpdates(tracks, release, result)).toEqual([]);
		});

		it("returns no updates for an empty match list", () => {
			const tracks: Track[] = [{ ...base, id: "t1", title: "A", duration: 100 }];
			const release = rel("rel1", "Album", "Artist", []);
			expect(albumMatchToUpdates(tracks, release, { matches: [] })).toEqual([]);
		});

		it("uses release.title + release.artist for album + artist fields", () => {
			const tracks: Track[] = [{ ...base, id: "t1", title: "A", duration: 100 }];
			const release = rel("rel1", "The Album", "The Artist", [relTrack(3, "Track")]);
			const result: AlbumMatchResult = {
				matches: [match(0, relTrack(3, "Track"), "position")],
			};
			const updates = albumMatchToUpdates(tracks, release, result);
			expect(updates[0]?.request.album).toBe("The Album");
			expect(updates[0]?.request.artist).toBe("The Artist");
			expect(updates[0]?.request.track).toBe(3);
		});
	});
});
