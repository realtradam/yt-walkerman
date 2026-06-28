import { describe, expect, it } from "vitest";
import {
	computeHashPrefix,
	createSponsorBlockClient,
	DEFAULT_CATEGORIES,
	type FetchFn,
	parseSponsorBlockResponse,
} from "./index.js";

// ─── computeHashPrefix (pure) ────────────────────────────────────────────────

describe("computeHashPrefix (pure)", () => {
	it("returns the first 4 hex chars of sha256(videoId)", () => {
		// Verified against `echo -n 7yzGBaiAMfw | sha256sum` → 8ce8...
		expect(computeHashPrefix("7yzGBaiAMfw")).toBe("8ce8");
	});

	it("is deterministic", () => {
		expect(computeHashPrefix("dQw4w9WgXcQ")).toBe(computeHashPrefix("dQw4w9WgXcQ"));
	});

	it("always returns 4 characters", () => {
		expect(computeHashPrefix("abc").length).toBe(4);
		expect(computeHashPrefix("").length).toBe(4);
	});
});

// ─── parseSponsorBlockResponse (pure) ───────────────────────────────────────

describe("parseSponsorBlockResponse (pure)", () => {
	const realishResponse = [
		{
			videoID: "YYz9WBuFM6k",
			segments: [{ category: "intro", segment: [0, 20.476], UUID: "uuid-intro-1" }],
		},
		{
			videoID: "7yzGBaiAMfw",
			segments: [
				{ category: "sponsor", segment: [10, 20], UUID: "uuid-sponsor" },
				{ category: "music_offtopic", segment: [200, 210], UUID: "uuid-music" },
				{ category: "poi_highlight", segment: [5], UUID: "uuid-poi" }, // not a range
				{ category: "chapter", segment: [0, 30], UUID: "uuid-chap" }, // ignored category
			],
		},
	];

	it("selects only the matching videoId's segments", () => {
		const segs = parseSponsorBlockResponse(realishResponse, "7yzGBaiAMfw");
		expect(segs).toHaveLength(2);
		expect(segs.map((s) => s.category).sort()).toEqual(["music_offtopic", "sponsor"]);
	});

	it("maps segment + category + uuid into SponsorSegment", () => {
		const segs = parseSponsorBlockResponse(realishResponse, "7yzGBaiAMfw");
		expect(segs[0]).toEqual({
			start: 10,
			end: 20,
			category: "sponsor",
			uuid: "uuid-sponsor",
		});
	});

	it("ignores non-range segments (poi_highlight) and unknown categories (chapter)", () => {
		const segs = parseSponsorBlockResponse(realishResponse, "7yzGBaiAMfw");
		expect(segs.find((s) => s.category === "poi_highlight")).toBeUndefined();
		expect(segs.find((s) => s.category === "chapter")).toBeUndefined();
	});

	it("returns [] when the videoId is not present", () => {
		expect(parseSponsorBlockResponse(realishResponse, "notARealVideo")).toEqual([]);
	});

	it("returns [] when the body is not an array", () => {
		expect(parseSponsorBlockResponse({ foo: "bar" }, "7yzGBaiAMfw")).toEqual([]);
		expect(parseSponsorBlockResponse(null, "7yzGBaiAMfw")).toEqual([]);
		expect(parseSponsorBlockResponse("nope", "7yzGBaiAMfw")).toEqual([]);
	});

	it("synthesizes a uuid when the API omits one", () => {
		const body = [{ videoID: "v1", segments: [{ category: "sponsor", segment: [1, 2] }] }];
		const segs = parseSponsorBlockResponse(body, "v1");
		expect(segs[0]?.uuid).toBe("v1:1-2");
	});

	it("returns [] when the matching entry has no segments", () => {
		const body = [{ videoID: "v1", segments: [] }];
		expect(parseSponsorBlockResponse(body, "v1")).toEqual([]);
	});
});

// ─── createSponsorBlockClient (shell) ────────────────────────────────────────

/** A controllable fake fetch for the outermost network edge. */
function makeFakeFetch(responses: Array<{ status: number; body: unknown }>): {
	fetch: FetchFn;
	calls: string[];
} {
	const calls: string[] = [];
	let i = 0;
	const fetch: FetchFn = async (url) => {
		calls.push(url);
		const r = responses[i] ?? { status: 404, body: [] };
		i++;
		return {
			ok: r.status >= 200 && r.status < 300,
			status: r.status,
			json: async () => r.body,
		};
	};
	return { fetch, calls };
}

describe("createSponsorBlockClient (shell)", () => {
	it("fetches the hash-prefix endpoint and parses the matching segments", async () => {
		const body = [
			{
				videoID: "7yzGBaiAMfw",
				segments: [{ category: "sponsor", segment: [5, 10], UUID: "u1" }],
			},
		];
		const { fetch, calls } = makeFakeFetch([{ status: 200, body }]);
		const client = createSponsorBlockClient({ fetch });
		const segs = await client.getSegments("7yzGBaiAMfw");
		expect(segs).toHaveLength(1);
		expect(segs[0]).toEqual({ start: 5, end: 10, category: "sponsor", uuid: "u1" });
		// Uses the sha256 prefix (8ce8) + the default categories.
		expect(calls[0]).toContain("/8ce8?");
		expect(calls[0]).toContain(encodeURIComponent(JSON.stringify(DEFAULT_CATEGORIES.slice())));
	});

	it("returns [] on 404 (no segments — normal)", async () => {
		const { fetch } = makeFakeFetch([{ status: 404, body: [] }]);
		const client = createSponsorBlockClient({ fetch });
		expect(await client.getSegments("7yzGBaiAMfw")).toEqual([]);
	});

	it("returns [] on a non-OK response", async () => {
		const { fetch } = makeFakeFetch([{ status: 500, body: [] }]);
		const client = createSponsorBlockClient({ fetch });
		expect(await client.getSegments("7yzGBaiAMfw")).toEqual([]);
	});

	it("returns [] when fetch throws (network error)", async () => {
		const fetch: FetchFn = async () => {
			throw new Error("network down");
		};
		const client = createSponsorBlockClient({ fetch });
		expect(await client.getSegments("7yzGBaiAMfw")).toEqual([]);
	});

	it("returns [] when the body is not valid JSON (json throws)", async () => {
		const fetch: FetchFn = async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error("bad json");
			},
		});
		const client = createSponsorBlockClient({ fetch });
		expect(await client.getSegments("7yzGBaiAMfw")).toEqual([]);
	});
});
