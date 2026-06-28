/**
 * src/features/settings/logic.ts — PURE: settings view-model + reducers.
 *
 * No DOM, no fetch, no WebSocket — pure (input → output). Unit-tested with
 * zero mocks (dispatch "pure core" principle). The Svelte component is a thin
 * wrapper over this: it loads/saves via the injected adapter and routes every
 * field edit through `updateField`.
 *
 * The pathTemplate token set + default mirror the backend (Phase 5 handoff):
 * the backend SANITIZES path components, so the FE only offers a free-text
 * template + a live preview. `previewPath` reproduces the backend's token
 * substitution + empty-defaults for display ONLY — it does NOT replicate
 * sanitization (that is the backend's job; drifting here would be a lie).
 */
import type { AudioFormat, Settings } from "@yt-music/contract";

// ─── pathTemplate tokens (helper text) ───────────────────────────────────────

/** One pathTemplate token, surfaced as helper text in the Settings UI. Pure data. */
export interface PathTemplateToken {
	token: string;
	description: string;
}

/**
 * The tokens pathTemplate supports (backend-defined, case-sensitive, braces
 * required). Shown in the Settings UI so the user knows what they can use.
 */
export const PATH_TEMPLATE_TOKENS: readonly PathTemplateToken[] = [
	{ token: "{artist}", description: 'track artist (empty → "Unknown Artist")' },
	{ token: "{album}", description: 'album name (empty → "Unknown Album")' },
	{ token: "{track}", description: 'track number, zero-padded to 2 (absent → "00")' },
	{ token: "{title}", description: 'track title (empty → "Untitled")' },
	{ token: "{ext}", description: 'file extension without the dot ("flac" / "mp3")' },
];

/** The backend's default pathTemplate. */
export const DEFAULT_PATH_TEMPLATE = "{artist}/{album}/{track} - {title}.{ext}";

/** The format choices for the select. Pure data. */
export const FORMAT_OPTIONS: readonly AudioFormat[] = ["mp3", "flac"];

/** A blank settings form (used before load completes). Pure. */
export const EMPTY_SETTINGS: Settings = {
	outputDir: "",
	format: "mp3",
	pathTemplate: DEFAULT_PATH_TEMPLATE,
};

// ─── Reducers ────────────────────────────────────────────────────────────────

/** The editable settings fields (a subset of the Settings keys, all of them). */
export type SettingsField = "outputDir" | "format" | "pathTemplate";

/**
 * Return a new Settings with one field changed. Pure: (settings, field, value)
 * → settings. The value is a string (form inputs yield strings); for `format`
 * it is cast to `AudioFormat` (the caller pairs the field with a select whose
 * options are exactly the AudioFormat values). Mirrors the segment editor's
 * "every edit dispatches a reducer" shape.
 */
export function updateField(settings: Settings, field: SettingsField, value: string): Settings {
	switch (field) {
		case "outputDir":
			return { ...settings, outputDir: value };
		case "format":
			return { ...settings, format: value as AudioFormat };
		case "pathTemplate":
			return { ...settings, pathTemplate: value };
		default: {
			const _exhaustive: never = field;
			return _exhaustive;
		}
	}
}

// ─── View-model helpers (pure) ───────────────────────────────────────────────

/**
 * True when `current` differs from `original` in any field. Pure. Gates the
 * Save button so the user can't submit an unchanged form.
 */
export function isDirty(original: Settings, current: Settings): boolean {
	return (
		original.outputDir !== current.outputDir ||
		original.format !== current.format ||
		original.pathTemplate !== current.pathTemplate
	);
}

/**
 * A sample track used to preview a pathTemplate when no real track is at hand.
 * Pure data.
 */
export interface PathPreviewSample {
	artist: string;
	album: string;
	track?: number;
	title: string;
	/** Extension without the dot ("flac" / "mp3"). */
	ext: string;
}

/** A realistic default sample so the live preview is meaningful before load. */
export const DEFAULT_PREVIEW_SAMPLE: PathPreviewSample = {
	artist: "Daft Punk",
	album: "Discovery",
	track: 1,
	title: "One More Time",
	ext: "flac",
};

/**
 * Render a pathTemplate against a sample, applying the backend's token
 * substitution + empty-defaults. Pure: (template, sample) → string. NOTE: this
 * is a DISPLAY-ONLY preview — it does NOT replicate the backend's path
 * sanitization (illegal chars → _, dot/space trimming, traversal neutralization).
 * The real file lands wherever the backend puts it; this just shows the shape.
 */
export function previewPath(template: string, sample: PathPreviewSample): string {
	const artist = sample.artist.trim() || "Unknown Artist";
	const album = sample.album.trim() || "Unknown Album";
	const track =
		sample.track !== undefined && Number.isInteger(sample.track) && sample.track >= 1
			? String(sample.track).padStart(2, "0")
			: "00";
	const title = sample.title.trim() || "Untitled";
	const ext = sample.ext;
	return template
		.replaceAll("{artist}", artist)
		.replaceAll("{album}", album)
		.replaceAll("{track}", track)
		.replaceAll("{title}", title)
		.replaceAll("{ext}", ext);
}
