import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { AudioFormat, CutPlan } from "@yt-music/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAtrimFilterArgs,
	buildConcatArgs,
	buildConcatListEntries,
	buildCopyExtractArgs,
	buildOutputPath,
	createCutter,
	sanitizeFilename,
} from "./index.js";

const execFile = promisify(execFileCb);
const FFMPEG = process.env.YTMDL_FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.YTMDL_FFPROBE_PATH ?? "ffprobe";

// ─── Pure arg builders ───────────────────────────────────────────────────────

describe("buildCopyExtractArgs (pure)", () => {
	it("uses -ss seek + -t duration + -c copy", () => {
		const args = buildCopyExtractArgs("in.mp3", { start: 10, end: 40 }, "out.mp3");
		expect(args).toEqual(["-ss", "10", "-i", "in.mp3", "-t", "30", "-c", "copy", "-y", "out.mp3"]);
	});

	it("computes duration as end - start", () => {
		const a = buildCopyExtractArgs("i", { start: 187.42, end: 412.8 }, "o");
		expect(a[a.indexOf("-t") + 1]).toBe(String(412.8 - 187.42));
	});
});

describe("buildConcatListEntries (pure)", () => {
	it("emits one 'file' line per part", () => {
		expect(buildConcatListEntries(["a.mp3", "b.mp3"])).toBe("file 'a.mp3'\nfile 'b.mp3'\n");
	});

	it("escapes single quotes in paths", () => {
		expect(buildConcatListEntries(["it's a path.flac"])).toContain("file 'it'\\''s a path.flac'");
	});
});

describe("buildConcatArgs (pure)", () => {
	it("uses the concat demuxer with -safe 0 and -c copy", () => {
		expect(buildConcatArgs("list.txt", "out.mp3")).toEqual([
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			"list.txt",
			"-c",
			"copy",
			"-y",
			"out.mp3",
		]);
	});
});

describe("buildAtrimFilterArgs (pure)", () => {
	it("builds a single-range atrim chain with no concat node", () => {
		const args = buildAtrimFilterArgs("in.flac", [{ start: 5, end: 15 }], "out.flac", "flac");
		expect(args).toContain("in.flac");
		const fc = args[args.indexOf("-filter_complex") + 1];
		expect(fc).toBe("[0:a]atrim=5:15,asetpts=N/SR/TB[out]");
		expect(args[args.indexOf("-c:a") + 1]).toBe("flac");
	});

	it("builds an N-range atrim+concat chain", () => {
		const args = buildAtrimFilterArgs(
			"in.flac",
			[
				{ start: 0, end: 10 },
				{ start: 20, end: 30 },
			],
			"o.flac",
			"flac",
		);
		const fc = args[args.indexOf("-filter_complex") + 1];
		expect(fc).toContain("atrim=0:10");
		expect(fc).toContain("atrim=20:30");
		expect(fc).toContain("concat=n=2:v=0:a=1[out]");
	});
});

describe("sanitizeFilename (pure)", () => {
	it("strips path separators", () => {
		expect(sanitizeFilename("a/b\\c")).toBe("a-b-c");
	});

	it("strips reserved chars", () => {
		expect(sanitizeFilename('a:b<c>"d|e?f*g')).toBe("abcdefg");
	});

	it("truncates long names", () => {
		expect(sanitizeFilename("x".repeat(200)).length).toBe(120);
	});

	it("collapses a name that is only separators to dashes", () => {
		expect(sanitizeFilename("///")).toBe("---");
	});
});

describe("buildOutputPath (pure)", () => {
	it("zero-pads the track number + title + extension", () => {
		const seg = {
			title: "Song",
			artist: "Art",
			album: "Al",
			trackNumber: 3,
			albumArt: { kind: "video-thumbnail" as const },
			keepRanges: [{ start: 0, end: 10 }],
		};
		expect(buildOutputPath("/out", seg, "flac", 2)).toBe(join("/out", "03. Song.flac"));
	});

	it("falls back to index+1 when trackNumber is 0", () => {
		const seg = {
			title: "T",
			artist: "",
			album: "",
			trackNumber: 0,
			albumArt: { kind: "video-thumbnail" as const },
			keepRanges: [{ start: 0, end: 1 }],
		};
		expect(buildOutputPath("/out", seg, "mp3", 4).endsWith("05. T.mp3")).toBe(true);
	});
});

// ─── Integration: real ffmpeg against a generated tone ───────────────────────

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "cutter-test-"));
});
afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

async function makeTone(path: string, seconds: number, format: AudioFormat): Promise<void> {
	const codec = format === "flac" ? "flac" : "libmp3lame";
	await execFile(FFMPEG, [
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-c:a",
		codec,
		"-y",
		path,
	]);
}

async function probeDuration(path: string): Promise<number> {
	// ffprobe's format.duration is the real decoded length (not the stale FLAC
	// STREAMINFO that ffmpeg's stderr Duration: line reports under -c copy).
	const { stdout } = await execFile(FFPROBE, [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		path,
	]);
	return Number.parseFloat(stdout.trim());
}

function seg(
	title: string,
	track: number,
	ranges: Array<{ start: number; end: number }>,
): CutPlan["segments"][number] {
	return {
		title,
		artist: "Art",
		album: "Al",
		trackNumber: track,
		albumArt: { kind: "video-thumbnail" },
		keepRanges: ranges,
	};
}

describe("createCutter (integration against real ffmpeg)", () => {
	// The plans above always produce exactly one output file; assert + unwrap.
	const first = (files: string[]): string => {
		expect(files).toHaveLength(1);
		const f = files[0];
		if (!f) throw new Error("expected one output file");
		return f;
	};

	it("cuts a FLAC single-range segment to ~10s (atrim re-encode, correct duration)", async () => {
		const raw = join(workDir, "raw.flac");
		await makeTone(raw, 30, "flac");
		const plan: CutPlan = { segments: [seg("First", 1, [{ start: 5, end: 15 }])] };
		const files = await createCutter(FFMPEG).execute(plan, raw, {
			outputDir: workDir,
			format: "flac",
		});
		const f = first(files);
		expect(existsSync(f)).toBe(true);
		expect(f.endsWith(".flac")).toBe(true);
		const dur = await probeDuration(f);
		expect(dur).toBeGreaterThan(9.5);
		expect(dur).toBeLessThan(10.5);
	});

	it("stitches two FLAC keep-ranges into ~20s via the atrim+concat filter", async () => {
		const raw = join(workDir, "raw.flac");
		await makeTone(raw, 30, "flac");
		const plan: CutPlan = {
			segments: [
				seg("Stitched", 1, [
					{ start: 0, end: 10 },
					{ start: 20, end: 30 },
				]),
			],
		};
		const files = await createCutter(FFMPEG).execute(plan, raw, {
			outputDir: workDir,
			format: "flac",
		});
		const dur = await probeDuration(first(files));
		expect(dur).toBeGreaterThan(19.5);
		expect(dur).toBeLessThan(20.5);
	});

	it("cuts an MP3 single-range segment to ~10s via stream copy", async () => {
		const raw = join(workDir, "raw.mp3");
		await makeTone(raw, 30, "mp3");
		const plan: CutPlan = { segments: [seg("First", 1, [{ start: 5, end: 15 }])] };
		const files = await createCutter(FFMPEG).execute(plan, raw, {
			outputDir: workDir,
			format: "mp3",
		});
		const f = first(files);
		expect(f.endsWith(".mp3")).toBe(true);
		const dur = await probeDuration(f);
		expect(dur).toBeGreaterThan(9.5);
		expect(dur).toBeLessThan(10.5);
	});

	it("stitches two MP3 keep-ranges via the concat demuxer", async () => {
		const raw = join(workDir, "raw.mp3");
		await makeTone(raw, 30, "mp3");
		const plan: CutPlan = {
			segments: [
				seg("Stitched", 1, [
					{ start: 0, end: 10 },
					{ start: 20, end: 30 },
				]),
			],
		};
		const files = await createCutter(FFMPEG).execute(plan, raw, {
			outputDir: workDir,
			format: "mp3",
		});
		const dur = await probeDuration(first(files));
		expect(dur).toBeGreaterThan(19.5);
		expect(dur).toBeLessThan(20.5);
	});

	it("cuts multiple segments and reports progress", async () => {
		const raw = join(workDir, "raw.flac");
		await makeTone(raw, 30, "flac");
		const plan: CutPlan = {
			segments: [seg("A", 1, [{ start: 0, end: 10 }]), seg("B", 2, [{ start: 10, end: 20 }])],
		};
		const progress: { segmentIndex: number; total: number; pct: number }[] = [];
		const files = await createCutter(FFMPEG).execute(
			plan,
			raw,
			{ outputDir: workDir, format: "flac" },
			(p) => progress.push(p),
		);
		expect(files).toHaveLength(2);
		for (const f of files) expect(existsSync(f)).toBe(true);
		expect(progress).toEqual([
			{ segmentIndex: 0, total: 2, pct: 50 },
			{ segmentIndex: 1, total: 2, pct: 100 },
		]);
	});

	it("stitches MP3 keep-ranges with a RELATIVE outputDir (concat demuxer path resolution)", async () => {
		// Regression: the concat demuxer resolves relative paths in the list
		// file relative to the LIST FILE's directory, not the cwd. When
		// outputDir was relative (e.g. "./output"), part paths were doubled
		// (output/.cut-xxx/output/.cut-xxx/part-0-0.mp3) → "Impossible to open".
		// We fix this by resolving outputDir to an absolute path internally.
		// This test uses a relative outputDir to guard against regressions.
		const raw = join(workDir, "raw.mp3");
		await makeTone(raw, 30, "mp3");
		const plan: CutPlan = {
			segments: [
				seg("Stitched", 1, [
					{ start: 0, end: 10 },
					{ start: 20, end: 30 },
				]),
			],
		};
		// Use a relative path: workDir is under tmpdir, so "workDir" relative
		// to cwd is wrong — but we cd into the parent so the relative path works.
		const relativeDir = relative(process.cwd(), workDir);
		expect(relativeDir).not.toBe(workDir); // confirm it's actually relative

		const files = await createCutter(FFMPEG).execute(plan, raw, {
			outputDir: relativeDir,
			format: "mp3",
		});
		const dur = await probeDuration(first(files));
		expect(dur).toBeGreaterThan(19.5);
		expect(dur).toBeLessThan(20.5);
	});
}, 120000);
