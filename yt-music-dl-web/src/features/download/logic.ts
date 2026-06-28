/**
 * src/features/download/logic.ts — PURE: fold JobEvents into view-state.
 *
 * No DOM, no fetch, no WebSocket — pure (state, event) → state. Unit-tested
 * with zero mocks (dispatch "pure core" principle). The Svelte component is a
 * thin wrapper over this.
 */
import type { CutDraft, JobEvent, JobStatus } from "@yt-music/contract";

export interface DownloadState {
	status: JobStatus;
	title: string;
	pct: number;
	speed: string;
	eta: string;
	files: string[];
	error: string | undefined;
	/**
	 * The editable CutDraft for split-by-chapters jobs (null in single mode).
	 * Captured from the `draft` job event; surfaced to the segment editor.
	 */
	draft: CutDraft | null;
}

export const INITIAL: DownloadState = {
	status: "pending",
	title: "",
	pct: 0,
	speed: "",
	eta: "",
	files: [],
	error: undefined,
	draft: null,
};

/** Fold one event into the view-state. Pure: (state, event) → state. */
export function reduce(state: DownloadState, event: JobEvent): DownloadState {
	switch (event.type) {
		case "info":
			return { ...state, status: "downloading", title: event.info.title };
		case "draft":
			return { ...state, status: "editing", draft: event.draft };
		case "progress":
			return {
				...state,
				status: "downloading",
				pct: event.pct,
				speed: event.speed,
				eta: event.eta,
			};
		case "cutting":
			return { ...state, status: "cutting", pct: event.pct };
		case "done":
			return { ...state, status: "done", files: event.files, pct: 100 };
		case "error":
			return { ...state, status: "failed", error: event.message };
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

/** Fold a full event log. Pure. */
export function reconcile(events: JobEvent[]): DownloadState {
	return events.reduce(reduce, INITIAL);
}

/** Human-readable status label. Pure. */
export function statusLabel(status: JobStatus): string {
	const labels: Record<JobStatus, string> = {
		pending: "Queued",
		"fetching-info": "Fetching info…",
		editing: "Ready to edit",
		downloading: "Downloading…",
		cutting: "Cutting…",
		tagging: "Tagging…",
		done: "Done ✓",
		failed: "Failed ✗",
		cancelled: "Cancelled",
	};
	return labels[status] ?? status;
}
