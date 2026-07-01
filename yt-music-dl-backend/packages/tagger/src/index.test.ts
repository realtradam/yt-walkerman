import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawMetadata } from "./index.js";
import {
	buildId3Tags,
	buildMetaflacArgs,
	createTagReader,
	createTagWriter,
	detectFormat,
	toTags,
} from "./index.js";

const execFile = promisify(execFileCb);
const FFMPEG = process.env.YTMDL_FFMPEG_PATH ?? "ffmpeg";
const METAFLAC = process.env.YTMDL_METAFLAC_PATH ?? "metaflac";

describe("detectFormat (pure)", () => {
	it("detects mp3 from extension", () => {
		expect(detectFormat("song.mp3")).toBe("mp3");
	});

	it("detects flac from extension", () => {
		expect(detectFormat("album.flac")).toBe("flac");
	});

	it("is case-insensitive", () => {
		expect(detectFormat("Song.MP3")).toBe("mp3");
		expect(detectFormat("Song.FLAC")).toBe("flac");
	});

	it("detects format from a full path", () => {
		expect(detectFormat("/home/user/music/Rick Astley - Song.mp3")).toBe("mp3");
		expect(detectFormat("./output/Album/01-Track.flac")).toBe("flac");
	});

	it("returns null for unsupported extensions", () => {
		expect(detectFormat("song.wav")).toBeNull();
		expect(detectFormat("song.m4a")).toBeNull();
		expect(detectFormat("notes.txt")).toBeNull();
	});

	it("returns null when there is no extension", () => {
		expect(detectFormat("README")).toBeNull();
	});
});

describe("toTags (pure)", () => {
	it("maps a fully-populated raw metadata into Tags", () => {
		const raw: RawMetadata = {
			common: {
				title: "Never Gonna Give You Up",
				artist: "Rick Astley",
				album: "Whenever You Need Somebody",
				trackNo: 7,
			},
			format: { duration: 213.4 },
		};
		const tags = toTags(raw, "mp3");
		expect(tags).toEqual({
			title: "Never Gonna Give You Up",
			artist: "Rick Astley",
			album: "Whenever You Need Somebody",
			track: 7,
			duration: 213.4,
			format: "mp3",
		});
	});

	it("normalizes absent fields to empty strings and zero", () => {
		const raw: RawMetadata = {
			common: { trackNo: undefined },
			format: {},
		};
		const tags = toTags(raw, "flac");
		expect(tags.title).toBe("");
		expect(tags.artist).toBe("");
		expect(tags.album).toBe("");
		expect(tags.track).toBe(0);
		expect(tags.duration).toBe(0);
		expect(tags.format).toBe("flac");
	});

	it("normalizes partially-present fields", () => {
		const raw: RawMetadata = {
			common: { title: "Only Title", trackNo: 3 },
			format: { duration: 42 },
		};
		const tags = toTags(raw, "mp3");
		expect(tags.title).toBe("Only Title");
		expect(tags.artist).toBe("");
		expect(tags.album).toBe("");
		expect(tags.track).toBe(3);
		expect(tags.duration).toBe(42);
		expect(tags.format).toBe("mp3");
	});

	it("preserves the format it was given", () => {
		const raw: RawMetadata = { common: { trackNo: undefined }, format: {} };
		expect(toTags(raw, "flac").format).toBe("flac");
		expect(toTags(raw, "mp3").format).toBe("mp3");
	});
});

describe("buildId3Tags (pure)", () => {
	it("maps Tags to the node-id3 frame shape", () => {
		const tags = {
			title: "T",
			artist: "A",
			album: "Al",
			track: 0,
			duration: 10,
			format: "mp3" as const,
		};
		const id3 = buildId3Tags(tags);
		expect(id3).toEqual({ title: "T", artist: "A", album: "Al" });
	});

	it("includes trackNumber as a string when track > 0", () => {
		const tags = {
			title: "T",
			artist: "A",
			album: "Al",
			track: 5,
			duration: 10,
			format: "mp3" as const,
		};
		expect(buildId3Tags(tags).trackNumber).toBe("5");
	});

	it("omits trackNumber when track is 0", () => {
		const tags = {
			title: "T",
			artist: "A",
			album: "Al",
			track: 0,
			duration: 10,
			format: "mp3" as const,
		};
		expect(buildId3Tags(tags).trackNumber).toBeUndefined();
	});

	it("does not include non-text frames when artPath is absent", () => {
		const tags = {
			title: "T",
			artist: "A",
			album: "Al",
			track: 0,
			duration: 10,
			format: "mp3" as const,
		};
		const id3 = buildId3Tags(tags);
		expect(id3).not.toHaveProperty("APIC");
		expect(id3).not.toHaveProperty("image");
		expect(id3).not.toHaveProperty("duration");
	});

	it("sets image to the artPath when artPath is present", () => {
		const tags = {
			title: "T",
			artist: "A",
			album: "Al",
			track: 0,
			duration: 10,
			format: "mp3" as const,
			artPath: "/tmp/cover.jpg",
		};
		const id3 = buildId3Tags(tags);
		expect(id3.image).toBe("/tmp/cover.jpg");
	});

	it("sets image alongside trackNumber when both are present", () => {
		const tags = {
			title: "T",
			artist: "A",
			album: "Al",
			track: 5,
			duration: 10,
			format: "mp3" as const,
			artPath: "/tmp/cover.png",
		};
		const id3 = buildId3Tags(tags);
		expect(id3.trackNumber).toBe("5");
		expect(id3.image).toBe("/tmp/cover.png");
	});

	it("omits image when artPath is an empty string", () => {
		const tags = {
			title: "T",
			artist: "A",
			album: "Al",
			track: 0,
			duration: 10,
			format: "mp3" as const,
			artPath: "",
		};
		const id3 = buildId3Tags(tags);
		expect(id3.image).toBeUndefined();
	});
});

describe("buildMetaflacArgs (pure)", () => {
	it("emits --remove-all-tags first, then the file path last", () => {
		const args = buildMetaflacArgs({ title: "T", artist: "A", album: "Al", track: 0 }, "song.flac");
		expect(args[0]).toBe("--remove-all-tags");
		expect(args.at(-1)).toBe("song.flac");
	});

	it("writes all text fields when fully populated", () => {
		const args = buildMetaflacArgs(
			{ title: "Never Gonna Give You Up", artist: "Rick Astley", album: "Whenever", track: 7 },
			"song.flac",
		);
		expect(args).toContain("--set-tag");
		expect(args).toContain("TITLE=Never Gonna Give You Up");
		expect(args).toContain("ARTIST=Rick Astley");
		expect(args).toContain("ALBUM=Whenever");
		expect(args).toContain("TRACKNUMBER=7");
	});

	it("emits each --set-tag value as a single argv token after the flag", () => {
		// --set-tag FIELD=VALUE is two tokens: ["--set-tag", "FIELD=VALUE", ...]
		const args = buildMetaflacArgs({ title: "T", artist: "A", album: "Al", track: 0 }, "song.flac");
		const setTagIdx: number[] = [];
		args.forEach((a, i) => {
			if (a === "--set-tag") setTagIdx.push(i);
		});
		expect(setTagIdx.length).toBe(3);
		for (const idx of setTagIdx) {
			expect(args[idx + 1]).toMatch(/^(TITLE|ARTIST|ALBUM)=/);
		}
	});

	it("omits TRACKNUMBER when track is 0", () => {
		const args = buildMetaflacArgs({ title: "T", artist: "A", album: "Al", track: 0 }, "song.flac");
		expect(args.some((a) => a.startsWith("TRACKNUMBER="))).toBe(false);
	});

	it("formats the track number as a base-10 string", () => {
		const args = buildMetaflacArgs(
			{ title: "T", artist: "A", album: "Al", track: 12 },
			"song.flac",
		);
		expect(args).toContain("TRACKNUMBER=12");
	});

	it("omits empty text fields (remove-all-tags already cleared them)", () => {
		const args = buildMetaflacArgs({ title: "", artist: "", album: "", track: 0 }, "song.flac");
		expect(args.some((a) => a.startsWith("TITLE="))).toBe(false);
		expect(args.some((a) => a.startsWith("ARTIST="))).toBe(false);
		expect(args.some((a) => a.startsWith("ALBUM="))).toBe(false);
		expect(args.some((a) => a.startsWith("TRACKNUMBER="))).toBe(false);
		// Only --remove-all-tags + the file path remain.
		expect(args).toEqual(["--remove-all-tags", "song.flac"]);
	});

	it("writes a single non-empty field when others are empty", () => {
		const args = buildMetaflacArgs(
			{ title: "Only Title", artist: "", album: "", track: 0 },
			"song.flac",
		);
		expect(args).toContain("TITLE=Only Title");
		expect(args.some((a) => a.startsWith("ARTIST="))).toBe(false);
		expect(args.some((a) => a.startsWith("ALBUM="))).toBe(false);
	});

	it("passes special chars verbatim — semicolons (no shell, no field-name collision)", () => {
		const args = buildMetaflacArgs(
			{ title: "Hello; World", artist: "A;B", album: "Al", track: 0 },
			"song.flac",
		);
		expect(args).toContain("TITLE=Hello; World");
		expect(args).toContain("ARTIST=A;B");
	});

	it("passes single quotes verbatim (O'Brien)", () => {
		const args = buildMetaflacArgs(
			{ title: "T", artist: "O'Brien", album: "Al", track: 0 },
			"song.flac",
		);
		expect(args).toContain("ARTIST=O'Brien");
	});

	it("passes double quotes verbatim", () => {
		const args = buildMetaflacArgs(
			{ title: 'Say "Hi"', artist: "A", album: "Al", track: 0 },
			"song.flac",
		);
		expect(args).toContain('TITLE=Say "Hi"');
	});

	it("passes newlines verbatim in a value", () => {
		const args = buildMetaflacArgs(
			{ title: "Line One\nLine Two", artist: "A", album: "Al", track: 0 },
			"song.flac",
		);
		expect(args).toContain("TITLE=Line One\nLine Two");
	});

	it("passes an equals sign in a value verbatim", () => {
		// metaflac splits FIELD=VALUE on the FIRST '=', so 'a=b=c' → VALUE='b=c'.
		const args = buildMetaflacArgs(
			{ title: "a=b=c", artist: "A", album: "Al", track: 0 },
			"song.flac",
		);
		expect(args).toContain("TITLE=a=b=c");
	});

	it("passes unicode verbatim", () => {
		const args = buildMetaflacArgs(
			{ title: "日本語タイトル", artist: "アーティスト", album: "アルバム", track: 3 },
			"song.flac",
		);
		expect(args).toContain("TITLE=日本語タイトル");
		expect(args).toContain("ARTIST=アーティスト");
		expect(args).toContain("ALBUM=アルバム");
		expect(args).toContain("TRACKNUMBER=3");
	});

	it("emits --import-picture-from with the art path when artPath is set", () => {
		const args = buildMetaflacArgs(
			{ title: "T", artist: "A", album: "Al", track: 0, artPath: "/tmp/cover.jpg" },
			"song.flac",
		);
		const idx = args.indexOf("--import-picture-from");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBe("/tmp/cover.jpg");
	});

	it("omits --import-picture-from when artPath is absent", () => {
		const args = buildMetaflacArgs({ title: "T", artist: "A", album: "Al", track: 0 }, "song.flac");
		expect(args).not.toContain("--import-picture-from");
	});

	it("still places the file path last when artPath is set", () => {
		const args = buildMetaflacArgs(
			{ title: "T", artist: "A", album: "Al", track: 1, artPath: "cover.png" },
			"song.flac",
		);
		expect(args.at(-1)).toBe("song.flac");
	});

	it("is a pure function: same input → same output, no side effects", () => {
		const input = { title: "T", artist: "A", album: "Al", track: 5, artPath: "c.png" };
		const a = buildMetaflacArgs(input, "x.flac");
		const b = buildMetaflacArgs(input, "x.flac");
		expect(a).toEqual(b);
		// Does not mutate the input tags.
		expect(input).toEqual({ title: "T", artist: "A", album: "Al", track: 5, artPath: "c.png" });
	});
});

// ─── Integration: real metaflac + ffmpeg + music-metadata round-trip ─────────

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "tagger-test-"));
});
afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** Generate a minimal 1s FLAC tone via ffmpeg. */
async function makeFlac(path: string, seconds = 1): Promise<void> {
	await execFile(FFMPEG, [
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}`,
		"-c:a",
		"flac",
		"-y",
		path,
	]);
}

describe("createTagWriter (integration against real metaflac)", () => {
	it("writes text tags to a real FLAC and they round-trip via the reader", async () => {
		const path = join(workDir, "song.flac");
		await makeFlac(path);

		const writer = createTagWriter(METAFLAC);
		const reader = createTagReader();
		const tags = {
			title: "Never Gonna Give You Up",
			artist: "Rick Astley",
			album: "Whenever You Need Somebody",
			track: 7,
			duration: 0,
			format: "flac" as const,
		};
		await writer.write(path, tags);

		const read = await reader.read(path);
		expect(read.title).toBe("Never Gonna Give You Up");
		expect(read.artist).toBe("Rick Astley");
		expect(read.album).toBe("Whenever You Need Somebody");
		expect(read.track).toBe(7);
		expect(read.format).toBe("flac");
		// duration is read from the audio stream, not the Vorbis comments — the
		// 1s tone should decode to ~1s.
		expect(read.duration).toBeGreaterThan(0.5);
		expect(read.duration).toBeLessThan(1.5);
	});

	it("overwrites existing tags when re-writing a FLAC (remove-all-tags works)", async () => {
		const path = join(workDir, "song.flac");
		await makeFlac(path);

		const writer = createTagWriter(METAFLAC);
		await writer.write(path, {
			title: "Old Title",
			artist: "Old Artist",
			album: "Old Album",
			track: 1,
			duration: 0,
			format: "flac",
		});
		await writer.write(path, {
			title: "New Title",
			artist: "New Artist",
			album: "New Album",
			track: 2,
			duration: 0,
			format: "flac",
		});

		const read = await createTagReader().read(path);
		expect(read.title).toBe("New Title");
		expect(read.artist).toBe("New Artist");
		expect(read.album).toBe("New Album");
		expect(read.track).toBe(2);
	});

	it("writes a FLAC with empty fields and they read back as empty strings", async () => {
		const path = join(workDir, "untagged.flac");
		await makeFlac(path);

		const writer = createTagWriter(METAFLAC);
		await writer.write(path, {
			title: "",
			artist: "",
			album: "",
			track: 0,
			duration: 0,
			format: "flac",
		});

		const read = await createTagReader().read(path);
		expect(read.title).toBe("");
		expect(read.artist).toBe("");
		expect(read.album).toBe("");
		expect(read.track).toBe(0);
	});

	it("handles special characters in FLAC tag values round-trip", async () => {
		const path = join(workDir, "special.flac");
		await makeFlac(path);

		const writer = createTagWriter(METAFLAC);
		await writer.write(path, {
			title: 'Say "Hi"; O\'Brien',
			artist: "A;B=C",
			album: "Al/bum",
			track: 9,
			duration: 0,
			format: "flac",
		});

		const read = await createTagReader().read(path);
		expect(read.title).toBe('Say "Hi"; O\'Brien');
		expect(read.artist).toBe("A;B=C");
		expect(read.album).toBe("Al/bum");
		expect(read.track).toBe(9);
	});

	it("still writes MP3 tags via node-id3 (regression)", async () => {
		const path = join(workDir, "song.mp3");
		await execFile(FFMPEG, [
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:a",
			"libmp3lame",
			"-y",
			path,
		]);

		const writer = createTagWriter(METAFLAC);
		const reader = createTagReader();
		await writer.write(path, {
			title: "MP3 Title",
			artist: "MP3 Artist",
			album: "MP3 Album",
			track: 4,
			duration: 0,
			format: "mp3",
		});

		const read = await reader.read(path);
		expect(read.title).toBe("MP3 Title");
		expect(read.artist).toBe("MP3 Artist");
		expect(read.album).toBe("MP3 Album");
		expect(read.track).toBe(4);
		expect(read.format).toBe("mp3");
	});

	it("embeds front-cover art (APIC) into an MP3 via artPath", async () => {
		const path = join(workDir, "art.mp3");
		const coverPath = join(workDir, "cover.jpg");
		await execFile(FFMPEG, [
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:a",
			"libmp3lame",
			"-y",
			path,
		]);
		// A small valid JPEG (testsrc → 64x64 → mjpeg).
		await execFile(FFMPEG, [
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=64x64:d=1",
			"-frames:v",
			"1",
			"-q:v",
			"2",
			"-y",
			coverPath,
		]);

		const writer = createTagWriter(METAFLAC);
		await writer.write(path, {
			title: "Art Title",
			artist: "Art Artist",
			album: "Art Album",
			track: 1,
			duration: 0,
			format: "mp3",
			artPath: coverPath,
		});

		// Verify the APIC frame was written by reading raw ID3 tags directly.
		const NodeID3 = (await import("node-id3")).default;
		const raw = NodeID3.read(path) as { image?: { imageBuffer?: Buffer; type?: { id: number } } };
		expect(raw.image).toBeDefined();
		expect(raw.image?.imageBuffer).toBeInstanceOf(Buffer);
		expect(raw.image?.imageBuffer?.length).toBeGreaterThan(0);
		// Picture type 3 = front cover.
		expect(raw.image?.type?.id).toBe(3);
	});

	it("embeds front-cover art (PICTURE block) into a FLAC via artPath", async () => {
		const path = join(workDir, "art.flac");
		const coverPath = join(workDir, "cover.png");
		await makeFlac(path);
		// A small valid PNG.
		await execFile(FFMPEG, [
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=64x64:d=1",
			"-frames:v",
			"1",
			"-y",
			coverPath,
		]);

		const writer = createTagWriter(METAFLAC);
		await writer.write(path, {
			title: "Flac Art Title",
			artist: "Flac Art Artist",
			album: "Flac Art Album",
			track: 2,
			duration: 0,
			format: "flac",
			artPath: coverPath,
		});

		// metaflac --list shows the PICTURE block; verify it was written.
		const { stdout } = await execFile(METAFLAC, ["--list", path]);
		expect(stdout).toContain("PICTURE");
		expect(stdout).toContain("type: 3"); // front cover
	});

	it("writes MP3 tags without art when artPath is absent (regression)", async () => {
		const path = join(workDir, "noart.mp3");
		await execFile(FFMPEG, [
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:a",
			"libmp3lame",
			"-y",
			path,
		]);

		const writer = createTagWriter(METAFLAC);
		await writer.write(path, {
			title: "No Art",
			artist: "A",
			album: "Al",
			track: 1,
			duration: 0,
			format: "mp3",
		});

		const NodeID3 = (await import("node-id3")).default;
		const raw = NodeID3.read(path) as { image?: unknown };
		expect(raw.image).toBeUndefined();
	});

	it("throws a clear error for an unsupported format", async () => {
		const writer = createTagWriter(METAFLAC);
		await expect(
			writer.write(join(workDir, "song.wav"), {
				title: "T",
				artist: "A",
				album: "Al",
				track: 0,
				duration: 0,
				format: "flac",
			}),
		).rejects.toThrow(/MP3.*FLAC.*only/);
	});
});
