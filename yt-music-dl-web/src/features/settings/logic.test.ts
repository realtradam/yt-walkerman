import { describe, expect, it } from "vitest";
import {
	DEFAULT_PATH_TEMPLATE,
	DEFAULT_PREVIEW_SAMPLE,
	EMPTY_SETTINGS,
	FORMAT_OPTIONS,
	isDirty,
	PATH_TEMPLATE_TOKENS,
	previewPath,
	updateField,
} from "./logic.js";

describe("settings logic (pure)", () => {
	describe("constants", () => {
		it("exposes the backend's default path template", () => {
			expect(DEFAULT_PATH_TEMPLATE).toBe("{artist}/{album}/{track} - {title}.{ext}");
		});

		it("lists all five path-template tokens in order", () => {
			expect(PATH_TEMPLATE_TOKENS.map((t) => t.token)).toEqual([
				"{artist}",
				"{album}",
				"{track}",
				"{title}",
				"{ext}",
			]);
		});

		it("offers mp3 + flac format options", () => {
			expect(FORMAT_OPTIONS).toEqual(["mp3", "flac"]);
		});

		it("EMPTY_SETTINGS seeds the default template + mp3", () => {
			expect(EMPTY_SETTINGS).toEqual({
				outputDir: "",
				format: "mp3",
				pathTemplate: DEFAULT_PATH_TEMPLATE,
			});
		});
	});

	describe("updateField", () => {
		const base = { outputDir: "/music", format: "mp3" as const, pathTemplate: "{title}.{ext}" };

		it("updates outputDir without touching the other fields", () => {
			const next = updateField(base, "outputDir", "/other");
			expect(next).toEqual({ ...base, outputDir: "/other" });
			expect(next.format).toBe("mp3");
			expect(next.pathTemplate).toBe("{title}.{ext}");
		});

		it("updates format", () => {
			expect(updateField(base, "format", "flac").format).toBe("flac");
		});

		it("updates pathTemplate", () => {
			expect(updateField(base, "pathTemplate", "{artist}/{title}.{ext}").pathTemplate).toBe(
				"{artist}/{title}.{ext}",
			);
		});

		it("returns a new object (does not mutate the input)", () => {
			const next = updateField(base, "outputDir", "/x");
			expect(next).not.toBe(base);
			expect(base.outputDir).toBe("/music");
		});
	});

	describe("isDirty", () => {
		const base = { outputDir: "/music", format: "mp3" as const, pathTemplate: "{title}.{ext}" };

		it("is false when nothing changed", () => {
			expect(isDirty(base, { ...base })).toBe(false);
		});

		it("is true when outputDir changed", () => {
			expect(isDirty(base, { ...base, outputDir: "/other" })).toBe(true);
		});

		it("is true when format changed", () => {
			expect(isDirty(base, { ...base, format: "flac" })).toBe(true);
		});

		it("is true when pathTemplate changed", () => {
			expect(isDirty(base, { ...base, pathTemplate: "{artist}/{title}.{ext}" })).toBe(true);
		});
	});

	describe("previewPath", () => {
		it("substitutes every token using the backend's defaults for empties", () => {
			const out = previewPath(DEFAULT_PATH_TEMPLATE, {
				artist: "Daft Punk",
				album: "Discovery",
				track: 1,
				title: "One More Time",
				ext: "flac",
			});
			expect(out).toBe("Daft Punk/Discovery/01 - One More Time.flac");
		});

		it("zero-pads the track number to 2", () => {
			const out = previewPath("{track}", { ...DEFAULT_PREVIEW_SAMPLE, track: 7 });
			expect(out).toBe("07");
		});

		it("uses 00 when the track is absent", () => {
			const out = previewPath("{track}", {
				artist: "X",
				album: "Y",
				title: "T",
				ext: "mp3",
			});
			expect(out).toBe("00");
		});

		it("falls back to Unknown Artist / Unknown Album / Untitled for empties", () => {
			const out = previewPath("{artist}/{album}/{title}.{ext}", {
				artist: "  ",
				album: "",
				title: "",
				ext: "mp3",
			});
			expect(out).toBe("Unknown Artist/Unknown Album/Untitled.mp3");
		});

		it("leaves unknown tokens literally in place (no substitution)", () => {
			const out = previewPath("{artist} - {bogus}", DEFAULT_PREVIEW_SAMPLE);
			expect(out).toBe("Daft Punk - {bogus}");
		});

		it("returns the template unchanged when it has no tokens", () => {
			expect(previewPath("plain/path", DEFAULT_PREVIEW_SAMPLE)).toBe("plain/path");
		});
	});
});
