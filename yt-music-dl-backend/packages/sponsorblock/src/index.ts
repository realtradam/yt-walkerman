/**
 * @yt-music/sponsorblock — thin SponsorBlock API client.
 *
 * EFFECT at the edge: a fetch wrapper hitting the privacy-preserving hash-prefix
 * endpoint. The cut-plan logic that CONSUMES its output (computeKeepRanges,
 * computeDefaultDraft) is the pure core in @yt-music/cut-plan.
 *
 * For album splitting, SponsorBlock is OPTIONAL: if the API returns nothing or
 * fails (404 / network error), getSegments() returns [] and the cut plan simply
 * has no removedSegments — the chapters alone are enough to split.
 *
 * See .research/07-sponsorblock-and-ffmpeg.md.
 */

import { createHash } from "node:crypto";
import type { SponsorCategory, SponsorSegment } from "@yt-music/contract";

const API_BASE = "https://sponsor.ajay.app/api/skipSegments";

/** Categories a music app removes by default (see .research/07). */
export const DEFAULT_CATEGORIES: ReadonlyArray<SponsorCategory> = [
	"sponsor",
	"selfpromo",
	"interaction",
	"intro",
	"outro",
	"music_offtopic",
];

// ─── Pure core ───────────────────────────────────────────────────────────────

/**
 * The first 4 hex chars of sha256(videoId) — the SponsorBlock hash prefix used
 * for the privacy-preserving endpoint (the server then returns segments for
 * multiple videos sharing that prefix; we filter by videoId).
 *
 * Pure: (videoId) → 4-char hex prefix. Uses node:crypto's sha256 (a stateless
 * deterministic transform — no fs / network / subprocess).
 */
export function computeHashPrefix(videoId: string): string {
	return createHash("sha256").update(videoId, "utf8").digest("hex").slice(0, 4);
}

/**
 * The raw SponsorBlock hash-prefix response shape (subset we consume).
 * An array of per-video entries; each entry's segments use `[start, end]`.
 */
interface SbResponseEntry {
	videoID?: string;
	segments?: SbRawSegment[];
}

interface SbRawSegment {
	category?: string;
	segment?: [number, number];
	UUID?: string;
}

/**
 * Filter the raw hash-prefix response down to one video's segments and map them
 * to our SponsorSegment type. Pure: (body, videoId) → SponsorSegment[].
 *
 * - Selects the entry whose `videoID` matches.
 * - Keeps only segments with a known category + a 2-element `[start, end]`.
 * - Ignores unknown categories (e.g. `poi_highlight`, `chapter`) gracefully.
 */
export function parseSponsorBlockResponse(body: unknown, videoId: string): SponsorSegment[] {
	if (!Array.isArray(body)) return [];
	const entry = (body as SbResponseEntry[]).find((e) => e?.videoID === videoId);
	const segs = entry?.segments ?? [];
	const out: SponsorSegment[] = [];
	for (const seg of segs) {
		const category = seg.category as SponsorCategory | undefined;
		const range = seg.segment;
		if (!category || !isKnownCategory(category)) continue;
		if (!Array.isArray(range) || range.length < 2) continue;
		const start = Number(range[0]);
		const end = Number(range[1]);
		if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
		out.push({
			start,
			end,
			category,
			uuid: seg.UUID ?? `${videoId}:${start}-${end}`,
		});
	}
	return out;
}

const KNOWN_CATEGORIES: ReadonlySet<SponsorCategory> = new Set<SponsorCategory>([
	"sponsor",
	"selfpromo",
	"interaction",
	"intro",
	"outro",
	"preview",
	"music_offtopic",
	"filler",
]);

function isKnownCategory(c: string): c is SponsorCategory {
	return KNOWN_CATEGORIES.has(c as SponsorCategory);
}

// ─── Injected shell ─────────────────────────────────────────────────────────

/** A fetch function (the injected network effect). Defaults to global fetch. */
export type FetchFn = (
	url: string,
	init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

/** The SponsorBlock client — injected effect. */
export interface SponsorBlockClient {
	getSegments(videoId: string): Promise<SponsorSegment[]>;
}

export interface SponsorBlockOptions {
	fetch?: FetchFn;
	categories?: ReadonlyArray<SponsorCategory>;
	apiBase?: string;
}

/**
 * Create a SponsorBlock client. The fetch function is injectable so tests can
 * stub the OUTERMOST edge (network) without touching the pure parsing logic.
 *
 * On any failure (404, non-OK, network error, bad JSON) returns [] — SponsorBlock
 * is optional for album splitting.
 */
export function createSponsorBlockClient(opts: SponsorBlockOptions = {}): SponsorBlockClient {
	const fetchFn = opts.fetch ?? globalThis.fetch;
	const categories = opts.categories ?? DEFAULT_CATEGORIES;
	const apiBase = opts.apiBase ?? API_BASE;

	return {
		async getSegments(videoId: string): Promise<SponsorSegment[]> {
			try {
				const prefix = computeHashPrefix(videoId);
				const cats = encodeURIComponent(JSON.stringify(categories));
				const url = `${apiBase}/${prefix}?categories=${cats}`;
				const res = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
				// 404 is normal — many videos have no SponsorBlock submissions.
				if (!res.ok || res.status === 404) return [];
				const body = await res.json();
				return parseSponsorBlockResponse(body, videoId);
			} catch {
				return [];
			}
		},
	};
}
