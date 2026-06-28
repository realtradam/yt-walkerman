import type { Track } from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import {
	EMPTY_ROWS,
	formatDuration,
	hasTrackInputError,
	parseTrackNumber,
	toRows,
	toTrackEditForm,
	toTrackRow,
	toUpdateRequest,
	trackNumberLabel,
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
});
