/**
 * @yt-music/storage-sqlite — append-only persistence for jobs + events.
 *
 * EFFECT at the edge: reads/writes SQLite via `bun:sqlite`. The pure
 * `reconcile()` (in @yt-music/job-store) folds the persisted events back into
 * a JobState on load — durability: status is DERIVED, never trusted from disk.
 *
 * Schema: two tables — `jobs` (one row per job) + `job_events` (append-only
 * log, one row per event). Events are stored as JSON; the reducer re-derives
 * status on read.
 */
import { Database } from "bun:sqlite";
import type { AudioFormat, Job, JobEvent, JobId, JobMode, Settings } from "@yt-music/contract";
import { reconcile } from "@yt-music/job-store";

export interface Storage {
	createJob(url: string, mode: JobMode, format: AudioFormat): JobId;
	appendEvent(jobId: JobId, event: JobEvent): void;
	getJob(jobId: JobId): Job | null;
	listJobs(): Job[];
	/** Persisted settings, or the default passed to `createStorage` if none saved. */
	getSettings(): Settings;
	/** Persist (overwrite) the settings. */
	saveSettings(settings: Settings): void;
	close(): void;
}

export function createStorage(dbPath: string, defaultSettings: Settings): Storage {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			url TEXT NOT NULL,
			mode TEXT NOT NULL,
			format TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS job_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			job_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			event_json TEXT NOT NULL,
			FOREIGN KEY (job_id) REFERENCES jobs(id),
			UNIQUE (job_id, seq)
		);
		CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, seq);
	`);
	// Single-row settings table (id = 1). Settings are user-editable; stored as
	// JSON so adding a field later needs no migration.
	db.exec(`
		CREATE TABLE IF NOT EXISTS settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			settings_json TEXT NOT NULL
		);
	`);

	const insertJob = db.prepare(
		"INSERT INTO jobs (id, url, mode, format, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	const insertEvent = db.prepare(
		"INSERT INTO job_events (job_id, seq, event_json) VALUES (?, ?, ?)",
	);
	const selectJob = db.prepare("SELECT * FROM jobs WHERE id = ?");
	const selectEvents = db.prepare(
		"SELECT event_json FROM job_events WHERE job_id = ? ORDER BY seq ASC",
	);
	const selectAllJobs = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC");
	const selectSettings = db.prepare("SELECT settings_json FROM settings WHERE id = 1");
	const upsertSettings = db.prepare(
		"INSERT INTO settings (id, settings_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json",
	);

	return {
		createJob(url, mode, format): JobId {
			const id = generateJobId();
			insertJob.run(id, url, mode, format, Date.now());
			return id;
		},

		appendEvent(jobId, event) {
			// seq = next sequence number for this job
			const countRow = db
				.prepare("SELECT COUNT(*) as n FROM job_events WHERE job_id = ?")
				.get(jobId) as { n: number } | null;
			const seq = (countRow?.n ?? 0) + 1;
			insertEvent.run(jobId, seq, JSON.stringify(event));
		},

		getJob(jobId): Job | null {
			const row = selectJob.get(jobId) as JobRow | null;
			if (!row) return null;
			const eventRows = selectEvents.all(jobId) as { event_json: string }[];
			const events = eventRows.map((r) => JSON.parse(r.event_json) as JobEvent);
			return {
				id: row.id,
				url: row.url,
				mode: row.mode as JobMode,
				format: row.format as AudioFormat,
				status: reconcile(events).status,
				events,
				createdAt: row.created_at,
			};
		},

		listJobs(): Job[] {
			const rows = selectAllJobs.all() as JobRow[];
			return rows.map((row) => {
				const eventRows = selectEvents.all(row.id) as { event_json: string }[];
				const events = eventRows.map((r) => JSON.parse(r.event_json) as JobEvent);
				return {
					id: row.id,
					url: row.url,
					mode: row.mode as JobMode,
					format: row.format as AudioFormat,
					status: reconcile(events).status,
					events,
					createdAt: row.created_at,
				};
			});
		},

		getSettings(): Settings {
			const row = selectSettings.get() as { settings_json: string } | null;
			if (!row) return defaultSettings;
			try {
				return JSON.parse(row.settings_json) as Settings;
			} catch {
				// Corrupt row — fall back to the default rather than crashing.
				return defaultSettings;
			}
		},

		saveSettings(settings: Settings): void {
			upsertSettings.run(JSON.stringify(settings));
		},

		close() {
			db.close();
		},
	};
}

interface JobRow {
	id: string;
	url: string;
	mode: string;
	format: string;
	created_at: number;
}

function generateJobId(): JobId {
	return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
