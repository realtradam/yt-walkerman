import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Track, UpdateTrackRequest } from "@yt-music/contract";
import type { TagReader, Tags, TagWriter } from "@yt-music/tagger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary, isAudioFile, toTrack, trackId } from "./index.js";

const flacTags: Tags = {
	title: "Song",
	artist: "Artist",
	album: "Album",
	track: 0,
	duration: 180,
	format: "flac",
};

describe("isAudioFile (pure)", () => {
	it("accepts mp3 and flac", () => {
		expect(isAudioFile("a.mp3")).toBe(true);
		expect(isAudioFile("a.flac")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isAudioFile("A.MP3")).toBe(true);
		expect(isAudioFile("A.FLAC")).toBe(true);
	});

	it("rejects non-audio and unsupported formats", () => {
		expect(isAudioFile("notes.txt")).toBe(false);
		expect(isAudioFile("clip.wav")).toBe(false);
		expect(isAudioFile("README")).toBe(false);
	});
});

describe("trackId (pure)", () => {
	it("is deterministic for the same path", () => {
		expect(trackId("/music/song.flac")).toBe(trackId("/music/song.flac"));
	});

	it("differs for different paths", () => {
		expect(trackId("/music/song.flac")).not.toBe(trackId("/music/other.flac"));
		expect(trackId("/a.mp3")).not.toBe(trackId("/b.mp3"));
	});

	it("is a hex string", () => {
		expect(trackId("/x.mp3")).toMatch(/^[0-9a-f]+$/);
	});
});

describe("toTrack (pure)", () => {
	it("derives a Track with id + path from the tags", () => {
		const path = "/output/Artist - Song.flac";
		const track = toTrack(path, flacTags);
		expect(track.id).toBe(trackId(path));
		expect(track.path).toBe(path);
		expect(track.title).toBe("Song");
		expect(track.artist).toBe("Artist");
		expect(track.album).toBe("Album");
		expect(track.duration).toBe(180);
		expect(track.format).toBe("flac");
	});

	it("produces a stable id matching trackId", () => {
		const path = "/output/Track.mp3";
		expect(toTrack(path, { ...flacTags, format: "mp3" }).id).toBe(trackId(path));
	});

	it("preserves the format from tags", () => {
		expect(toTrack("/a.flac", flacTags).format).toBe("flac");
		expect(toTrack("/a.mp3", { ...flacTags, format: "mp3" }).format).toBe("mp3");
	});

	it("surfaces track number only when > 0", () => {
		expect(toTrack("/a.flac", { ...flacTags, track: 0 }).track).toBeUndefined();
		expect(toTrack("/a.flac", { ...flacTags, track: 3 }).track).toBe(3);
	});
});

// ─── Shell (integration): real temp dir + injected fake reader/writer ─────────
// The shell walks a real filesystem and renames real files. We inject a fake
// TagReader/TagWriter (mocking the OUTERMOST edge — the tag library — is fine
// per AGENTS.md; we never mock our own modules).

const settings: Settings = {
	outputDir: "", // set per-test to the temp dir
	format: "flac",
	pathTemplate: "{artist}/{album}/{track} - {title}.{ext}",
};

/** A fake TagReader backed by an in-memory map: path → Tags. */
function fakeReader(store: Map<string, Tags>): TagReader {
	return {
		async read(filePath: string): Promise<Tags> {
			const t = store.get(filePath);
			if (!t) throw new Error(`fake reader: no tags for ${filePath}`);
			return t;
		},
	};
}

/** A fake TagWriter that updates the in-memory store (no real tag lib). */
function fakeWriter(store: Map<string, Tags>): TagWriter {
	return {
		async write(filePath: string, tags: Tags): Promise<void> {
			store.set(filePath, tags);
		},
	};
}

describe("createLibrary shell", () => {
	let dir: string;
	let store: Map<string, Tags>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ytmdl-lib-"));
		store = new Map();
		settings.outputDir = dir;
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("listTracks scans audio files and reads their tags", async () => {
		const p = join(dir, "song.flac");
		await writeFile(p, "fake");
		store.set(p, { ...flacTags, title: "Alpha", artist: "AAA" });
		const lib = createLibrary(dir, fakeReader(store));
		const tracks = await lib.listTracks();
		expect(tracks).toHaveLength(1);
		expect(tracks[0]?.title).toBe("Alpha");
		expect(tracks[0]?.path).toBe(p);
	});

	it("applyPathTemplate moves a file to the templated path", async () => {
		const src = join(dir, "raw.flac");
		await writeFile(src, "fake");
		store.set(src, {
			title: "Speak to Me",
			artist: "Pink Floyd",
			album: "DSOTM",
			track: 1,
			duration: 90,
			format: "flac",
		});
		const lib = createLibrary(dir, fakeReader(store));
		const newPath = await lib.applyPathTemplate(src, settings);
		expect(newPath).toBe(join(dir, "Pink Floyd", "DSOTM", "01 - Speak to Me.flac"));
		// The file is no longer at the source, now at the target.
		const { access } = await import("node:fs/promises");
		await expect(access(src)).rejects.toThrow();
		await expect(access(newPath)).resolves.toBeUndefined();
	});

	it("applyPathTemplate is a no-op when already at the target", async () => {
		const sub = join(dir, "Pink Floyd", "DSOTM");
		await import("node:fs/promises").then((f) => f.mkdir(sub, { recursive: true }));
		const target = join(sub, "01 - Speak to Me.flac");
		await writeFile(target, "fake");
		store.set(target, {
			title: "Speak to Me",
			artist: "Pink Floyd",
			album: "DSOTM",
			track: 1,
			duration: 90,
			format: "flac",
		});
		const lib = createLibrary(dir, fakeReader(store));
		const result = await lib.applyPathTemplate(target, settings);
		expect(result).toBe(target);
	});

	it("renameTrack writes merged tags and moves the file", async () => {
		const src = join(dir, "untitled.flac");
		await writeFile(src, "fake");
		store.set(src, { ...flacTags, title: "Old", artist: "Old", album: "Old", track: 0 });
		const lib = createLibrary(dir, fakeReader(store), fakeWriter(store));

		const id = trackId(src);
		const patch: UpdateTrackRequest = {
			title: "New Title",
			artist: "New Artist",
			album: "New Album",
			track: 5,
		};
		const updated: Track = await lib.renameTrack(id, patch, settings);

		// Moved to the templated path reflecting the NEW tags.
		expect(updated.path).toBe(join(dir, "New Artist", "New Album", "05 - New Title.flac"));
		expect(updated.title).toBe("New Title");
		expect(updated.artist).toBe("New Artist");
		expect(updated.track).toBe(5);
		// The id changed (derived from the new path).
		expect(updated.id).not.toBe(id);
		expect(updated.id).toBe(trackId(updated.path));
		// Source is gone.
		const { access } = await import("node:fs/promises");
		await expect(access(src)).rejects.toThrow();
	});

	it("renameTrack merges only provided fields (preserves the rest)", async () => {
		const src = join(dir, "track.flac");
		await writeFile(src, "fake");
		store.set(src, { ...flacTags, title: "Keep", artist: "KeepA", album: "KeepAl", track: 2 });
		const lib = createLibrary(dir, fakeReader(store), fakeWriter(store));

		const updated = await lib.renameTrack(trackId(src), { title: "Changed" }, settings);
		expect(updated.title).toBe("Changed");
		expect(updated.artist).toBe("KeepA");
		expect(updated.album).toBe("KeepAl");
		expect(updated.track).toBe(2);
		expect(updated.path).toBe(join(dir, "KeepA", "KeepAl", "02 - Changed.flac"));
	});

	it("renameTrack throws for an unknown trackId", async () => {
		const lib = createLibrary(dir, fakeReader(store), fakeWriter(store));
		await expect(lib.renameTrack("nope", {}, settings)).rejects.toThrow("track not found");
	});

	it("renameTrack throws when no writer was injected", async () => {
		const src = join(dir, "track.flac");
		await writeFile(src, "fake");
		store.set(src, flacTags);
		const lib = createLibrary(dir, fakeReader(store)); // no writer
		await expect(lib.renameTrack(trackId(src), { title: "X" }, settings)).rejects.toThrow(
			"TagWriter",
		);
	});
});
