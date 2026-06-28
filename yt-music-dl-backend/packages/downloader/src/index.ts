/**
 * @yt-music/downloader — thin wrapper over the `yt-dlp` standalone binary.
 *
 * EFFECT at the edge: spawns a subprocess and parses stdout. The pure
 * cut-plan / progress-reducer logic lives in `@yt-music/job-store`.
 * See .research/01-yt-dlp-integration-options.md.
 *
 * yt-dlp is driven via:
 *   --dump-json           → VideoInfo (metadata, chapters) as one JSON line
 *   --progress-template   → JSON progress objects, one per line on stdout
 *   -x --audio-format     → audio extraction (flac/mp3)
 *   --embed-metadata      → tag the file on download
 *   --embed-thumbnail     → album art on download
 */
import type { Chapter, VideoInfo } from "@yt-music/contract";

export interface DownloadProgress {
	pct: number;
	speed: string;
	eta: string;
	downloaded: number;
	total: number;
}

export interface DownloadOptions {
	outputDir: string;
	format: "flac" | "mp3";
	binaryPath?: string;
	ffmpegPath?: string;
}

/** The downloader effect — injected into the host. */
export interface Downloader {
	getInfo(url: string): Promise<VideoInfo>;
	download(
		url: string,
		opts: DownloadOptions,
	): { progress: AsyncIterable<DownloadProgress>; cancel(): void; done: Promise<string[]> };
}

// ─── yt-dlp binary resolution ────────────────────────────────────────────────

/** Resolve the yt-dlp binary path: explicit → env → PATH → bin/yt-dlp. */
export function resolveBinary(explicit?: string): string {
	if (explicit) return explicit;
	const envPath = process.env.YTMDL_YTDLP_PATH;
	if (envPath) return envPath;
	return "yt-dlp";
}

// ─── yt-dlp CLI arg builders (pure — unit-testable) ──────────────────────────

export function buildInfoArgs(url: string): string[] {
	return ["--dump-json", "--no-warnings", "--no-playlist", "--simulate", url];
}

export function buildDownloadArgs(url: string, opts: DownloadOptions): string[] {
	const args = [
		"-x",
		`--audio-format=${opts.format}`,
		"--audio-quality=0",
		"--embed-metadata",
		"--embed-thumbnail",
		"--newline",
		"--no-warnings",
		"--no-playlist",
		"--progress",
		'--progress-template={"pct":"%(progress._percent_str)s","speed":"%(progress._speed_str)s","eta":"%(progress._eta_str)s","downloaded":%(progress.downloaded_bytes)s,"total":%(progress.total_bytes)s}',
		"-o",
		`${opts.outputDir}/%(title)s.%(ext)s`,
	];
	if (opts.ffmpegPath) {
		args.push(`--ffmpeg-location=${opts.ffmpegPath}`);
	}
	args.push(url);
	return args;
}

// ─── JSON line parsing (pure — unit-testable) ────────────────────────────────

/** yt-dlp `--dump-json` raw shape (subset we care about). */
interface YtDlpInfo {
	id: string;
	title: string;
	uploader?: string;
	channel?: string;
	duration?: number;
	thumbnail?: string;
	webpage_url?: string;
	chapters?: { title: string; start_time: number; end_time: number }[];
}

/** `--progress-template` raw shape. */
interface RawProgress {
	pct: string;
	speed?: string;
	eta?: string;
	downloaded?: number;
	total?: number;
}

/**
 * Parse a single yt-dlp `--dump-json` line into a VideoInfo.
 * Pure: (jsonString) → VideoInfo. Throws on invalid JSON.
 */
export function parseInfoJson(raw: string): VideoInfo {
	const d = JSON.parse(raw) as YtDlpInfo;
	const info: VideoInfo = {
		id: d.id,
		title: d.title,
		uploader: d.uploader ?? d.channel ?? "Unknown",
		duration: d.duration ?? 0,
		thumbnail: d.thumbnail ?? "",
		webpageUrl: d.webpage_url ?? `https://youtu.be/${d.id}`,
	};
	if (d.channel !== undefined) info.channel = d.channel;
	if (d.chapters) {
		info.chapters = d.chapters.map((c) => ({
			title: c.title,
			startTime: c.start_time,
			endTime: c.end_time,
		}));
	}
	return info;
}

/**
 * Parse a yt-dlp stdout line into the output file path.
 *
 * Handles the three cases yt-dlp produces for audio extraction:
 *   "[download] Destination: /path/song.mp3"          — normal download
 *   "[ExtractAudio] Destination: /path/song.mp3"      — audio conversion
 *   "[download] /path/song.mp3 has already been downloaded" — file exists (skip)
 *   "[ExtractAudio] Not converting audio /path/song.mp3; ..." — already target fmt
 *
 * Without the last two, re-running a download for an existing file silently
 * loses the file path → "yt-dlp produced no audio file to cut".
 * Pure: (line) → path | null.
 */
export function parseDestination(line: string): string | null {
	// Normal: "[download] Destination: /path" / "[ExtractAudio] Destination: /path"
	const dest = line.match(/\[(?:download|ExtractAudio|Merger)\] Destination: (.+)/);
	if (dest?.[1]) return dest[1].trim();

	// Already downloaded: "[download] /path has already been downloaded"
	const already = line.match(/^\[download\] (.+?) has already been downloaded/);
	if (already?.[1]) return already[1].trim();

	// Already in target format: "[ExtractAudio] Not converting audio /path; ..."
	const skip = line.match(/^\[ExtractAudio\] Not converting audio (.+?);/);
	if (skip?.[1]) return skip[1].trim();

	return null;
}

/**
 * Parse a `--progress-template` JSON line into a DownloadProgress.
 * Pure: (jsonString) → DownloadProgress. Returns null for non-JSON lines.
 */
export function parseProgressLine(line: string): DownloadProgress | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const p = JSON.parse(trimmed) as RawProgress;
		return {
			pct: parsePercent(p.pct),
			speed: p.speed ?? "",
			eta: p.eta ?? "",
			downloaded: p.downloaded ?? 0,
			total: p.total ?? 0,
		};
	} catch {
		return null;
	}
}

function parsePercent(s: string | undefined): number {
	if (!s) return 0;
	const n = Number.parseFloat(s.replace("%", "").trim());
	return Number.isNaN(n) ? 0 : n;
}

// ─── Concrete downloader implementation (effect) ─────────────────────────────

/**
 * Spawn yt-dlp, parse its stdout. This is the injected effect — the pure
 * arg-builder + parser functions above are what's unit-tested; this just wires
 * them to Bun.spawn.
 */
export function createDownloader(binaryPath?: string, ffmpegPath?: string): Downloader {
	const bin = resolveBinary(binaryPath);
	const ff = ffmpegPath ?? process.env.YTMDL_FFMPEG_PATH;

	return {
		async getInfo(url: string): Promise<VideoInfo> {
			const args = buildInfoArgs(url);
			const proc = Bun.spawn([bin, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(`yt-dlp getInfo failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
			}
			const stdout = await new Response(proc.stdout).text();
			const lines = stdout.trim().split("\n").filter(Boolean);
			if (lines.length === 0) throw new Error("yt-dlp returned no JSON");
			return parseInfoJson(lines[0] ?? "");
		},

		download(url: string, opts: DownloadOptions) {
			const fullOpts: DownloadOptions = { ...opts };
			const ffPath = opts.ffmpegPath ?? ff;
			if (ffPath) fullOpts.ffmpegPath = ffPath;
			const args = buildDownloadArgs(url, fullOpts);
			const proc = Bun.spawn([bin, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});

			let cancelled = false;

			// yt-dlp writes BOTH progress JSON and "[ExtractAudio] Destination:"
			// lines to STDOUT. One eager reader drains stdout, harvesting
			// destination paths into `files` and pushing progress events into a
			// pull-queue that `progress` drains. A single reader avoids the
			// data-corruption Bun's ReadableStream.tee() exhibits under concurrent
			// reads.
			const files: string[] = [];
			const queue: DownloadProgress[] = [];
			let finished = false;
			const waiters: Array<(r: IteratorResult<DownloadProgress>) => void> = [];

			const pumpDone = (async () => {
				const reader = proc.stdout.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) {
							const dest = parseDestination(line);
							if (dest && !files.includes(dest)) files.push(dest);
							const p = parseProgressLine(line);
							if (p) {
								const w = waiters.shift();
								if (w) w({ value: p, done: false });
								else queue.push(p);
							}
						}
					}
					if (buffer.trim()) {
						const dest = parseDestination(buffer);
						if (dest && !files.includes(dest)) files.push(dest);
						const p = parseProgressLine(buffer);
						if (p) queue.push(p);
					}
				} finally {
					reader.releaseLock();
					finished = true;
					for (const w of waiters) w({ value: undefined, done: true });
					waiters.length = 0;
				}
			})();

			const progress: AsyncIterable<DownloadProgress> = {
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<DownloadProgress>> {
							const item = queue.shift();
							if (item !== undefined) return { value: item, done: false };
							if (finished) return { value: undefined, done: true };
							return new Promise((resolve) => waiters.push(resolve));
						},
					};
				},
			};

			const done = (async (): Promise<string[]> => {
				const stderrText = await new Response(proc.stderr).text();
				await pumpDone;
				const exitCode = await proc.exited;
				if (exitCode !== 0 && !cancelled) {
					throw new Error(`yt-dlp download failed (exit ${exitCode}): ${stderrText.slice(0, 500)}`);
				}
				return files;
			})();

			return {
				progress,
				cancel() {
					cancelled = true;
					proc.kill("SIGTERM");
				},
				done,
			};
		},
	};
}

export type { Chapter };
