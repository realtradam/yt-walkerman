/**
 * @yt-music/tagger — read/write audio tags.
 *
 * Reads tags from ANY format via `music-metadata` (the read side). Writes:
 *  - MP3  via `node-id3` (ID3v2)
 *  - FLAC via the `metaflac` CLI binary (Vorbis comments + PICTURE block)
 * The download path already embeds tags via yt-dlp `--embed-metadata`; this
 * package is for reading/verifying tags and for the user-tag-editing feature.
 *
 * ARCHITECTURE: pure core (detectFormat, toTags, buildId3Tags, buildMetaflacArgs)
 * + injected shell (createTagReader, createTagWriter). The pure functions map
 * between our domain types and the library-specific raw shapes; the shell wires
 * them to the real fs reads/writes. See .research/04-audio-tagging-and-formats.md.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AudioFormat } from "@yt-music/contract";

const execFile = promisify(execFileCb);

// ─── Domain types ────────────────────────────────────────────────────────────

/**
 * The common metadata we read from / write to an audio file.
 *
 * Structurally `Track` without `{ id, path }` — the library derives a Track by
 * adding those two. Kept aligned with `@yt-music/contract`'s `Track` BY
 * CONVENTION (the contract is types-only and cannot import this package).
 */
export interface Tags {
	title: string;
	artist: string;
	album: string;
	/** 1-based track number; 0 when unknown. Written to the file's tags and used
	 * by path templates as `{track}`. */
	track: number;
	duration: number;
	format: AudioFormat;
	/** Optional path to a JPEG/PNG file to embed as front-cover art. For FLAC
	 * this becomes `--import-picture-from=<path>` (metaflac reads the file);
	 * for MP3 this becomes the node-id3 `image` field (node-id3 reads the file,
	 * auto-detects the MIME type, and defaults to front-cover type 3). When
	 * omitted, no picture frame/block is written. */
	artPath?: string;
}

/**
 * The subset of `music-metadata`'s `IAudioMetadata` we consume. Defined locally
 * (not imported) so the pure core stays free of the library's types — the shell
 * copies the fields it needs into this shape.
 */
export interface RawMetadata {
	common: {
		title: string | undefined;
		artist: string | undefined;
		album: string | undefined;
		trackNo: number | undefined;
	};
	format: { duration: number | undefined };
}

/** The ID3v2 tag frame shape `node-id3` writes. */
export interface Id3Tags {
	title: string;
	artist: string;
	album: string;
	/** TRCK frame, e.g. "3". Only set when track > 0. */
	trackNumber?: string;
	/** APIC (attached picture) front-cover frame. A path to a JPEG/PNG file:
	 * node-id3 reads the file itself, auto-detects the MIME type, and defaults
	 * to picture type 3 (front cover). Only set when `Tags.artPath` is present. */
	image?: string;
}

// ─── Pure core ───────────────────────────────────────────────────────────────

/**
 * Detect the audio format from a file path's extension.
 * Pure: (path) → AudioFormat | null. Case-insensitive. Returns null for
 * unsupported extensions (only flac/mp3 are tracked here).
 */
export function detectFormat(filePath: string): AudioFormat | null {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return null;
	const ext = filePath.slice(dot + 1).toLowerCase();
	if (ext === "mp3") return "mp3";
	if (ext === "flac") return "flac";
	return null;
}

/**
 * Map raw parsed metadata + a known format into normalized `Tags`.
 * Pure: (raw, format) → Tags. Normalizes absent fields to "" / 0 so a Tags is
 * always fully populated (the contract `Track` requires non-optional strings).
 */
export function toTags(raw: RawMetadata, format: AudioFormat): Tags {
	return {
		title: raw.common.title ?? "",
		artist: raw.common.artist ?? "",
		album: raw.common.album ?? "",
		track: raw.common.trackNo ?? 0,
		duration: raw.format.duration ?? 0,
		format,
	};
}

/**
 * Map our `Tags` into the `node-id3` frame shape (ID3v2). Pure.
 * Text frames title/artist/album are always mapped; the TRCK (trackNumber)
 * frame is only set when track > 0. APIC (album art) is set as a file path
 * string when `tags.artPath` is present — node-id3 reads the file itself,
 * auto-detects the MIME type, and defaults to picture type 3 (front cover).
 */
export function buildId3Tags(tags: Tags): Id3Tags {
	const id3: Id3Tags = {
		title: tags.title,
		artist: tags.artist,
		album: tags.album,
	};
	if (tags.track > 0) {
		id3.trackNumber = String(tags.track);
	}
	if (tags.artPath) {
		id3.image = tags.artPath;
	}
	return id3;
}

/**
 * The subset of `Tags` that metaflac writes as Vorbis comments. `duration` and
 * `format` are not Vorbis fields (duration is derived from the audio stream;
 * format is implied by the container), so they are excluded from the arg set.
 */
export interface MetaflacTags {
	title: string;
	artist: string;
	album: string;
	track: number;
	/** Path to a picture file to embed as the front-cover PICTURE block.
	 * When set, `--import-picture-from=<path>` is emitted (the shorthand form,
	 * which defaults to TYPE=3 front cover). When omitted, no picture is written. */
	artPath?: string;
}

/**
 * Build the `metaflac` argv to (1) wipe existing Vorbis comments, (2) write the
 * text fields (TITLE/ARTIST/ALBUM/TRACKNUMBER), and (3) optionally import a
 * front-cover PICTURE block. Pure: (tags, filePath) → string[]. Zero I/O.
 *
 * The argv is shaped for `execFile`/`Bun.spawn` (NOT a shell): each array
 * element is one raw argv token, so values containing `;`, `'`, `"`, newlines,
 * etc. are passed verbatim — no shell quoting/escaping is needed or wanted.
 * metaflac parses `--set-tag FIELD=VALUE` (two tokens) and handles arbitrary
 * field-value bytes correctly (verified against metaflac 1.5.0).
 *
 * TRACKNUMBER is emitted as a base-10 string only when track > 0 (matching the
 * ID3 TRCK behavior in `buildId3Tags`). Empty text fields are OMITTED: because
 * `--remove-all-tags` already wiped every existing Vorbis comment, an omitted
 * field is simply absent — and the reader normalizes absent → "" (so an explicit
 * clear, e.g. artist="", round-trips correctly).
 */
export function buildMetaflacArgs(tags: MetaflacTags, filePath: string): string[] {
	const args: string[] = ["--remove-all-tags"];
	if (tags.title !== "") args.push("--set-tag", `TITLE=${tags.title}`);
	if (tags.artist !== "") args.push("--set-tag", `ARTIST=${tags.artist}`);
	if (tags.album !== "") args.push("--set-tag", `ALBUM=${tags.album}`);
	if (tags.track > 0) args.push("--set-tag", `TRACKNUMBER=${String(tags.track)}`);
	if (tags.artPath) args.push("--import-picture-from", tags.artPath);
	args.push(filePath);
	return args;
}

// ─── Injected shell ─────────────────────────────────────────────────────────

/** Reads tags from an audio file. The injected effect. */
export interface TagReader {
	read(filePath: string): Promise<Tags>;
}

/** Writes tags to an audio file. The injected effect. */
export interface TagWriter {
	write(filePath: string, tags: Tags): Promise<void>;
}

/**
 * Create a `TagReader` backed by `music-metadata.parseFile`.
 *
 * EFFECT: reads the file from disk. The pure `toTags`/`detectFormat` mapping is
 * what's unit-tested; this just wires parseFile → RawMetadata → toTags.
 */
export function createTagReader(): TagReader {
	return {
		async read(filePath: string): Promise<Tags> {
			const format = detectFormat(filePath);
			if (!format) {
				throw new Error(`tagger: unsupported audio format: ${filePath}`);
			}
			const { parseFile } = await import("music-metadata");
			const md = await parseFile(filePath);
			const raw: RawMetadata = {
				common: {
					title: md.common.title,
					artist: md.common.artist,
					album: md.common.album,
					trackNo: md.common.track?.no ?? undefined,
				},
				format: { duration: md.format.duration },
			};
			return toTags(raw, format);
		},
	};
}

/**
 * Resolve the metaflac binary: explicit → env → `Bun.which('metaflac')` (Bun
 * runtime only) → bare 'metaflac' (the shell's PATH lookup). Mirrors the
 * cutter's `resolveFfmpeg`. Under Node/vitest `Bun` is undefined, so callers
 * that run there pass an explicit path (the tests do).
 */
function resolveMetaflac(explicit?: string): string {
	if (explicit) return explicit;
	const env = process.env.YTMDL_METAFLAC_PATH;
	if (env) return env;
	// `Bun.which` is a Bun-runtime global; guard so this module also loads under
	// Node (vitest) where `Bun` is not defined.
	if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
		return Bun.which("metaflac") ?? "metaflac";
	}
	return "metaflac";
}

/**
 * Create a `TagWriter` that dispatches by format:
 *  - MP3  → `node-id3` (ID3v2)
 *  - FLAC → the `metaflac` CLI binary (Vorbis comments via `buildMetaflacArgs`)
 *
 * EFFECT: writes the file in place. The pure `buildId3Tags` / `buildMetaflacArgs`
 * mapping is what's unit-tested; this just wires it to the real writers.
 *
 * `metaflacBin` defaults to `resolveMetaflac()` (env → `Bun.which` → 'metaflac')
 * so the binary is resolved once at writer-construction time (not per write).
 * Pass an explicit path (e.g. `process.env.YTMDL_METAFLAC_PATH`) to override.
 *
 * Spawns metaflac via `node:child_process` `execFile` (NOT `Bun.spawn`) so the
 * writer works under both Node/vitest and Bun at runtime — same approach as the
 * cutter (see packages/cutter). Each argv token is one raw element; no shell is
 * involved, so tag values with `;`/`'`/`"`/newlines pass through verbatim.
 */
export function createTagWriter(metaflacBin?: string): TagWriter {
	const resolvedMetaflac = resolveMetaflac(metaflacBin);
	return {
		async write(filePath: string, tags: Tags): Promise<void> {
			const format = detectFormat(filePath);
			if (format === "mp3") {
				const NodeID3 = (await import("node-id3")).default;
				const id3 = buildId3Tags(tags);
				// node-id3.write(tags, filepath) returns `true` on success or an `Error`.
				const result = NodeID3.write(id3, filePath);
				if (result instanceof Error) {
					throw new Error(`tagger: node-id3 write failed: ${filePath}: ${result.message}`);
				}
				return;
			}
			if (format === "flac") {
				const metaflacArgs = buildMetaflacArgs(tags, filePath);
				try {
					await execFile(resolvedMetaflac, metaflacArgs, { maxBuffer: 1024 * 1024 });
				} catch (err) {
					const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
					throw new Error(
						`tagger: metaflac write failed: ${filePath}: ${stderr.trim().slice(-500) || String(err)}`,
					);
				}
				return;
			}
			throw new Error(
				`tagger: write supports MP3 (node-id3) and FLAC (metaflac) only, got: ${filePath}`,
			);
		},
	};
}
