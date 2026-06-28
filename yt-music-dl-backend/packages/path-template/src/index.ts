/**
 * @yt-music/path-template — PURE CORE.
 *
 * Renders a path template string (e.g. `{artist}/{album}/{track} - {title}.{ext}`)
 * against track metadata, producing a sanitized, traversal-safe RELATIVE path
 * like `Pink Floyd/The Dark Side of the Moon/01 - Speak to Me.flac`.
 *
 * Pure `input → output` with ZERO I/O (no fs, no sqlite, no subprocess, no
 * network). Fully unit-tested with zero mocks (a test that mocks our own module
 * is a DESIGN BUG — see AGENTS.md). The injected effect (actually moving the
 * file on disk) lives in `@yt-music/library`.
 *
 * Template variables (see GLOSSARY.md "track"):
 *   {artist} — track artist      (fallback "Unknown Artist")
 *   {album}  — album name        (fallback "Unknown Album")
 *   {track}  — track number, zero-padded to 2  (fallback "00")
 *   {title}  — track title       (fallback "Untitled")
 *   {ext}    — file extension without the dot (fallback "")
 *
 * Sanitization rules:
 *   - Each path component (between `/`) has illegal chars `/ \ : * ? " < > |`
 *     replaced with `_`.
 *   - Leading/trailing dots and spaces are stripped from each component.
 *   - Empty components, `.`, and `..` collapse to `_` (defeats path traversal).
 */

/** The variables substituted into a path template. */
export interface PathTemplateVars {
	artist?: string;
	album?: string;
	/** 1-based track number; zero-padded to 2 digits when rendered. */
	track?: number;
	title?: string;
	/** Extension without the leading dot, e.g. "flac", "mp3". */
	ext?: string;
}

/** Default path template — mirrors the Phase 5 spec. */
export const DEFAULT_PATH_TEMPLATE = "{artist}/{album}/{track} - {title}.{ext}";

// ─── Pure core ───────────────────────────────────────────────────────────────

/** Characters disallowed in a single filesystem path component. */
const ILLEGAL_CHARS = /[/\\:*?"<>|]/g;
/** Leading/trailing dots and whitespace — stripped from each component. */
const TRIM_CHARS = /^[\s.]+|[\s.]+$/g;

/**
 * Sanitize a single path component: replace illegal chars with `_`, then strip
 * leading/trailing dots and spaces.
 * Pure: (string) → string. Does NOT collapse the result if empty (the caller
 * decides the fallback, e.g. `_` or `Unknown Artist`).
 */
export function sanitizePathComponent(s: string): string {
	return s.replace(ILLEGAL_CHARS, "_").replace(TRIM_CHARS, "");
}

/**
 * Zero-pad a track number to at least 2 digits (1 → "01", 10 → "10", 100 →
 * "100"). A non-positive or absent track yields "00".
 * Pure: (number | undefined) → string.
 */
export function padTrackNumber(track: number | undefined): string {
	if (track === undefined || track <= 0 || !Number.isFinite(track)) return "00";
	return String(track).padStart(2, "0");
}

/**
 * Resolve one template variable: sanitize the value for use as a path
 * component, then apply the field's fallback when the sanitized result is empty
 * (so dots-only / whitespace-only values never produce an empty component).
 * Pure.
 */
function resolveField(value: string | undefined, fallback: string): string {
	const s = sanitizePathComponent((value ?? "").trim());
	return s.length > 0 ? s : fallback;
}

/**
 * Render a path template against track metadata.
 *
 * Returns a sanitized RELATIVE path with `/` as the separator. The result is
 * traversal-safe: no component can be `.`, `..`, or escape the base directory.
 *
 * Pure: (template, vars) → string. Zero I/O.
 *
 * @example
 * renderPathTemplate("{artist}/{album}/{track} - {title}.{ext}", {
 *   artist: "Pink Floyd", album: "DSOTM", track: 1, title: "Speak to Me", ext: "flac"
 * })
 * // → "Pink Floyd/DSOTM/01 - Speak to Me.flac"
 */
export function renderPathTemplate(template: string, vars: PathTemplateVars): string {
	const artist = resolveField(vars.artist, "Unknown Artist");
	const album = resolveField(vars.album, "Unknown Album");
	const title = resolveField(vars.title, "Untitled");
	const track = padTrackNumber(vars.track);
	const ext = (vars.ext ?? "").trim();

	// Substitute raw values into the template. `track` and `ext` are safe
	// (numeric / controlled), but they also pass through the component
	// sanitizer below, so nothing can slip through.
	const rendered = template
		.split("{artist}")
		.join(artist)
		.split("{album}")
		.join(album)
		.split("{track}")
		.join(track)
		.split("{title}")
		.join(title)
		.split("{ext}")
		.join(ext);

	// Post-process: split into components, sanitize each. `sanitizePathComponent`
	// already turns `/`→`_` (so a field value can never inject a separator) and
	// strips dots (so `..`/`.` collapse to empty). We then drop empty components
	// (from stray "//" or a trailing "/" in the template). The result can never
	// contain a `..` component or a leading `/` — i.e. no upward traversal.
	const safe = rendered
		.split("/")
		.map((comp) => sanitizePathComponent(comp))
		.filter((comp) => comp !== "");

	// Join, strip any leading "/" (the path is relative to outputDir), collapse
	// adjacent slashes, and strip a trailing slash. (Belt-and-suspenders: the
	// filter above already removed empty components.)
	return safe.join("/").replace(/^\/+/, "").replace(/\/\/+/g, "/").replace(/\/+$/, "");
}
