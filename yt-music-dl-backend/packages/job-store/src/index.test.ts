import type { JobEvent } from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, reconcile, reduce } from "./index.js";

describe("job-store reduce", () => {
	it("starts pending", () => {
		expect(INITIAL_STATE.status).toBe("pending");
		expect(INITIAL_STATE.files).toEqual([]);
	});

	it("progress event → downloading with progress", () => {
		const event: JobEvent = {
			type: "progress",
			pct: 42,
			speed: "1.5MiB/s",
			eta: "00:30",
			downloaded: 100,
			total: 200,
		};
		const state = reduce(INITIAL_STATE, event);
		expect(state.status).toBe("downloading");
		expect(state.progress?.pct).toBe(42);
	});

	it("done event → done with files", () => {
		const event: JobEvent = { type: "done", files: ["song.flac"] };
		const state = reduce(INITIAL_STATE, event);
		expect(state.status).toBe("done");
		expect(state.files).toEqual(["song.flac"]);
	});

	it("error event → failed with message", () => {
		const event: JobEvent = { type: "error", message: "boom" };
		const state = reduce(INITIAL_STATE, event);
		expect(state.status).toBe("failed");
		expect(state.error).toBe("boom");
	});

	it("reconcile replays a full event log", () => {
		const events: JobEvent[] = [
			{ type: "progress", pct: 10, speed: "1M", eta: "5s", downloaded: 1, total: 10 },
			{ type: "progress", pct: 90, speed: "1M", eta: "1s", downloaded: 9, total: 10 },
			{ type: "done", files: ["a.flac", "b.flac"] },
		];
		const state = reconcile(events);
		expect(state.status).toBe("done");
		expect(state.files).toEqual(["a.flac", "b.flac"]);
	});
});
