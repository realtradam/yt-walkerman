/**
 * @yt-music/library — scan the output directory, index tagged tracks, and
 * organize (move/rename) them to match a path template.
 *
 * Scans `outputDir` for audio files, reads each one's tags via the injected
 * `TagReader` (from `@yt-music/tagger`, which uses `music-metadata`), and
 * exposes `listTracks(): Promise<Track[]>`. The organize side renders a path
 * template via the PURE `renderPathTemplate` (`@yt-music/path-template`) and
 * moves files on disk (the injected effect here).
 *
 * ARCHITECTURE: pure core (trackId, isAudioFile, toTrack, and the imported
 * renderPathTemplate) + injected shell (createLibrary). The pure functions
 * derive a stable id and a `Track` from a path + `Tags`; the shell walks the
 * filesystem, reads tags, and renames files. Reading is delegated to the
 * tagger — the library does NOT import music-metadata itself (single owner of
 * tag parsing = the tagger). See GLOSSARY.md ("track").
 */
import type { Settings, Track, UpdateTrackRequest } from "@yt-music/contract";
import { renderPathTemplate } from "@yt-music/path-template";
import { detectFormat, type TagReader, type Tags, type TagWriter } from "@yt-music/tagger";

// ─── Pure core ───────────────────────────────────────────────────────────────

/**
 * A stable id for a track, derived from its file path.
 * Pure: (path) → id. Deterministic so the same file yields the same id across
 * scans (the frontend keys rows on it). Uses the cyrb53 hash — a non-crypto
 * hash with good 53-bit distribution, no imports, fully pure.
 */
export function trackId(filePath: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < filePath.length; i++) {
		const ch = filePath.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Whether a path looks like an indexable audio file (flac/mp3).
 * Pure: delegates to the tagger's `detectFormat`.
 */
export function isAudioFile(filePath: string): boolean {
	return detectFormat(filePath) !== null;
}

/**
 * Derive a `Track` from a file path + its read `Tags`.
 * Pure: (path, tags) → Track. `Tags` is structurally `Track` without
 * `{ id, path }`, so the result is exactly the contract's `Track` shape.
 */
export function toTrack(filePath: string, tags: Tags): Track {
	const track: Track = {
		id: trackId(filePath),
		path: filePath,
		title: tags.title,
		artist: tags.artist,
		album: tags.album,
		duration: tags.duration,
		format: tags.format,
	};
	// `track` is optional on Track; only surface it when known (> 0) so an
	// absent track number stays absent rather than a misleading 0.
	if (tags.track > 0) {
		track.track = tags.track;
	}
	return track;
}

// ─── Injected shell ─────────────────────────────────────────────────────────

/** Indexes + organizes the audio collection. The injected effect. */
export interface Library {
	listTracks(): Promise<Track[]>;
	/**
	 * Move a single file to the location its tags + the path template dictate.
	 * Returns the new absolute path. If the file is already at the target, the
	 * path is returned unchanged (no move).
	 */
	applyPathTemplate(filePath: string, settings: Settings): Promise<string>;
	/**
	 * Update a track's tags (only the provided fields) and move/rename the file
	 * to match the path template. Returns the updated `Track` (new path + id).
	 * Throws if the trackId is not found, or if no TagWriter was injected.
	 *
	 * `artPath` is an optional path to a downloaded cover-art temp file: when
	 * set, it is embedded as a front-cover picture (the network download lives
	 * at the host edge — the library does only fs via the injected writer).
	 */
	renameTrack(
		trackId: string,
		newTags: UpdateTrackRequest,
		settings: Settings,
		artPath?: string,
	): Promise<Track>;
}

/**
 * Create a `Library` that scans `outputDir` (recursively), reads each audio
 * file's tags via the injected `reader`, and returns `Track[]`. The optional
 * `writer` enables `renameTrack` (rewriting tags before moving).
 *
 * EFFECT: reads the filesystem + each file's tags; renames files for organize /
 * rename. The pure `toTrack`/`isAudioFile`/`renderPathTemplate` mapping is
 * what's unit-tested; this walks the real directory. Unreadable or corrupt
 * files are skipped (logged) rather than failing the whole scan.
 */
export function createLibrary(outputDir: string, reader: TagReader, writer?: TagWriter): Library {
	return {
		async listTracks(): Promise<Track[]> {
			const files = await listAudioFiles(outputDir);
			const tracks: Track[] = [];
			for (const file of files) {
				try {
					const tags = await reader.read(file);
					tracks.push(toTrack(file, tags));
				} catch (err) {
					console.warn(`[library] skipping unreadable file: ${file}: ${String(err)}`);
				}
			}
			// Sort by artist then title for a stable, browsable order.
			tracks.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
			return tracks;
		},

		async applyPathTemplate(filePath: string, settings: Settings): Promise<string> {
			const { rename, mkdir } = await import("node:fs/promises");
			const { dirname, join, isAbsolute, resolve } = await import("node:path");

			// Read the file's current tags to render the template from real data.
			const tags = await reader.read(filePath);
			const rel = renderPathTemplate(settings.pathTemplate, {
				artist: tags.artist,
				album: tags.album,
				track: tags.track,
				title: tags.title,
				ext: tags.format,
			});
			// Target is anchored at the collection root (outputDir). The rendered
			// path is traversal-safe (see @yt-music/path-template), so join is safe.
			const target = isAbsolute(outputDir) ? join(outputDir, rel) : resolve(outputDir, rel);

			// Already in the right place? No-op (compare absolute paths).
			const srcAbs = isAbsolute(filePath) ? filePath : resolve(filePath);
			if (srcAbs === target) return target;

			// Ensure the destination directory exists, then move atomically-ish.
			await mkdir(dirname(target), { recursive: true });
			await rename(filePath, target);
			return target;
		},

		async renameTrack(
			id: string,
			newTags: UpdateTrackRequest,
			settings: Settings,
			artPath?: string,
		): Promise<Track> {
			if (!writer) {
				throw new Error("library: renameTrack requires a TagWriter (none was injected)");
			}
			// Find the file whose path hashes to the given trackId.
			const files = await listAudioFiles(outputDir);
			const src = files.find((f) => trackId(f) === id);
			if (!src) {
				throw new Error(`library: track not found: ${id}`);
			}

			// Read current tags, merge in only the provided fields, write back.
			const current = await reader.read(src);
			const merged: Tags = {
				title: newTags.title ?? current.title,
				artist: newTags.artist ?? current.artist,
				album: newTags.album ?? current.album,
				track: newTags.track ?? current.track,
				duration: current.duration,
				format: current.format,
			};
			// Embed front-cover art when a downloaded image path was provided.
			if (artPath) {
				merged.artPath = artPath;
			}
			await writer.write(src, merged);

			// Move the file to its templated location (uses the freshly-written
			// tags, re-read by applyPathTemplate to render the path).
			const newPath = await this.applyPathTemplate(src, settings);
			// The merged tags ARE the final tags on disk; derive the Track from the
			// new path + merged tags (the id is derived from the new path).
			return toTrack(newPath, merged);
		},
	};
}

/**
 * Walk `dir` recursively and return absolute paths of audio files.
 * EFFECT: reads the filesystem.
 */
async function listAudioFiles(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const out: string[] = [];
	async function walk(current: string): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return; // unreadable subdirectory — skip
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && isAudioFile(entry.name)) {
				out.push(full);
			}
		}
	}
	await walk(dir);
	return out;
}
