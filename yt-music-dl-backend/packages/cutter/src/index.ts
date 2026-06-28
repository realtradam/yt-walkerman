/**
 * @yt-music/cutter — ffmpeg executor for a CutPlan.
 *
 * EFFECT at the edge: spawns the `ffmpeg` binary. The CutPlan + keep-ranges are
 * already computed by the pure core (@yt-music/cut-plan); the cutter just
 * executes them.
 *
 * Two strategies, by format (see .research/07 — empirically verified):
 *  - **MP3**: stream copy (`-c copy`). Extract each KeepRange with
 *    `-ss`/`-t -c copy`; concat multiple parts per song with the concat demuxer
 *    (`-c copy`). Lossless, correct durations.
 *  - **FLAC**: re-encode via the `atrim`+`concat` audio filter in ONE ffmpeg pass
 *    (`-c:a flac`). FLAC→FLAC is LOSSLESS, and — critically — `-c copy` does NOT
 *    rewrite FLAC STREAMINFO total-samples, so stream-copied FLAC reports a
 *    stale (full-album) duration. Re-encoding fixes the duration metadata while
 *    remaining lossless. The atrim filter is also sample-accurate.
 *
 * Pure arg builders are unit-tested with zero mocks; createCutter wires them to
 * node:child_process (works under both Node/vitest and Bun at runtime).
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AudioFormat, CutPlan, CutSegment, KeepRange } from "@yt-music/contract";

const execFile = promisify(execFileCb);

// ─── Pure core: ffmpeg arg builders ──────────────────────────────────────────

/**
 * ffmpeg args to stream-copy-extract [start, end) from `input` to `output`:
 * `-ss START -i input -t DURATION -c copy output`. Fast, lossless, MP3.
 * Pure: (input, range, output) → string[].
 */
export function buildCopyExtractArgs(input: string, range: KeepRange, output: string): string[] {
	const duration = range.end - range.start;
	return [
		"-ss",
		String(range.start),
		"-i",
		input,
		"-t",
		String(duration),
		"-c",
		"copy",
		"-y",
		output,
	];
}

/**
 * The concat-demuxer list-file content for a set of part files.
 * Each line: `file 'path'` (single quotes escaped). Pure: (parts) → string.
 */
export function buildConcatListEntries(parts: string[]): string {
	return `${parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")}\n`;
}

/**
 * ffmpeg args to concat the parts listed in `listFile` into `output` via the
 * concat demuxer with stream copy. Pure: (listFile, output) → string[].
 */
export function buildConcatArgs(listFile: string, output: string): string[] {
	return ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", output];
}

/**
 * ffmpeg args to extract + stitch one song's keep-ranges in a single pass via
 * the `atrim`+`concat` audio filter, re-encoded to `format`. One range needs no
 * concat node; N ranges are concatenated. Pure: (input, ranges, output, format) → string[].
 *
 * Used for FLAC (lossless re-encode, correct duration metadata) and as a
 * sample-accurate fallback.
 */
export function buildAtrimFilterArgs(
	input: string,
	ranges: KeepRange[],
	output: string,
	format: AudioFormat,
): string[] {
	if (ranges.length === 1) {
		const r = ranges[0];
		if (!r) throw new Error("buildAtrimFilterArgs: missing range");
		return [
			"-i",
			input,
			"-filter_complex",
			`[0:a]atrim=${r.start}:${r.end},asetpts=N/SR/TB[out]`,
			"-map",
			"[out]",
			"-c:a",
			format,
			"-y",
			output,
		];
	}
	const labels = ranges.map((r, i) => `[0:a]atrim=${r.start}:${r.end},asetpts=N/SR/TB[p${i}]`);
	const concatInputs = ranges.map((_, i) => `[p${i}]`).join("");
	const chain = `${labels.join(";")};${concatInputs}concat=n=${ranges.length}:v=0:a=1[out]`;
	return ["-i", input, "-filter_complex", chain, "-map", "[out]", "-c:a", format, "-y", output];
}

/** Strip characters that are illegal in a filename, without a control-char regex. */
function stripIllegalChars(s: string): string {
	let out = "";
	for (const ch of s) {
		const code = ch.charCodeAt(0);
		if (code < 0x20) continue; // control chars
		if (ch === "/" || ch === "\\") out += "-";
		else if (
			ch === "<" ||
			ch === ">" ||
			ch === ":" ||
			ch === '"' ||
			ch === "|" ||
			ch === "?" ||
			ch === "*"
		)
			continue;
		else out += ch;
	}
	return out;
}

/**
 * Sanitize a string for use in a filename: strip path separators, control chars,
 * and reserved chars. Pure: (s) → string.
 */
export function sanitizeFilename(s: string): string {
	return stripIllegalChars(s).replace(/^\./, "_").trim().slice(0, 120);
}

/**
 * Build the output file path for one cut segment: a zero-padded track number +
 * title + format extension. Pure: (dir, seg, format, index) → path.
 */
export function buildOutputPath(
	dir: string,
	seg: CutSegment,
	format: AudioFormat,
	index: number,
): string {
	const num = String(seg.trackNumber || index + 1).padStart(2, "0");
	const title = sanitizeFilename(seg.title) || `track-${num}`;
	return join(dir, `${num}. ${title}.${format}`);
}

// ─── Injected shell ─────────────────────────────────────────────────────────

export interface CutOptions {
	outputDir: string;
	format: AudioFormat;
	ffmpegPath?: string;
}

export interface CuttingProgress {
	segmentIndex: number;
	total: number;
	pct: number;
}

export interface Cutter {
	/**
	 * Execute a CutPlan against a raw downloaded audio file. Returns the list of
	 * output file paths (one per CutSegment). Pure CutPlan + keepRanges already
	 * computed; this just runs ffmpeg.
	 */
	execute(
		cutPlan: CutPlan,
		rawAudioPath: string,
		opts: CutOptions,
		onProgress?: (p: CuttingProgress) => void,
	): Promise<string[]>;
}

/** Resolve the ffmpeg binary: explicit → env → PATH. */
export function resolveFfmpeg(explicit?: string): string {
	if (explicit) return explicit;
	const env = process.env.YTMDL_FFMPEG_PATH;
	if (env) return env;
	return "ffmpeg";
}

/**
 * Create a Cutter backed by ffmpeg (via node:child_process). Per segment:
 *  - FLAC: one atrim-filter re-encode pass (lossless, correct duration).
 *  - MP3:  stream-copy each keep-range; concat with the demuxer if >1 range.
 */
export function createCutter(ffmpegPath?: string): Cutter {
	const bin = resolveFfmpeg(ffmpegPath);

	async function runFfmpeg(args: string[]): Promise<void> {
		try {
			await execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 });
		} catch (err) {
			const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
			// ffmpeg prints a multi-line version banner to the START of stderr on
			// every run. The actual error is at the END. Strip the banner lines
			// (version / built with / configuration / lib lines) so the user sees
			// the real error, not 500 chars of config flags.
			const stripped = stderr
				.split("\n")
				.filter((l) => !/^(ffmpeg version| {2}built with| {2}configuration:| {2}lib\w)/.test(l))
				.join("\n")
				.trim();
			throw new Error(`ffmpeg failed: ${stripped.slice(-500) || stderr.slice(-500)}`);
		}
	}

	return {
		async execute(cutPlan, rawAudioPath, opts, onProgress) {
			const { segments } = cutPlan;
			const total = segments.length;
			const outFiles: string[] = [];

			let i = 0;
			for (const seg of segments) {
				const outputPath = buildOutputPath(opts.outputDir, seg, opts.format, i);
				const ranges = seg.keepRanges;

				if (opts.format === "flac") {
					// Single lossless re-encode pass; correct duration metadata.
					await runFfmpeg(buildAtrimFilterArgs(rawAudioPath, ranges, outputPath, "flac"));
				} else if (ranges.length === 1) {
					// MP3 single range: stream-copy extract.
					const r = ranges[0];
					if (r) await runFfmpeg(buildCopyExtractArgs(rawAudioPath, r, outputPath));
				} else {
					// MP3 multi-range: stream-copy parts, then concat (lossless).
					// The concat demuxer resolves relative paths in the list file
					// relative to the LIST FILE's directory — not the cwd. So if
					// outputDir is relative (e.g. "./output"), the part paths
					// would be doubled (output/.cut-xxx/output/.cut-xxx/...).
					// Using an absolute tmpDir avoids this.
					const tmpDir = mkdtempSync(join(resolve(opts.outputDir), ".cut-"));
					try {
						const parts: string[] = [];
						let j = 0;
						for (const r of ranges) {
							const part = join(tmpDir, `part-${i}-${j}.${opts.format}`);
							await runFfmpeg(buildCopyExtractArgs(rawAudioPath, r, part));
							parts.push(part);
							j++;
						}
						const listFile = join(tmpDir, "list.txt");
						writeFileSync(listFile, buildConcatListEntries(parts), "utf8");
						await runFfmpeg(buildConcatArgs(listFile, outputPath));
					} finally {
						rmSync(tmpDir, { recursive: true, force: true });
					}
				}

				outFiles.push(outputPath);
				onProgress?.({
					segmentIndex: i,
					total,
					pct: total > 0 ? Math.round(((i + 1) / total) * 100) : 100,
				});
				i++;
			}

			return outFiles;
		},
	};
}
