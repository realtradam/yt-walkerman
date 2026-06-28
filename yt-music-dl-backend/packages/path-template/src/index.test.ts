import { describe, expect, it } from "vitest";
import {
	DEFAULT_PATH_TEMPLATE,
	type PathTemplateVars,
	padTrackNumber,
	renderPathTemplate,
	sanitizePathComponent,
} from "./index.js";

const T = DEFAULT_PATH_TEMPLATE; // "{artist}/{album}/{track} - {title}.{ext}"

const full: PathTemplateVars = {
	artist: "Pink Floyd",
	album: "The Dark Side of the Moon",
	track: 1,
	title: "Speak to Me",
	ext: "flac",
};

describe("sanitizePathComponent (pure)", () => {
	it("replaces all illegal chars with _", () => {
		expect(sanitizePathComponent('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
	});

	it("strips leading/trailing dots and spaces", () => {
		expect(sanitizePathComponent("  ..song..  ")).toBe("song");
		expect(sanitizePathComponent(".hidden.")).toBe("hidden");
		expect(sanitizePathComponent(" title ")).toBe("title");
	});

	it("leaves interior dots and spaces intact", () => {
		expect(sanitizePathComponent("01 - Speak to Me.flac")).toBe("01 - Speak to Me.flac");
	});

	it("preserves unicode", () => {
		expect(sanitizePathComponent("Sigur Rós – Ágætis byrjun")).toBe("Sigur Rós – Ágætis byrjun");
	});

	it("collapses to empty string when only illegal/trim chars", () => {
		expect(sanitizePathComponent("...")).toBe("");
		expect(sanitizePathComponent("   ")).toBe("");
		expect(sanitizePathComponent("/\\:*?")).toBe("_____");
	});
});

describe("padTrackNumber (pure)", () => {
	it("zero-pads single digits to 2", () => {
		expect(padTrackNumber(1)).toBe("01");
		expect(padTrackNumber(9)).toBe("09");
	});

	it("does not truncate 3+ digit numbers", () => {
		expect(padTrackNumber(10)).toBe("10");
		expect(padTrackNumber(100)).toBe("100");
		expect(padTrackNumber(999)).toBe("999");
	});

	it("defaults absent / non-positive / NaN to 00", () => {
		expect(padTrackNumber(undefined)).toBe("00");
		expect(padTrackNumber(0)).toBe("00");
		expect(padTrackNumber(-1)).toBe("00");
		expect(padTrackNumber(Number.NaN)).toBe("00");
		expect(padTrackNumber(Number.POSITIVE_INFINITY)).toBe("00");
	});
});

describe("renderPathTemplate (pure) — happy path", () => {
	it("renders the default template fully", () => {
		expect(renderPathTemplate(T, full)).toBe(
			"Pink Floyd/The Dark Side of the Moon/01 - Speak to Me.flac",
		);
	});

	it("uses a custom template", () => {
		expect(
			renderPathTemplate("{artist} - {album}/{track}_{title}.{ext}", {
				artist: "A",
				album: "B",
				track: 7,
				title: "Song",
				ext: "mp3",
			}),
		).toBe("A - B/07_Song.mp3");
	});

	it("handles a flat template (no directories)", () => {
		expect(renderPathTemplate("{track} - {title}.{ext}", { ...full, track: 3 })).toBe(
			"03 - Speak to Me.flac",
		);
	});
});

describe("renderPathTemplate — fallbacks for empty fields", () => {
	it("falls back for empty artist/album/title", () => {
		const r = renderPathTemplate(T, { artist: "", album: "", title: "", track: 0, ext: "mp3" });
		expect(r).toBe("Unknown Artist/Unknown Album/00 - Untitled.mp3");
	});

	it("falls back when fields are whitespace-only", () => {
		const r = renderPathTemplate(T, {
			artist: "   ",
			album: "\t",
			title: " ",
			track: undefined,
			ext: "flac",
		});
		expect(r).toBe("Unknown Artist/Unknown Album/00 - Untitled.flac");
	});

	it("falls back when fields are undefined", () => {
		const r = renderPathTemplate(T, {});
		expect(r).toBe("Unknown Artist/Unknown Album/00 - Untitled");
	});

	it("empty ext leaves no dangling dot", () => {
		// "Untitled." → sanitize strips the trailing dot → "Untitled"
		expect(renderPathTemplate("{title}.{ext}", { title: "X" })).toBe("X");
	});
});

describe("renderPathTemplate — sanitization in components", () => {
	it("sanitizes slashes inside a field value", () => {
		// "AC/DC" must not create an extra directory.
		expect(renderPathTemplate("{artist}/{title}", { artist: "AC/DC", title: "TNT" })).toBe(
			"AC_DC/TNT",
		);
	});

	it("sanitizes backslashes and other illegal chars in fields", () => {
		const r = renderPathTemplate("{title}", { title: 'a/b\\c:d*e?f"g<h>i|j' });
		expect(r).toBe("a_b_c_d_e_f_g_h_i_j");
	});

	it("strips leading/trailing dots in field values", () => {
		const r = renderPathTemplate("{title}", { title: "...Hidden..." });
		expect(r).toBe("Hidden");
	});
});

describe("renderPathTemplate — path traversal defense", () => {
	// The invariant: no output component may be `..`, and the path must never
	// start with `/`. Slashes inside a field value become `_` at sanitize time,
	// so a field can never inject a new directory or a `..` component.
	it("neutralizes traversal in a field value (slashes → _)", () => {
		const r = renderPathTemplate("{artist}/{title}", {
			artist: "../../etc",
			title: "passwd",
		});
		// the artist's slashes are flattened to `_`; no `..` component survives
		expect(r.split("/").every((c) => c !== ".." && c !== ".")).toBe(true);
		expect(r.startsWith("/")).toBe(false);
		expect(r.endsWith("/passwd")).toBe(true);
	});

	it("neutralizes a fully-traversal field", () => {
		const r = renderPathTemplate("{title}", { title: "../../../etc/passwd" });
		expect(r.split("/").every((c) => c !== ".." && c !== ".")).toBe(true);
		expect(r.startsWith("/")).toBe(false);
		// the whole thing is a single sanitized component (slashes → _)
		expect(r.split("/")).toHaveLength(1);
	});

	it("never produces a leading slash", () => {
		const r = renderPathTemplate("/{artist}/{title}", { artist: "A", title: "B" });
		expect(r.startsWith("/")).toBe(false);
		// the stray leading "/" is dropped — the path is relative
		expect(r).toBe("A/B");
	});

	it("collapses empty components from adjacent slashes in the template", () => {
		const r = renderPathTemplate("{artist}//{title}", { artist: "A", title: "B" });
		expect(r).toBe("A/B");
	});

	it("strips a trailing slash", () => {
		const r = renderPathTemplate("{artist}/", { artist: "A" });
		expect(r).toBe("A");
	});

	it("a literal '.' or '..' field falls back to the default", () => {
		// dots-only values sanitize to empty → fallback, never a traversal component
		expect(renderPathTemplate("{title}", { title: "." })).toBe("Untitled");
		expect(renderPathTemplate("{title}", { title: ".." })).toBe("Untitled");
	});

	it("a template with a literal ../ is neutralized", () => {
		// template `{artist}/../{title}` → the ".." component sanitizes to empty
		// and is dropped — the file stays inside the artist dir, never escapes.
		const r = renderPathTemplate("{artist}/../{title}", { artist: "A", title: "B" });
		expect(r.split("/").every((c) => c !== "..")).toBe(true);
		expect(r).toBe("A/B");
	});
});

describe("renderPathTemplate — misc", () => {
	it("leaves unknown placeholders untouched", () => {
		// {year} is not a known var — it stays literal.
		expect(
			renderPathTemplate("{artist}/{year} - {title}", {
				artist: "A",
				title: "T",
			}),
		).toBe("A/{year} - T");
	});

	it("is a pure function (same input → same output)", () => {
		const a = renderPathTemplate(T, full);
		const b = renderPathTemplate(T, full);
		expect(a).toBe(b);
	});

	it("preserves unicode artist/album/title", () => {
		const r = renderPathTemplate(T, {
			artist: "Sigur Rós",
			album: "Ágætis byrjun",
			track: 4,
			title: "Starálfur",
			ext: "flac",
		});
		expect(r).toBe("Sigur Rós/Ágætis byrjun/04 - Starálfur.flac");
	});
});
