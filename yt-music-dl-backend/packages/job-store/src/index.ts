/**
 * @yt-music/job-store — PURE core.
 *
 * The download state machine. `reconcile(events)` folds an append-only event log
 * into a `JobState` with NO side effects (no I/O, no network, no fs). This is the
 * dispatch "pure core" — fully unit-tested with zero mocks.
 *
 * Status is DERIVED from events, never trusted from a persisted field (dispatch
 * durability: a partial turn is repaired by re-running reconcile on load).
 */
import type { JobEvent, JobStatus } from "@yt-music/contract";

export interface JobState {
	status: JobStatus;
	progress?: { pct: number; speed: string; eta: string } | undefined;
	files: string[];
	error?: string | undefined;
}

/** The empty/initial state before any event arrives. */
export const INITIAL_STATE: JobState = {
	status: "pending",
	files: [],
};

/**
 * Fold one event into the state. Pure: (state, event) → state.
 */
export function reduce(state: JobState, event: JobEvent): JobState {
	switch (event.type) {
		case "info":
			// Metadata arrived — for a split job, the next phase is editing the
			// cut plan; for a single-track job, go straight to downloading.
			return { ...state, status: "editing" };
		case "draft":
			return { ...state, status: "editing" };
		case "progress":
			return {
				...state,
				status: "downloading",
				progress: { pct: event.pct, speed: event.speed, eta: event.eta },
			};
		case "cutting":
			return {
				...state,
				status: "cutting",
				progress: { pct: event.pct, speed: "", eta: "" },
			};
		case "done":
			return { ...state, status: "done", files: event.files, progress: undefined };
		case "error":
			return { ...state, status: "failed", error: event.message, progress: undefined };
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

/**
 * Fold the full append-only event log into the current state. Pure. Used both for
 * live updates (incremental) and recovery-on-load (full replay).
 */
export function reconcile(events: JobEvent[]): JobState {
	return events.reduce(reduce, INITIAL_STATE);
}
