import type { JobEvent } from "@yt-music/contract";
import { describe, expect, it } from "vitest";
import { INITIAL, reconcile, reduce, statusLabel } from "./logic.js";

describe("download logic (pure)", () => {
	it("starts pending with empty state", () => {
		expect(INITIAL.status).toBe("pending");
		expect(INITIAL.pct).toBe(0);
		expect(INITIAL.draft).toBeNull();
	});

	it("info event → downloading + title", () => {
		const state = reduce(INITIAL, {
			type: "info",
			info: {
				id: "x",
				title: "Song",
				uploader: "Artist",
				duration: 10,
				thumbnail: "",
				webpageUrl: "",
			},
		});
		expect(state.status).toBe("downloading");
		expect(state.title).toBe("Song");
	});

	it("draft event → editing + captures the CutDraft", () => {
		const draft = {
			sourceVideoId: "x",
			sourceDuration: 100,
			segments: [],
			globalAlbum: "A",
			globalArtist: "Ar",
			globalAlbumArt: { kind: "video-thumbnail" as const },
		};
		const state = reduce(INITIAL, { type: "draft", draft });
		expect(state.status).toBe("editing");
		expect(state.draft).toEqual(draft);
	});

	it("progress event → updates pct/speed", () => {
		const state = reduce(INITIAL, {
			type: "progress",
			pct: 42,
			speed: "1M",
			eta: "10s",
			downloaded: 50,
			total: 100,
		});
		expect(state.pct).toBe(42);
		expect(state.speed).toBe("1M");
	});

	it("done event → 100% with files", () => {
		const state = reduce(INITIAL, { type: "done", files: ["song.mp3"] });
		expect(state.status).toBe("done");
		expect(state.pct).toBe(100);
		expect(state.files).toEqual(["song.mp3"]);
	});

	it("error event → failed", () => {
		const state = reduce(INITIAL, { type: "error", message: "boom" });
		expect(state.status).toBe("failed");
		expect(state.error).toBe("boom");
	});

	it("reconcile folds a full log", () => {
		const events: JobEvent[] = [
			{
				type: "info",
				info: { id: "x", title: "T", uploader: "A", duration: 1, thumbnail: "", webpageUrl: "" },
			},
			{ type: "progress", pct: 50, speed: "1M", eta: "5s", downloaded: 1, total: 2 },
			{ type: "done", files: ["out.mp3"] },
		];
		const state = reconcile(events);
		expect(state.status).toBe("done");
		expect(state.title).toBe("T");
		expect(state.pct).toBe(100);
	});

	it("statusLabel maps all statuses", () => {
		expect(statusLabel("downloading")).toBe("Downloading…");
		expect(statusLabel("done")).toBe("Done ✓");
		expect(statusLabel("failed")).toBe("Failed ✗");
	});
});
