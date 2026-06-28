import type { CutDraft, ReleaseDetail } from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import {
	buildRecordingSearchUrl,
	buildReleaseLookupUrl,
	buildReleaseSearchUrl,
	createMusicBrainzClient,
	type FetchFn,
	levenshtein,
	matchAlbumToDraft,
	normalizeTitle,
	parseRecordingSearch,
	parseReleaseDetail,
	parseReleaseSearch,
	titleSimilarity,
} from "./index.js";

// ─── Canned MusicBrainz JSON fixtures (NO network) ───────────────────────────
// Shapes match the real MusicBrainz web service responses (see
// .research/08-musicbrainz-integration.md + musicbrainz.org/doc/MusicBrainz_API).

const RECORDING_SEARCH_JSON = {
	created: "2026-01-01T00:00:00.000Z",
	count: 2,
	offset: 0,
	recordings: [
		{
			id: "b9ad642e-b012-41c7-b72a-42cf4911f9ff",
			score: 100,
			title: "LAST ANGEL",
			length: 230000,
			"artist-credit": [
				{ name: "倖田來未", joinphrase: " feat. ", artist: { id: "455641ea", name: "倖田來未" } },
				{ name: "東方神起", joinphrase: "", artist: { id: "05cbaf37", name: "東方神起" } },
			],
			releases: [
				{ id: "c33dee6a", title: "LAST ANGEL" },
				{ id: "601a4558", title: "Kingdom" },
			],
		},
		{
			id: "a1b2c3d4-0000-0000-0000-000000000001",
			score: 87,
			title: "Time",
			length: 412000,
			"artist-credit": [
				{ name: "Pink Floyd", joinphrase: "", artist: { id: "83d91898", name: "Pink Floyd" } },
			],
			releases: [{ id: "r1", title: "The Dark Side of the Moon" }],
		},
	],
};

const RELEASE_SEARCH_JSON = {
	created: "2026-01-01T00:00:00.000Z",
	count: 2,
	offset: 0,
	releases: [
		{
			id: "59211ea4-ffd2-4ad9-9a4e-941d3148024a",
			score: 100,
			title: "æ³o & h³æ",
			date: "2003-12-04",
			"artist-credit": [
				{ name: "Autechre", joinphrase: " & ", artist: { id: "410c9baf", name: "Autechre" } },
				{
					name: "The Hafler Trio",
					joinphrase: "",
					artist: { id: "146c01d0", name: "The Hafler Trio" },
				},
			],
		},
		{
			id: "a1b2c3d4-0000-0000-0000-000000000002",
			score: 91,
			title: "The Dark Side of the Moon",
			date: "1973-03-01",
			"artist-credit": [
				{ name: "Pink Floyd", joinphrase: "", artist: { id: "83d91898", name: "Pink Floyd" } },
			],
		},
	],
};

// Single-disc release with 4 tracks.
const RELEASE_DETAIL_JSON = {
	id: "a1b2c3d4-0000-0000-0000-000000000002",
	title: "The Dark Side of the Moon",
	date: "1973-03-01",
	"artist-credit": [
		{ name: "Pink Floyd", joinphrase: "", artist: { id: "83d91898", name: "Pink Floyd" } },
	],
	media: [
		{
			position: 1,
			format: "Digital Media",
			"track-count": 4,
			tracks: [
				{
					id: "t1",
					title: "Speak to Me",
					position: 1,
					number: "1",
					length: 90000,
					recording: { id: "rec1", title: "Speak to Me", length: 90000 },
				},
				{
					id: "t2",
					title: "Breathe",
					position: 2,
					number: "2",
					length: 163000,
					recording: { id: "rec2", title: "Breathe", length: 163000 },
				},
				{
					id: "t3",
					title: "Time",
					position: 3,
					number: "3",
					length: 412000,
					recording: { id: "rec3", title: "Time", length: 412000 },
				},
				{
					id: "t4",
					title: "The Great Gig in the Sky",
					position: 4,
					number: "4",
					length: 276000,
					recording: { id: "rec4", title: "The Great Gig in the Sky", length: 276000 },
				},
			],
		},
	],
};

// Multi-disc release (2 media, 1 track each) to verify global position.
const MULTI_DISC_DETAIL_JSON = {
	id: "59211ea4-ffd2-4ad9-9a4e-941d3148024a",
	title: "æ³o & h³æ",
	date: "2003-12-04",
	"artist-credit": [
		{ name: "Autechre", joinphrase: " & ", artist: { id: "410c9baf", name: "Autechre" } },
		{
			name: "The Hafler Trio",
			joinphrase: "",
			artist: { id: "146c01d0", name: "The Hafler Trio" },
		},
	],
	media: [
		{
			position: 1,
			title: "æ³o",
			format: "CD",
			"track-count": 1,
			tracks: [
				{
					id: "t1",
					title: "æ³o",
					position: 1,
					number: "1",
					length: 974546,
					recording: { id: "af87f070", title: "æ³o", length: 974546 },
				},
			],
		},
		{
			position: 2,
			title: "h³æ",
			format: "CD",
			"track-count": 1,
			tracks: [
				{
					id: "t2",
					title: "h³æ",
					position: 1,
					number: "1",
					length: 922546,
					recording: { id: "5aff6309", title: "h³æ", length: 922546 },
				},
			],
		},
	],
};

// ─── buildRecordingSearchUrl (pure) ──────────────────────────────────────────

describe("buildRecordingSearchUrl (pure)", () => {
	it("builds a recording search URL with just a query (no artist)", () => {
		const url = buildRecordingSearchUrl("Time");
		expect(url).toBe("https://musicbrainz.org/ws/2/recording?query=Time&limit=25&fmt=json");
	});

	it("folds the artist hint into a Lucene query", () => {
		const url = buildRecordingSearchUrl("Time", "Pink Floyd");
		const expectedQuery = encodeURIComponent('artist:"Pink Floyd" AND recording:"Time"');
		expect(url).toBe(
			`https://musicbrainz.org/ws/2/recording?query=${expectedQuery}&limit=25&fmt=json`,
		);
	});

	it("respects a custom limit", () => {
		const url = buildRecordingSearchUrl("Time", undefined, 10);
		expect(url).toContain("&limit=10&");
	});

	it("URL-encodes special characters in the query", () => {
		const url = buildRecordingSearchUrl("Time & Space", undefined, 5);
		// spaces → %20, & → %26
		expect(url).toContain("query=Time%20%26%20Space");
		expect(url).toContain("&limit=5&");
	});

	it("uses a custom baseUrl when provided", () => {
		const url = buildRecordingSearchUrl("Time", undefined, 5, "http://localhost:9999/ws/2");
		expect(url).toBe("http://localhost:9999/ws/2/recording?query=Time&limit=5&fmt=json");
	});
});

// ─── buildReleaseSearchUrl (pure) ────────────────────────────────────────────

describe("buildReleaseSearchUrl (pure)", () => {
	it("builds a release search URL with just a query", () => {
		const url = buildReleaseSearchUrl("Dark Side of the Moon");
		expect(url).toBe(
			"https://musicbrainz.org/ws/2/release?query=Dark%20Side%20of%20the%20Moon&limit=25&fmt=json",
		);
	});

	it("folds the artist hint into a Lucene query using the release entity", () => {
		const url = buildReleaseSearchUrl("Dark Side of the Moon", "Pink Floyd");
		const expectedQuery = encodeURIComponent(
			'artist:"Pink Floyd" AND release:"Dark Side of the Moon"',
		);
		expect(url).toBe(
			`https://musicbrainz.org/ws/2/release?query=${expectedQuery}&limit=25&fmt=json`,
		);
	});
});

// ─── buildReleaseLookupUrl (pure) ────────────────────────────────────────────

describe("buildReleaseLookupUrl (pure)", () => {
	it("builds a release lookup URL with the recordings + artist-credits inc", () => {
		const mbid = "a1b2c3d4-0000-0000-0000-000000000002";
		const url = buildReleaseLookupUrl(mbid);
		expect(url).toBe(
			`https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings+artist-credits+release-groups&fmt=json`,
		);
	});

	it("uses a custom baseUrl when provided", () => {
		const url = buildReleaseLookupUrl("some-mbid", "http://localhost:9999/ws/2");
		expect(url).toBe(
			"http://localhost:9999/ws/2/release/some-mbid?inc=recordings+artist-credits+release-groups&fmt=json",
		);
	});
});

// ─── parseRecordingSearch (pure) ─────────────────────────────────────────────

describe("parseRecordingSearch (pure)", () => {
	it("parses recordings into MetadataResult[] with id/title/artist/album/score", () => {
		const results = parseRecordingSearch(RECORDING_SEARCH_JSON);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			id: "b9ad642e-b012-41c7-b72a-42cf4911f9ff",
			type: "recording",
			title: "LAST ANGEL",
			artist: "倖田來未 feat. 東方神起",
			album: "LAST ANGEL",
			score: 100,
		});
	});

	it("takes the first release title as the album", () => {
		const results = parseRecordingSearch(RECORDING_SEARCH_JSON);
		expect(results[1]?.album).toBe("The Dark Side of the Moon");
	});

	it("maps type to 'recording'", () => {
		const results = parseRecordingSearch(RECORDING_SEARCH_JSON);
		expect(results.every((r) => r.type === "recording")).toBe(true);
	});

	it("defaults score to 0 when MB omits it", () => {
		const json = { recordings: [{ id: "x", title: "T", "artist-credit": [] }] };
		const results = parseRecordingSearch(json);
		expect(results[0]?.score).toBe(0);
	});

	it("omits album when the recording has no releases", () => {
		const json = { recordings: [{ id: "x", title: "T", "artist-credit": [] }] };
		const results = parseRecordingSearch(json);
		expect(results[0]?.album).toBeUndefined();
	});

	it("skips recordings missing id or title", () => {
		const json = { recordings: [{ id: "x" }, { title: "T" }, { id: "y", title: "T" }] };
		const results = parseRecordingSearch(json);
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe("y");
	});

	it("returns [] for non-object / missing recordings", () => {
		expect(parseRecordingSearch(null)).toEqual([]);
		expect(parseRecordingSearch({})).toEqual([]);
		expect(parseRecordingSearch("nope")).toEqual([]);
		expect(parseRecordingSearch({ recordings: "not-an-array" })).toEqual([]);
	});
});

// ─── parseReleaseSearch (pure) ───────────────────────────────────────────────

describe("parseReleaseSearch (pure)", () => {
	it("parses releases into MetadataResult[] with id/title/artist/score", () => {
		const results = parseReleaseSearch(RELEASE_SEARCH_JSON);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			id: "59211ea4-ffd2-4ad9-9a4e-941d3148024a",
			type: "release",
			title: "æ³o & h³æ",
			artist: "Autechre & The Hafler Trio",
			score: 100,
		});
		expect(results[1]).toEqual({
			id: "a1b2c3d4-0000-0000-0000-000000000002",
			type: "release",
			title: "The Dark Side of the Moon",
			artist: "Pink Floyd",
			score: 91,
		});
	});

	it("does not set album or trackNumber for releases", () => {
		const results = parseReleaseSearch(RELEASE_SEARCH_JSON);
		for (const r of results) {
			expect(r.album).toBeUndefined();
			expect(r.trackNumber).toBeUndefined();
		}
	});

	it("skips releases missing id or title", () => {
		const json = { releases: [{ id: "x" }, { title: "T" }, { id: "y", title: "T" }] };
		const results = parseReleaseSearch(json);
		expect(results).toHaveLength(1);
	});

	it("returns [] for non-object / missing releases", () => {
		expect(parseReleaseSearch(null)).toEqual([]);
		expect(parseReleaseSearch({})).toEqual([]);
	});
});

// ─── parseReleaseDetail (pure) ───────────────────────────────────────────────

describe("parseReleaseDetail (pure)", () => {
	it("parses a single-disc release into a flat track list", () => {
		const detail = parseReleaseDetail(RELEASE_DETAIL_JSON);
		expect(detail.id).toBe("a1b2c3d4-0000-0000-0000-000000000002");
		expect(detail.title).toBe("The Dark Side of the Moon");
		expect(detail.artist).toBe("Pink Floyd");
		expect(detail.date).toBe("1973-03-01");
		expect(detail.tracks).toHaveLength(4);
		expect(detail.tracks[0]).toEqual({
			position: 1,
			title: "Speak to Me",
			length: 90000,
			recordingId: "rec1",
		});
		expect(detail.tracks[2]).toEqual({
			position: 3,
			title: "Time",
			length: 412000,
			recordingId: "rec3",
		});
	});

	it("assigns a GLOBAL running position across multi-disc releases", () => {
		const detail = parseReleaseDetail(MULTI_DISC_DETAIL_JSON);
		expect(detail.tracks).toHaveLength(2);
		// Both discs report position 1 internally, but global must be 1 then 2.
		expect(detail.tracks[0]?.position).toBe(1);
		expect(detail.tracks[1]?.position).toBe(2);
		expect(detail.tracks[1]?.recordingId).toBe("5aff6309");
	});

	it("falls back to the track id when recording.id is missing", () => {
		const json = {
			id: "r",
			title: "T",
			"artist-credit": [],
			media: [{ tracks: [{ id: "track-id", title: "Song", position: 1 }] }],
		};
		const detail = parseReleaseDetail(json);
		expect(detail.tracks[0]?.recordingId).toBe("track-id");
	});

	it("omits length when not provided", () => {
		const json = {
			id: "r",
			title: "T",
			media: [{ tracks: [{ id: "t1", title: "Song", position: 1, recording: { id: "r1" } }] }],
		};
		const detail = parseReleaseDetail(json);
		expect(detail.tracks[0]?.length).toBeUndefined();
	});

	it("omits date when not provided", () => {
		const json = { id: "r", title: "T", media: [] };
		const detail = parseReleaseDetail(json);
		expect(detail.date).toBeUndefined();
	});

	it("returns a well-formed empty release for bad input", () => {
		const detail = parseReleaseDetail(null);
		expect(detail).toEqual({ id: "", title: "", artist: "", tracks: [] });
		expect(parseReleaseDetail({}).tracks).toEqual([]);
	});
});

// ─── normalizeTitle / levenshtein / titleSimilarity (pure) ───────────────────

describe("normalizeTitle (pure)", () => {
	it("lowercases and strips parentheticals + punctuation", () => {
		expect(normalizeTitle("Time (Official Audio)")).toBe("time");
		expect(normalizeTitle("Speak to Me [HD]")).toBe("speak to me");
		expect(normalizeTitle("Breathe!")).toBe("breathe");
	});

	it("collapses whitespace", () => {
		expect(normalizeTitle("The   Great   Gig")).toBe("the great gig");
	});

	it("returns '' for punctuation-only input", () => {
		expect(normalizeTitle("()[]")).toBe("");
	});
});

describe("levenshtein (pure)", () => {
	it("computes edit distance", () => {
		expect(levenshtein("", "")).toBe(0);
		expect(levenshtein("abc", "abc")).toBe(0);
		expect(levenshtein("abc", "abd")).toBe(1);
		expect(levenshtein("kitten", "sitting")).toBe(3);
		expect(levenshtein("", "abc")).toBe(3);
		expect(levenshtein("abc", "")).toBe(3);
	});
});

describe("titleSimilarity (pure)", () => {
	it("is 1 for identical normalized titles", () => {
		expect(titleSimilarity("Time", "time")).toBe(1);
		expect(titleSimilarity("Time (Live)", "time")).toBe(1);
	});

	it("is 0 when either side is empty after normalization", () => {
		expect(titleSimilarity("", "time")).toBe(0);
		expect(titleSimilarity("()[]", "time")).toBe(0);
	});

	it("is between 0 and 1 for partial matches", () => {
		const s = titleSimilarity("Time", "Tome");
		expect(s).toBeGreaterThan(0);
		expect(s).toBeLessThan(1);
	});
});

// ─── matchAlbumToDraft (pure) ─────────────────────────────────────────────────

/** Build a minimal CutDraft with N segments titled t1..tN. */
function makeDraft(titles: string[]): CutDraft {
	return {
		sourceVideoId: "vid",
		sourceDuration: 1000,
		globalAlbum: "Album",
		globalAlbumArt: { kind: "video-thumbnail" },
		globalArtist: "Artist",
		segments: titles.map((title, i) => ({
			id: `seg-${i}`,
			title,
			artist: "Artist",
			album: "Album",
			trackNumber: i + 1,
			albumArt: { kind: "video-thumbnail" } as const,
			start: 0,
			end: 100,
			removedSegments: [],
		})),
	};
}

describe("matchAlbumToDraft (pure)", () => {
	const release: ReleaseDetail = parseReleaseDetail(RELEASE_DETAIL_JSON);

	it("matches 1:1 by position when segment count === track count", () => {
		const draft = makeDraft(["Speak to Me", "Breathe", "Time", "Great Gig"]);
		const result = matchAlbumToDraft(draft, release);
		expect(result.matches).toHaveLength(4);
		for (const m of result.matches) {
			expect(m.confidence).toBe("position");
		}
		expect(result.matches[0]?.track.title).toBe("Speak to Me");
		expect(result.matches[2]?.track.title).toBe("Time");
		// Segment index preserved.
		expect(result.matches.map((m) => m.segmentIndex)).toEqual([0, 1, 2, 3]);
	});

	it("matches by title similarity when counts differ", () => {
		// 2 segments vs 4 tracks → title matching.
		const draft = makeDraft(["Time", "Breathe"]);
		const result = matchAlbumToDraft(draft, release);
		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]?.track.title).toBe("Time");
		expect(result.matches[0]?.confidence).toBe("title");
		expect(result.matches[1]?.track.title).toBe("Breathe");
		expect(result.matches[1]?.confidence).toBe("title");
		// No duplicate track assignments.
		const trackTitles = result.matches.map((m) => m.track.title);
		expect(new Set(trackTitles).size).toBe(trackTitles.length);
	});

	it("marks confidence 'none' for segments with no good title match", () => {
		// "zzzzzz" normalizes to "zzzzzz" — no overlap with any track.
		const draft = makeDraft(["Time", "zzzzzz no overlap at all"]);
		const result = matchAlbumToDraft(draft, release);
		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]?.confidence).toBe("title");
		expect(result.matches[1]?.confidence).toBe("none");
	});

	it("returns [] for empty segments", () => {
		const draft = makeDraft([]);
		expect(matchAlbumToDraft(draft, release)).toEqual({ matches: [] });
	});

	it("returns [] when the release has no tracks", () => {
		const draft = makeDraft(["Time"]);
		const emptyRelease: ReleaseDetail = { id: "r", title: "T", artist: "A", tracks: [] };
		expect(matchAlbumToDraft(draft, emptyRelease)).toEqual({ matches: [] });
	});

	it("handles duplicate titles without assigning the same track twice", () => {
		// Two segments named "Time" → both should match "Time" track, but a track
		// can only be assigned once. The second gets the next-best or 'none'.
		const draft = makeDraft(["Time", "Time"]);
		const result = matchAlbumToDraft(draft, release);
		expect(result.matches).toHaveLength(2);
		const trackIds = result.matches.map((m) => m.track.recordingId);
		// No duplicate track assignment among 'title'-confidence matches.
		const titleMatches = result.matches.filter((m) => m.confidence === "title");
		const titleTrackIds = titleMatches.map((m) => m.track.recordingId);
		expect(new Set(titleTrackIds).size).toBe(titleTrackIds.length);
		// At least one matched the actual Time track.
		expect(trackIds).toContain("rec3");
	});
});

// ─── createMusicBrainzClient (shell) ─────────────────────────────────────────

/** A controllable fake fetch for the outermost network edge. */
function makeFakeFetch(responses: Array<{ status: number; body: unknown }>): {
	fetch: FetchFn;
	calls: Array<{ url: string; headers?: Record<string, string> }>;
} {
	const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
	let i = 0;
	const fetch: FetchFn = async (url, init) => {
		calls.push({ url, headers: init?.headers });
		const r = responses[i] ?? { status: 404, body: {} };
		i++;
		return {
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			json: async () => r.body,
		};
	};
	return { fetch, calls };
}

describe("createMusicBrainzClient (shell)", () => {
	it("searchRecordings fetches the recording search URL and parses results", async () => {
		const { fetch, calls } = makeFakeFetch([{ status: 200, body: RECORDING_SEARCH_JSON }]);
		const client = createMusicBrainzClient({ fetch, minInterval: 0 });
		const results = await client.searchRecordings("Time", "Pink Floyd");
		expect(results).toHaveLength(2);
		expect(results[0]?.title).toBe("LAST ANGEL");
		// URL includes the artist hint folded into a Lucene query.
		expect(calls[0]?.url).toContain("recording");
		expect(calls[0]?.url).toContain(encodeURIComponent('artist:"Pink Floyd"'));
		// User-Agent header is set.
		expect(calls[0]?.headers?.["User-Agent"]).toContain("yt-music-dl");
	});

	it("searchReleases fetches the release search URL and parses results", async () => {
		const { fetch, calls } = makeFakeFetch([{ status: 200, body: RELEASE_SEARCH_JSON }]);
		const client = createMusicBrainzClient({ fetch, minInterval: 0 });
		const results = await client.searchReleases("Dark Side", "Pink Floyd");
		expect(results).toHaveLength(2);
		expect(results[0]?.title).toBe("æ³o & h³æ");
		expect(calls[0]?.url).toContain("/release?");
	});

	it("getRelease fetches the lookup URL and parses the detail", async () => {
		const mbid = "a1b2c3d4-0000-0000-0000-000000000002";
		const { fetch, calls } = makeFakeFetch([{ status: 200, body: RELEASE_DETAIL_JSON }]);
		const client = createMusicBrainzClient({ fetch, minInterval: 0 });
		const detail = await client.getRelease(mbid);
		expect(detail.title).toBe("The Dark Side of the Moon");
		expect(detail.tracks).toHaveLength(4);
		expect(calls[0]?.url).toContain(`/release/${mbid}?`);
		expect(calls[0]?.url).toContain("inc=recordings+artist-credits+release-groups");
	});

	it("rejects on a non-OK response", async () => {
		const { fetch } = makeFakeFetch([{ status: 500, body: {} }]);
		const client = createMusicBrainzClient({ fetch, minInterval: 0 });
		await expect(client.searchRecordings("Time")).rejects.toThrow("MusicBrainz request failed");
	});

	it("uses a custom baseUrl when provided", async () => {
		const { fetch, calls } = makeFakeFetch([{ status: 200, body: RECORDING_SEARCH_JSON }]);
		const client = createMusicBrainzClient({
			fetch,
			minInterval: 0,
			baseUrl: "http://localhost:9999/ws/2",
		});
		await client.searchRecordings("Time");
		expect(calls[0]?.url?.startsWith("http://localhost:9999/ws/2/recording?")).toBe(true);
	});

	it("rate-limits: spaces consecutive requests >= minInterval", async () => {
		const { fetch } = makeFakeFetch([
			{ status: 200, body: RECORDING_SEARCH_JSON },
			{ status: 200, body: RECORDING_SEARCH_JSON },
		]);
		const interval = 50; // ms — small but measurable
		const client = createMusicBrainzClient({ fetch, minInterval: interval });
		const t0 = Date.now();
		await client.searchRecordings("a");
		await client.searchRecordings("b");
		const elapsed = Date.now() - t0;
		// Two requests: the second must wait ~interval ms after the first.
		expect(elapsed).toBeGreaterThanOrEqual(interval - 5); // allow tiny timer slack
	});
});
