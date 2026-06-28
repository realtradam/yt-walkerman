import { describe, expect, it } from "vitest";
import {
	buildDownloadArgs,
	buildInfoArgs,
	parseDestination,
	parseInfoJson,
	parseProgressLine,
	resolveBinary,
} from "./index.js";

describe("downloader arg builder (pure)", () => {
	it("buildInfoArgs dumps json for one url", () => {
		const args = buildInfoArgs("https://youtu.be/abc");
		expect(args).toContain("--dump-json");
		expect(args).toContain("--no-playlist");
		expect(args).toContain("--simulate");
		expect(args.at(-1)).toBe("https://youtu.be/abc");
	});

	it("buildDownloadArgs extracts flac with progress template", () => {
		const args = buildDownloadArgs("https://youtu.be/abc", {
			outputDir: "./out",
			format: "flac",
		});
		expect(args).toContain("-x");
		expect(args).toContain("--audio-format=flac");
		expect(args).toContain("--embed-metadata");
		expect(args).toContain("--embed-thumbnail");
		expect(args.some((a) => a.startsWith("--progress-template="))).toBe(true);
		expect(args.some((a) => a.startsWith("-o"))).toBe(true);
		expect(args.at(-1)).toBe("https://youtu.be/abc");
	});

	it("buildDownloadArgs passes ffmpeg-location when given", () => {
		const args = buildDownloadArgs("u", {
			outputDir: ".",
			format: "mp3",
			ffmpegPath: "/usr/bin/ffmpeg",
		});
		expect(args).toContain("--ffmpeg-location=/usr/bin/ffmpeg");
	});
});

describe("parseInfoJson (pure)", () => {
	it("parses a minimal info dict", () => {
		const raw = JSON.stringify({
			id: "dQw4w9WgXcQ",
			title: "Rick Astley - Never Gonna Give You Up",
			uploader: "Rick Astley",
			duration: 213,
			thumbnail: "https://i.ytimg.com/thumb.jpg",
			webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		});
		const info = parseInfoJson(raw);
		expect(info.id).toBe("dQw4w9WgXcQ");
		expect(info.title).toBe("Rick Astley - Never Gonna Give You Up");
		expect(info.uploader).toBe("Rick Astley");
		expect(info.duration).toBe(213);
		expect(info.chapters).toBeUndefined();
	});

	it("parses chapters when present", () => {
		const raw = JSON.stringify({
			id: "abc",
			title: "Album",
			uploader: "Artist",
			duration: 600,
			chapters: [
				{ title: "Song One", start_time: 0, end_time: 180 },
				{ title: "Song Two", start_time: 180, end_time: 360 },
			],
		});
		const info = parseInfoJson(raw);
		expect(info.chapters).toHaveLength(2);
		expect(info.chapters?.[0]?.title).toBe("Song One");
		expect(info.chapters?.[0]?.startTime).toBe(0);
		expect(info.chapters?.[1]?.endTime).toBe(360);
	});

	it("falls back to channel when uploader is absent", () => {
		const raw = JSON.stringify({ id: "x", title: "T", channel: "Chan", duration: 10 });
		const info = parseInfoJson(raw);
		expect(info.uploader).toBe("Chan");
	});

	it("falls back to youtu.be URL when webpage_url absent", () => {
		const raw = JSON.stringify({ id: "abc123", title: "T", duration: 10 });
		const info = parseInfoJson(raw);
		expect(info.webpageUrl).toBe("https://youtu.be/abc123");
	});
});

describe("parseProgressLine (pure)", () => {
	it("parses a valid JSON progress line", () => {
		const line = '{"pct":" 42.0%","speed":"1.5MiB/s","eta":"00:30","downloaded":100,"total":200}';
		const p = parseProgressLine(line);
		expect(p).not.toBeNull();
		expect(p?.pct).toBe(42);
		expect(p?.speed).toBe("1.5MiB/s");
		expect(p?.eta).toBe("00:30");
		expect(p?.downloaded).toBe(100);
		expect(p?.total).toBe(200);
	});

	it("returns null for non-JSON lines", () => {
		expect(parseProgressLine("[download] Destination: foo.mp3")).toBeNull();
		expect(parseProgressLine("")).toBeNull();
		expect(parseProgressLine("some random text")).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseProgressLine("{broken")).toBeNull();
	});

	it("handles missing fields gracefully", () => {
		const line = '{"pct":"  0.0%"}';
		const p = parseProgressLine(line);
		expect(p?.pct).toBe(0);
		expect(p?.speed).toBe("");
		expect(p?.downloaded).toBe(0);
	});
});

describe("parseDestination (pure)", () => {
	it("parses an ExtractAudio destination line", () => {
		expect(parseDestination("[ExtractAudio] Destination: /out/Song.mp3")).toBe("/out/Song.mp3");
	});

	it("parses a download destination line", () => {
		expect(parseDestination("[download] Destination: /out/Song.webm")).toBe("/out/Song.webm");
	});

	it("returns null for non-destination lines", () => {
		expect(parseDestination('{"pct":" 42.0%"}')).toBeNull();
		expect(parseDestination("[download] 50% of 10MiB")).toBeNull();
		expect(parseDestination("")).toBeNull();
	});

	it("handles paths with spaces and parentheses", () => {
		expect(parseDestination("[ExtractAudio] Destination: /tmp/Artist - Album (OFFICIAL).mp3")).toBe(
			"/tmp/Artist - Album (OFFICIAL).mp3",
		);
	});

	it("parses a 'has already been downloaded' line (file exists)", () => {
		expect(
			parseDestination("[download] /out/Eminem - Forgot About Dre.mp3 has already been downloaded"),
		).toBe("/out/Eminem - Forgot About Dre.mp3");
	});

	it("parses a 'Not converting audio' line (already target format)", () => {
		expect(
			parseDestination(
				"[ExtractAudio] Not converting audio /out/Song.mp3; file is already in target format mp3",
			),
		).toBe("/out/Song.mp3");
	});

	it("does not false-match 'has already been downloaded' without a path", () => {
		expect(parseDestination("[download] has already been downloaded")).toBeNull();
	});
});

describe("resolveBinary (pure)", () => {
	it("uses explicit path when given", () => {
		expect(resolveBinary("/custom/yt-dlp")).toBe("/custom/yt-dlp");
	});

	it("falls back to PATH when no explicit or env", () => {
		const oldEnv = process.env.YTMDL_YTDLP_PATH;
		delete process.env.YTMDL_YTDLP_PATH;
		expect(resolveBinary()).toBe("yt-dlp");
		process.env.YTMDL_YTDLP_PATH = oldEnv;
	});
});
