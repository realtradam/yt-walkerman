/**
 * @yt-music/host-bin — composition root.
 *
 * Wires the downloader (effect) + storage (effect) + HTTP API + WebSocket.
 * When a job is created: fetch info, download, persist events (append-only),
 * and broadcast each event to subscribed WS clients. Status is DERIVED from
 * events via reconcile() — never stored as a field.
 *
 * Run: `bun --watch packages/host-bin/src/main.ts`  (or `bun run dev`)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AudioFormat,
	ConfirmDraftRequest,
	CreateJobRequest,
	CreateJobResponse,
	CutDraft,
	JobEvent,
	JobId,
	JobMode,
	MatchAlbumRequest,
	MetadataResult,
	MetadataSearchRequest,
	OrganizeResponse,
	ReleaseDetail,
	SaveSettingsRequest,
	Settings,
	UpdateTrackRequest,
	UpdateTrackResponse,
	WsClientMessage,
	WsServerMessage,
} from "@yt-music/contract";
import { computeDefaultDraft, finalizeCutPlan } from "@yt-music/cut-plan";
import { createCutter } from "@yt-music/cutter";
import { createDownloader } from "@yt-music/downloader";
import { createLibrary } from "@yt-music/library";
import { createMusicBrainzClient, matchAlbumToDraft } from "@yt-music/musicbrainz";
import { DEFAULT_PATH_TEMPLATE } from "@yt-music/path-template";
import { createSponsorBlockClient } from "@yt-music/sponsorblock";
import { createStorage } from "@yt-music/storage-sqlite";
import { createTagReader, createTagWriter } from "@yt-music/tagger";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.YTMDL_PORT ?? 24303);
const HOSTNAME = process.env.YTMDL_HOSTNAME ?? "127.0.0.1";
const DB_PATH = process.env.YTMDL_DB_PATH ?? "./.data/yt-music-dl.db";

// Resolve the yt-dlp binary: env → PATH (Bun.which) → bin/yt-dlp → "yt-dlp"
const YTDLP_BIN = resolveYtDlp();

function resolveYtDlp(): string {
	const env = process.env.YTMDL_YTDLP_PATH;
	if (env) return env;
	const which = Bun.which("yt-dlp");
	if (which) return which;
	// Check bin/yt-dlp (fetched by bin/install-yt-dlp, relative to backend root)
	const local = new URL("../../bin/yt-dlp", import.meta.url).pathname;
	if (existsSync(local)) return local;
	return "yt-dlp";
}

// --- persisted settings ---
// Defaults are derived from env (the edge owns env access); the storage layer
// returns these when nothing is persisted yet. After the first PUT the
// persisted value wins (so the host uses the persisted settings, not just env).
const defaultSettings: Settings = {
	outputDir: process.env.YTMDL_OUTPUT_DIR ?? "./output",
	format: (process.env.YTMDL_FORMAT ?? "flac") as AudioFormat,
	pathTemplate: DEFAULT_PATH_TEMPLATE,
};

// --- effects (injected at the edge) ---
const storage = createStorage(DB_PATH, defaultSettings);
const initialSettings = storage.getSettings();
const OUTPUT_DIR = initialSettings.outputDir;
const FORMAT = initialSettings.format;
const downloader = createDownloader(YTDLP_BIN);
const library = createLibrary(
	OUTPUT_DIR,
	createTagReader(),
	createTagWriter(process.env.YTMDL_METAFLAC_PATH),
);
const tagWriter = createTagWriter(process.env.YTMDL_METAFLAC_PATH);
const sponsorblock = createSponsorBlockClient();
const musicbrainz = createMusicBrainzClient();
const cutter = createCutter(process.env.YTMDL_FFMPEG_PATH);

// Ensure output + data dirs exist
mkdirSync(OUTPUT_DIR, { recursive: true });
const dbDir = DB_PATH.replace(/\/[^/]+$/, "");
mkdirSync(dbDir, { recursive: true });

// --- WebSocket subscribers: jobId → Set of WS clients ---
type Ws = ServerWebSocket<undefined>;
const subscribers = new Map<JobId, Set<Ws>>();

// Split jobs pause at the "editing" stage and await the user's confirmed draft
// (POST /api/jobs/:id/confirm). The awaiting promise's resolver lives here.
const pendingConfirms = new Map<JobId, (draft: CutDraft) => void>();

function broadcast(jobId: JobId, msg: WsServerMessage) {
	const subs = subscribers.get(jobId);
	if (!subs) return;
	for (const ws of subs) {
		if (ws.readyState === 1) ws.send(JSON.stringify(msg)); // 1 = OPEN
	}
}

// --- job orchestration (the imperative shell) ---

/** Emit + persist one job event, and broadcast it to WS subscribers. */
function makeEmitter(jobId: JobId) {
	return (event: JobEvent) => {
		storage.appendEvent(jobId, event);
		broadcast(jobId, { type: "event", jobId, event });
	};
}

// --- cover art (Cover Art Archive) ---

let artCounter = 0;

/**
 * Download a cover-art image from a URL (typically a Cover Art Archive
 * `…/release/<MBID>/front` URL, which 307-redirects to a JPEG) to a temp file.
 *
 * EFFECT: network fetch + fs write. Returns the temp file path on success, or
 * `undefined` on any failure (network error, non-2xx, empty body) so callers can
 * skip art embedding gracefully. The caller owns cleanup of the temp file.
 *
 * `fetch` follows redirects by default, so the CAA 307 → image-host hop is
 * transparent. The temp filename uses a counter (process-unique) + the URL's
 * content-type-derived extension (defaulting to `.jpg`).
 */
async function downloadCoverArt(url: string): Promise<string | undefined> {
	try {
		const res = await fetch(url);
		if (!res.ok) {
			console.warn(`[cover-art] fetch failed (${res.status}) for ${url}`);
			return undefined;
		}
		const buf = await res.arrayBuffer();
		if (buf.byteLength === 0) {
			console.warn(`[cover-art] empty body for ${url}`);
			return undefined;
		}
		const ext = mimeToExt(res.headers.get("content-type") ?? "");
		artCounter++;
		const path = join(tmpdir(), `ytmdl-art-${process.pid}-${artCounter}.${ext}`);
		writeFileSync(path, Buffer.from(buf));
		return path;
	} catch (err) {
		console.warn(`[cover-art] download failed for ${url}: ${String(err)}`);
		return undefined;
	}
}

/** Map a content-type to a file extension for cover art (default jpg). */
function mimeToExt(mime: string): string {
	const m = mime.toLowerCase().split(";")[0]?.trim();
	if (m === "image/png") return "png";
	if (m === "image/webp") return "webp";
	return "jpg";
}

/** Remove a temp file if it exists; never throws (best-effort cleanup). */
function cleanupTempFile(path: string | undefined): void {
	if (!path) return;
	try {
		rmSync(path, { force: true });
	} catch {
		// best-effort
	}
}

/** Resolve an AlbumArtRef of kind "url" to a downloaded temp file path. */
async function resolveArtPath(
	albumArt: import("@yt-music/contract").AlbumArtRef,
): Promise<string | undefined> {
	if (albumArt.kind === "url") {
		return downloadCoverArt(albumArt.url);
	}
	// "video-thumbnail" and "uploaded" are not handled in this phase.
	return undefined;
}

/** Single-track download (Phase 1): getInfo → download → organize → done. */
async function runSingleJob(
	_jobId: JobId,
	url: string,
	format: AudioFormat,
	emit: (e: JobEvent) => void,
) {
	const info = await downloader.getInfo(url);
	emit({ type: "info", info });

	const dl = downloader.download(url, { outputDir: OUTPUT_DIR, format });
	for await (const p of dl.progress) {
		emit({
			type: "progress",
			pct: p.pct,
			speed: p.speed,
			eta: p.eta,
			downloaded: p.downloaded,
			total: p.total,
		});
	}
	const rawFiles = await dl.done;
	// Move the output to its templated path (artist/album/...). Best-effort: a
	// move failure does not fail the whole job — the file is still on disk.
	const files = await organizeDownloaded(rawFiles);
	emit({ type: "done", files: files.length > 0 ? files : ["(see output dir)"] });
}

/**
 * Move each freshly-downloaded file to the location its tags + the current path
 * template dictate. Uses the persisted settings' pathTemplate (fresh read, so a
 * settings PUT before the download takes effect). Best-effort: files that fail
 * to move are kept at their original path.
 */
async function organizeDownloaded(files: string[]): Promise<string[]> {
	const settings = storage.getSettings();
	const out: string[] = [];
	for (const f of files) {
		try {
			out.push(await library.applyPathTemplate(f, settings));
		} catch (err) {
			console.warn(`[organize] could not move ${f}: ${String(err)}`);
			out.push(f);
		}
	}
	return out;
}

/**
 * Split-by-chapters download (Phase 3):
 *  1. getInfo → chapters
 *  2. sponsorblock.getSegments (optional — failures → no removedSegments)
 *  3. computeDefaultDraft (pure) → emit { type: "draft" } so the frontend shows
 *     the segment editor
 *  4. WAIT for POST /api/jobs/:id/confirm { draft }
 *  5. download the raw audio (no --sponsorblock-remove)
 *  6. finalizeCutPlan (pure) → CutPlan
 *  7. cutter.execute → output files, emitting { type: "cutting" } progress
 *  8. tagger tags each output file (MP3 via node-id3, FLAC via metaflac)
 *  9. emit { type: "done", files }
 */
async function runSplitJob(
	jobId: JobId,
	url: string,
	format: AudioFormat,
	emit: (e: JobEvent) => void,
) {
	const info = await downloader.getInfo(url);
	emit({ type: "info", info });

	// SponsorBlock is optional: a failure / 404 just means no removedSegments.
	let sponsorSegments: import("@yt-music/contract").SponsorSegment[] = [];
	try {
		sponsorSegments = await sponsorblock.getSegments(info.id);
	} catch {
		sponsorSegments = [];
	}

	const draft = computeDefaultDraft(info, info.chapters ?? [], sponsorSegments);
	emit({ type: "draft", draft });

	// Pause until the user confirms the (possibly edited) draft.
	const confirmed = await new Promise<CutDraft>((resolve) => {
		pendingConfirms.set(jobId, resolve);
	});
	pendingConfirms.delete(jobId);

	// Download the raw, unsplit audio (no --sponsorblock-remove).
	const dl = downloader.download(url, { outputDir: OUTPUT_DIR, format });
	for await (const p of dl.progress) {
		emit({
			type: "progress",
			pct: p.pct,
			speed: p.speed,
			eta: p.eta,
			downloaded: p.downloaded,
			total: p.total,
		});
	}
	const rawFiles = await dl.done;
	const rawAudio = pickRawAudio(rawFiles, format);
	if (!rawAudio) throw new Error("yt-dlp produced no audio file to cut");

	// Derive the final, validated plan (pure) — may throw CutPlanError.
	const cutPlan = finalizeCutPlan(confirmed);

	// Execute the cut with ffmpeg.
	const files = await cutter.execute(cutPlan, rawAudio, { outputDir: OUTPUT_DIR, format }, (p) =>
		emit({ type: "cutting", segmentIndex: p.segmentIndex, total: p.total, pct: p.pct }),
	);

	// Tag each output file with its segment's metadata. Best-effort: a tag-write
	// failure for one file is logged but does not fail the whole job (the cut
	// audio is still on disk). MP3 uses node-id3 (ID3v2); FLAC uses metaflac
	// (Vorbis comments). Both are dispatched by createTagWriter → detectFormat.
	// When a segment has a url-kind AlbumArtRef (Cover Art Archive), the art is
	// downloaded to a temp file and passed as `artPath` so the tagger embeds a
	// front-cover picture (APIC for MP3, PICTURE block for FLAC). Art download /
	// embed failures are caught and skipped — the text tags still get written.
	for (let i = 0; i < files.length; i++) {
		const seg = cutPlan.segments[i];
		if (!seg) continue;
		const file = files[i] ?? "";
		let artPath: string | undefined;
		try {
			artPath = await resolveArtPath(seg.albumArt);
		} catch (err) {
			console.warn(`[job ${jobId}] cover art download failed for ${file}: ${String(err)}`);
		}
		try {
			await tagWriter.write(file, {
				title: seg.title,
				artist: seg.artist,
				album: seg.album,
				track: seg.trackNumber,
				duration: 0,
				format,
				...(artPath ? { artPath } : {}),
			});
		} catch (err) {
			console.warn(`[job ${jobId}] tag write failed for ${file}: ${String(err)}`);
		}
		cleanupTempFile(artPath);
	}

	// Move each tagged file to its templated path (artist/album/track - title).
	const organized = await organizeDownloaded(files);
	emit({ type: "done", files: organized });
}

/** Pick the final audio file (matching the target extension) from yt-dlp output. */
function pickRawAudio(files: string[], format: AudioFormat): string | undefined {
	const match = files.filter((f) => f.endsWith(`.${format}`));
	return match.at(-1) ?? files.at(-1);
}

/** Dispatch a job to its mode-specific runner. */
async function runJob(jobId: JobId, url: string, format: AudioFormat, mode: JobMode) {
	const emit = makeEmitter(jobId);
	try {
		if (mode === "split-by-chapters") {
			await runSplitJob(jobId, url, format, emit);
		} else {
			await runSingleJob(jobId, url, format, emit);
		}
	} catch (err) {
		emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
	}
}

// --- HTTP + WS server ---
const server = Bun.serve({
	hostname: HOSTNAME,
	port: PORT,
	async fetch(req, server) {
		const url = new URL(req.url);

		// --- WebSocket upgrade ---
		if (url.pathname === "/ws") {
			if (!server.upgrade(req)) return new Response("upgrade failed", { status: 400 });
			return undefined;
		}

		// --- health ---
		if (url.pathname === "/health" || url.pathname === "/api/health") {
			return Response.json({ ok: true, service: "yt-music-dl-backend" });
		}

		// --- API: create job ---
		if (url.pathname === "/api/jobs" && req.method === "POST") {
			const body = (await req.json()) as CreateJobRequest;
			if (!body?.url) return Response.json({ error: "url is required" }, { status: 400 });
			const format = body.format ?? FORMAT;
			const mode = body.mode ?? "single";
			const jobId = storage.createJob(body.url, mode, format);
			runJob(jobId, body.url, format, mode).catch((e) => console.error(`[job ${jobId}]`, e));
			const res: CreateJobResponse = { jobId };
			return Response.json(res);
		}

		// --- API: confirm a split-by-chapters draft ---
		// POST /api/jobs/:id/confirm { draft } — resumes a paused split job.
		const confirmMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/confirm$/);
		if (confirmMatch?.[1] && req.method === "POST") {
			const jobId = confirmMatch[1];
			const body = (await req.json()) as ConfirmDraftRequest;
			if (!body?.draft) {
				return Response.json({ error: "draft is required" }, { status: 400 });
			}
			const resolve = pendingConfirms.get(jobId);
			if (!resolve) {
				return Response.json({ error: "job is not awaiting confirmation" }, { status: 409 });
			}
			resolve(body.draft);
			return Response.json({ ok: true });
		}

		// --- API: list jobs ---
		if (url.pathname === "/api/jobs" && req.method === "GET") {
			return Response.json({ jobs: storage.listJobs() });
		}

		// --- API: library (scan output dir, index tracks) ---
		if (url.pathname === "/api/library" && req.method === "GET") {
			const tracks = await library.listTracks();
			return Response.json({ tracks });
		}

		// --- API: settings (read/write persisted settings) ---
		if (url.pathname === "/api/settings" && req.method === "GET") {
			return Response.json(storage.getSettings());
		}
		if (url.pathname === "/api/settings" && req.method === "PUT") {
			const body = (await req.json()) as SaveSettingsRequest;
			if (!body?.settings) {
				return Response.json({ error: "settings is required" }, { status: 400 });
			}
			const s = body.settings;
			if (typeof s.outputDir !== "string" || !s.format || typeof s.pathTemplate !== "string") {
				return Response.json({ error: "invalid settings shape" }, { status: 400 });
			}
			storage.saveSettings(s);
			return Response.json(storage.getSettings());
		}

		// --- API: organize library (bulk move files to the templated path) ---
		if (url.pathname === "/api/library/organize" && req.method === "POST") {
			const settings = storage.getSettings();
			const tracks = await library.listTracks();
			let moved = 0;
			for (const t of tracks) {
				try {
					const newPath = await library.applyPathTemplate(t.path, settings);
					if (newPath !== t.path) moved++;
				} catch (err) {
					console.warn(`[organize] could not move ${t.path}: ${String(err)}`);
				}
			}
			// Re-scan so the returned tracks reflect their new paths/ids.
			const fresh = await library.listTracks();
			const res: OrganizeResponse = { moved, tracks: fresh };
			return Response.json(res);
		}

		// --- API: MusicBrainz metadata search ---
		// POST /api/metadata/search { query, artist?, type } → { results: MetadataResult[] }
		if (url.pathname === "/api/metadata/search" && req.method === "POST") {
			const body = (await req.json()) as MetadataSearchRequest;
			if (!body?.query || typeof body.query !== "string") {
				return Response.json({ error: "query is required" }, { status: 400 });
			}
			if (body.type !== "recording" && body.type !== "release") {
				return Response.json({ error: "type must be 'recording' or 'release'" }, { status: 400 });
			}
			try {
				let results: MetadataResult[];
				if (body.type === "recording") {
					results = await musicbrainz.searchRecordings(body.query, body.artist);
				} else {
					results = await musicbrainz.searchReleases(body.query, body.artist);
				}
				return Response.json({ results });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return Response.json({ error: message }, { status: 502 });
			}
		}

		// --- API: MusicBrainz release detail ---
		// GET /api/metadata/release/:mbid → ReleaseDetail
		const releaseLookupMatch = url.pathname.match(/^\/api\/metadata\/release\/([^/]+)$/);
		if (releaseLookupMatch?.[1] && req.method === "GET") {
			const mbid = releaseLookupMatch[1];
			try {
				const detail: ReleaseDetail = await musicbrainz.getRelease(mbid);
				return Response.json(detail);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = message.includes("failed") ? 502 : 500;
				return Response.json({ error: message }, { status });
			}
		}

		// --- API: match a release's tracks to a CutDraft's segments ---
		// POST /api/metadata/match-album { draft, releaseId } → AlbumMatchResult
		if (url.pathname === "/api/metadata/match-album" && req.method === "POST") {
			const body = (await req.json()) as MatchAlbumRequest;
			if (!body?.draft) {
				return Response.json({ error: "draft is required" }, { status: 400 });
			}
			if (!body.releaseId || typeof body.releaseId !== "string") {
				return Response.json({ error: "releaseId is required" }, { status: 400 });
			}
			try {
				const release = await musicbrainz.getRelease(body.releaseId);
				const result = matchAlbumToDraft(body.draft, release);
				return Response.json(result);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return Response.json({ error: message }, { status: 502 });
			}
		}

		// --- API: rename a track (update tags + move to templated path) ---
		const renameMatch = url.pathname.match(/^\/api\/library\/([^/]+)$/);
		if (renameMatch?.[1] && req.method === "PATCH") {
			const id = renameMatch[1];
			const body = (await req.json()) as UpdateTrackRequest;
			if (!body || typeof body !== "object") {
				return Response.json({ error: "invalid body" }, { status: 400 });
			}
			const settings = storage.getSettings();
			// When artUrl is provided, download the cover art (Cover Art Archive
			// → temp file) at the edge, then pass the path to the library which
			// embeds it via the tagger. Download failures are skipped gracefully
			// — the tag update proceeds without art.
			let artPath: string | undefined;
			if (body.artUrl) {
				try {
					artPath = await downloadCoverArt(body.artUrl);
				} catch (err) {
					console.warn(`[library] cover art download failed for ${id}: ${String(err)}`);
				}
			}
			try {
				const track = await library.renameTrack(id, body, settings, artPath);
				const res: UpdateTrackResponse = { track };
				return Response.json(res);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = message.includes("not found") ? 404 : 500;
				return Response.json({ error: message }, { status });
			} finally {
				cleanupTempFile(artPath);
			}
		}

		// --- API: get job ---
		const jobMatch = url.pathname.match(/^\/api\/jobs\/(.+)$/);
		if (jobMatch?.[1]) {
			const job = storage.getJob(jobMatch[1]);
			if (!job) return Response.json({ error: "not found" }, { status: 404 });
			return Response.json(job);
		}

		// --- root ---
		if (url.pathname === "/" || url.pathname === "/api") {
			return Response.json({ service: "yt-music-dl-backend", version: "0.0.0" });
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open() {
			// client must send a subscribe message
		},
		async message(ws, message) {
			let msg: WsClientMessage;
			try {
				msg = JSON.parse(message.toString()) as WsClientMessage;
			} catch {
				const err: WsServerMessage = { type: "error", message: "invalid JSON" };
				ws.send(JSON.stringify(err));
				return;
			}
			switch (msg.type) {
				case "subscribe": {
					let subs = subscribers.get(msg.jobId);
					if (!subs) {
						subs = new Set();
						subscribers.set(msg.jobId, subs);
					}
					subs.add(ws);
					const ack: WsServerMessage = { type: "subscribed", jobId: msg.jobId };
					ws.send(JSON.stringify(ack));
					// replay existing events so the client catches up
					const job = storage.getJob(msg.jobId);
					if (job) {
						for (const event of job.events) {
							const ev: WsServerMessage = { type: "event", jobId: msg.jobId, event };
							ws.send(JSON.stringify(ev));
						}
					}
					break;
				}
				case "unsubscribe": {
					subscribers.get(msg.jobId)?.delete(ws);
					const ack: WsServerMessage = { type: "unsubscribed", jobId: msg.jobId };
					ws.send(JSON.stringify(ack));
					break;
				}
				default: {
					const _exhaustive: never = msg;
					void _exhaustive;
				}
			}
		},
		close(ws) {
			for (const [, subs] of subscribers) {
				subs.delete(ws);
			}
		},
	},
});

console.log(`[yt-music-dl] backend → http://${HOSTNAME}:${server.port}   (bun --watch)`);
console.log(`[yt-music-dl] health  → GET /health`);
console.log(`[yt-music-dl] create  → POST /api/jobs { "url": "..." }`);
console.log(`[yt-music-dl] ws      → ws://${HOSTNAME}:${server.port}/ws`);
console.log(`[yt-music-dl] output  → ${OUTPUT_DIR}`);
console.log(`[yt-music-dl] yt-dlp  → ${YTDLP_BIN}`);
console.log(`[yt-music-dl] metaflac → ${process.env.YTMDL_METAFLAC_PATH ?? "metaflac (PATH)"}`);
