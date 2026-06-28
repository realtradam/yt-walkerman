/**
 * @yt-music/contract — pure types shared by the backend and the web frontend.
 *
 * Types ONLY: zero runtime, zero `@yt-music/*` dependencies, so the frontend
 * can depend on the contract without pulling the backend runtime. The frontend
 * imports this as a `file:` dep (mirrors dispatch's `@dispatch/wire`).
 *
 * See .research/ for the full design rationale.
 */

// ─── Identifiers ─────────────────────────────────────────────────────────────

export type JobId = string;

// ─── Video metadata ──────────────────────────────────────────────────────────

export interface VideoInfo {
	id: string;
	title: string;
	uploader: string;
	channel?: string;
	duration: number;
	thumbnail: string;
	webpageUrl: string;
	/** Present when the video has chapter markers (album/compilation videos). */
	chapters?: Chapter[];
}

export interface Chapter {
	title: string;
	startTime: number;
	endTime: number;
}

// ─── SponsorBlock ────────────────────────────────────────────────────────────

export type SponsorCategory =
	| "sponsor"
	| "selfpromo"
	| "interaction"
	| "intro"
	| "outro"
	| "preview"
	| "music_offtopic"
	| "filler";

export interface SponsorSegment {
	start: number;
	end: number;
	category: SponsorCategory;
	uuid: string;
}

// ─── Cut plan (album splitting + sponsor removal) ────────────────────────────

export type AlbumArtRef =
	| { kind: "video-thumbnail" }
	| { kind: "url"; url: string }
	| { kind: "uploaded"; uploadId: string };

export interface RemovedSegmentDraft {
	uuid: string;
	start: number;
	end: number;
	category: SponsorCategory | "manual";
	enabled: boolean;
	label: string;
}

/** A single editable song in the cut-plan editor. */
export interface SegmentDraft {
	id: string;
	title: string;
	artist: string;
	album: string;
	trackNumber: number;
	albumArt: AlbumArtRef;
	start: number;
	end: number;
	removedSegments: RemovedSegmentDraft[];
}

/** The full editable document the frontend manipulates. */
export interface CutDraft {
	sourceVideoId: string;
	sourceDuration: number;
	segments: SegmentDraft[];
	globalAlbum: string;
	globalAlbumArt: AlbumArtRef;
	globalArtist: string;
}

/** A finalized, validated keep-range within one song. */
export interface KeepRange {
	start: number;
	end: number;
}

/** A finalized song to extract from the source. */
export interface CutSegment {
	title: string;
	artist: string;
	album: string;
	trackNumber: number;
	albumArt: AlbumArtRef;
	keepRanges: KeepRange[];
}

export interface CutPlan {
	segments: CutSegment[];
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export type JobMode = "single" | "split-by-chapters";
export type AudioFormat = "flac" | "mp3";

export type JobStatus =
	| "pending"
	| "fetching-info"
	| "editing"
	| "downloading"
	| "cutting"
	| "tagging"
	| "done"
	| "failed"
	| "cancelled";

export type JobEvent =
	| { type: "info"; info: VideoInfo }
	| { type: "draft"; draft: CutDraft }
	| {
			type: "progress";
			pct: number;
			speed: string;
			eta: string;
			downloaded: number;
			total: number;
	  }
	| { type: "cutting"; segmentIndex: number; total: number; pct: number }
	| { type: "done"; files: string[] }
	| { type: "error"; message: string };

export interface Job {
	id: JobId;
	url: string;
	mode: JobMode;
	status: JobStatus;
	format: AudioFormat;
	events: JobEvent[];
	createdAt: number;
}

// ─── Library / settings ─────────────────────────────────────────────────────

export interface Track {
	id: string;
	path: string;
	title: string;
	artist: string;
	album: string;
	/** Track number (1-based) when known; used by path templates as `{track}`. */
	track?: number;
	duration: number;
	format: AudioFormat;
}

export interface Settings {
	outputDir: string;
	format: AudioFormat;
	pathTemplate: string;
}

// ─── HTTP API ────────────────────────────────────────────────────────────────

export interface CreateJobRequest {
	url: string;
	mode?: JobMode;
	format?: AudioFormat;
}

export interface CreateJobResponse {
	jobId: JobId;
}

/**
 * Confirms a split-by-chapters job: the frontend sends back the user-edited
 * CutDraft, and the backend derives the final CutPlan and executes the cut.
 */
export interface ConfirmDraftRequest {
	draft: CutDraft;
}

// ─── Settings + library organize API ─────────────────────────────────────────

/** PUT /api/settings — persist the current settings. */
export interface SaveSettingsRequest {
	settings: Settings;
}

/**
 * PATCH /api/library/:id — update a track's tags and move/rename the file to
 * match the current path template. All fields optional; only provided fields
 * are changed.
 */
export interface UpdateTrackRequest {
	title?: string;
	artist?: string;
	album?: string;
	track?: number;
}

/** PATCH /api/library/:id response — the updated track (new path + new id). */
export interface UpdateTrackResponse {
	track: Track;
}

/** POST /api/library/organize response — bulk move files to the templated path. */
export interface OrganizeResponse {
	moved: number;
	tracks: Track[];
}

// ─── MusicBrainz metadata search ─────────────────────────────────────────────

/** POST /api/metadata/search request. */
export interface MetadataSearchRequest {
	/** Free text, or a Lucene-style query like `artist:"X" AND recording:"Y"`. */
	query: string;
	/** Optional artist hint (folded into the query when present). */
	artist?: string;
	type: "recording" | "release";
}

/** A single search result (a recording or a release). */
export interface MetadataResult {
	/** MusicBrainz ID (MBID). */
	id: string;
	type: "recording" | "release";
	/** Recording title or release title. */
	title: string;
	artist: string;
	/** Release title (present for recordings, when MB returned it). */
	album?: string;
	/** Track position in the release (1-based), when known. */
	trackNumber?: number;
	/** 0-100 relevance score from MusicBrainz. */
	score: number;
}

/** One track on a release (used inside ReleaseDetail). */
export interface ReleaseTrack {
	/** Track number (1-based). */
	position: number;
	title: string;
	/** Duration in milliseconds, when MB returned it. */
	length?: number;
	/** MBID of the underlying recording. */
	recordingId: string;
}

/** Full release detail with the track list (for album match-all). */
export interface ReleaseDetail {
	id: string;
	title: string;
	artist: string;
	/** Release date as MB returned it (e.g. "1973-03-01"). */
	date?: string;
	tracks: ReleaseTrack[];
}

/** A single segment→track match inside an AlbumMatchResult. */
export interface AlbumMatch {
	segmentIndex: number;
	track: ReleaseTrack;
	confidence: "position" | "title" | "none";
}

/** Result of matching a CutDraft's segments against a release's tracks. */
export interface AlbumMatchResult {
	matches: AlbumMatch[];
}

/** POST /api/metadata/match-album request. */
export interface MatchAlbumRequest {
	draft: CutDraft;
	releaseId: string;
}

// ─── WebSocket protocol ──────────────────────────────────────────────────────

/** Client → server messages over the WS. */
export type WsClientMessage =
	| { type: "subscribe"; jobId: JobId }
	| { type: "unsubscribe"; jobId: JobId };

/** Server → client messages over the WS. */
export type WsServerMessage =
	| { type: "subscribed"; jobId: JobId }
	| { type: "unsubscribed"; jobId: JobId }
	| { type: "event"; jobId: JobId; event: JobEvent }
	| { type: "error"; message: string };
