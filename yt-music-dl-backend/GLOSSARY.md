# Glossary — canonical vocabulary

> One name per concept. Never invent a synonym. New term? The orchestrator
> proposes the standard/training-baked name and the user confirms before it lands
> here. "Aliases to avoid" maps wrong names back to the canonical one.
>
> Shared terms flow from the backend (canonical) to the frontend verbatim — no
> drift. If the frontend needs a FE-specific term, it goes in the web repo's
> `GLOSSARY.md` under "Frontend-specific", never redefining a backend term.

## Core architecture (mirrors dispatch, adapted)

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **contract** | The typed, exported surface in `@yt-music/contract`: the ONLY thing other units see. Types only — zero runtime, zero `@yt-music/*` deps. | interface (when meaning the whole surface), API |
| **pure core** | Decision logic that is pure `input → output`: zero I/O (no fs, no sqlite, no subprocess, no network). Fully unit-tested with zero internal mocks. | core (when ambiguous with the runtime) |
| **injected shell** | The effectful layer at the edges: subprocess spawners, network clients, fs writers, sqlite store. Injected behind typed interfaces; the pure core never imports a concrete effect. | adapter layer |
| **reconcile** | The pure function (`reconcile(events) → JobState`) run on load that repairs a partial/interrupted job into a valid state. Status is DERIVED from events, never trusted from disk. | recover, repair |
| **effect** | A side-effecting operation (spawn, fetch, fs write, sqlite) injected at the edge. Distinguished from pure logic. | — |
| **surface** | (future) A backend-declared, frontend-agnostic data contribution (fields + values + actions) rendered generically by the client. NOT UI/styling. | widget, panel-data |

## Download domain

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **job** | One download request: a URL → one or more audio files. Identified by `JobId`. Has a status lifecycle and an append-only event log. | task, download (when meaning the whole unit) |
| **JobId** | The string identifier for a job. | taskId, downloadId |
| **job event** | One entry in a job's append-only event log (`JobEvent`): info, draft, progress, cutting, done, error. The atomic unit of the log; folded by `reconcile`. | log entry, event record |
| **JobStatus** | The lifecycle state of a job, DERIVED from events: `pending → fetching-info → editing → downloading → cutting → tagging → done \| failed \| cancelled`. | state |
| **downloader** | The effect package that spawns the `yt-dlp` binary and parses `--progress-template` JSON lines into `JobEvent`s. | yt-dlp wrapper |
| **VideoInfo** | The metadata yt-dlp extracts via `--dump-json` without downloading: title, uploader, duration, thumbnail, chapters. | metadata, video metadata |
| **JobMode** | `single` (one track from the video) or `split-by-chapters` (album video → N tracks via chapter boundaries). | — |

## Chapter splitting

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **chapter** | A YouTube chapter marker: `{ title, startTime, endTime }`. For album/compilation videos, each chapter = one song. Extracted from yt-dlp's `--dump-json` `chapters[]` field. | section, timestamp |
| **CutDraft** | The editable cut-plan document the frontend manipulates: a list of `SegmentDraft`s + global album/artist/art fields. Computed from chapters + sponsor segments as "sensible defaults", then user-edited. | edit plan, cut list |
| **SegmentDraft** | One editable song in the `CutDraft`: title, artist, album, trackNumber, albumArt, time range (trimmable), and the removedSegments within it (toggleable). | track, item |
| **RemovedSegmentDraft** | A segment to cut out from within a song (a SponsorBlock segment or a manual split point), toggleable via `enabled`. | skip, cut point |
| **CutPlan** | The finalized, validated plan derived from the confirmed `CutDraft`: a list of `CutSegment`s, each with `keepRanges`. Drives the ffmpeg execution. | final plan |
| **CutSegment** | One finalized song to extract: metadata + an array of `KeepRange`s (the sub-ranges to keep after removing non-music segments). | output track |
| **KeepRange** | A `{ start, end }` sub-range within a song that ffmpeg extracts (the gaps between removed segments). Concatenated to form the final song. | segment (ambiguous with SegmentDraft) |
| **keep ranges** | The pure computation: given a chapter's time range and the sponsor segments overlapping it, the sub-ranges to KEEP (the gaps). `computeKeepRanges(chapter, segments) → KeepRange[]`. | — |
| **finalizeCutPlan** | The pure function that resolves the user-confirmed `CutDraft` into a `CutPlan`: applies global fields, validates non-overlapping segments, computes final keep-ranges. | — |
| **computeDefaultDraft** | The pure function that produces sensible defaults from `VideoInfo` + chapters + sponsor segments: parsed titles, uploader as artist, video thumbnail as album art, SB segments pre-flagged for removal. | — |
| **parseChapterTitle** | The pure parser that cleans a raw chapter title (`"Artist - 01. Song Name (Official Audio)"`) into `{ artist?, track, trackNumber? }`. | — |

## SponsorBlock

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **SponsorSegment** | A non-music segment from the SponsorBlock API: `{ start, end, category, uuid }`. Crowdsourced; fetched via `GET /api/skipSegments`. | skip segment, sponsor block |
| **SponsorCategory** | The kind of non-content: `sponsor`, `selfpromo`, `interaction`, `intro`, `outro`, `preview`, `music_offtopic`, `filler`. For music, the key one is `music_offtopic`. | — |
| **music_offtopic** | The SponsorBlock category marking non-music sections within a music video. The primary category we remove. | non-music |
| **sponsorblock** | The effect package: a thin `fetch` wrapper hitting the SponsorBlock hash-prefix API. ~30 lines. | SB client |

## Audio / tagging / library

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **track** | A library entry: a tagged audio file in the output collection. `{ path, title, artist, album, duration, format }`. | song (when meaning the library entry), file |
| **AudioFormat** | `flac` (primary — lossless, hi-res Walkman) or `mp3` (compatibility fallback). | codec |
| **tagger** | The effect package that reads/writes audio tags: `node-id3` (ID3v2 write, MP3), `music-metadata` (read any format), and yt-dlp's `--embed-metadata` for the initial download. | metadata writer |
| **cutter** | The effect package that executes a `CutPlan` with ffmpeg: `-ss`/`-to` stream copy + concat demuxer (lossless). | ffmpeg wrapper, splitter |
| **AlbumArtRef** | A reference to album art: `video-thumbnail` (the source video's thumbnail), `url` (a fetched image), or `uploaded` (user-uploaded, stored server-side). | cover art, artwork |

## Tribal knowledge artifacts

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **report** | `reports/<unit>.md` (gitignored): what an agent built — public surface, test/typecheck output, contract gaps. Written by the summoned agent, read by the orchestrator. | summary, log |
| **handoff** | `backend-handoff.md` (web root, tracked): the living document of FE slice status, pinned contract versions, open asks for the backend. The user couriers it between repos. | handoff doc |
| **tasks.md** | The live progress tracker: what's done, in-flight, blocked. Updated at each milestone. | todo, progress |
| **notes/** | Design docs + plans (`notes/<topic>.md`). Tracked. The full design rationale. | docs |

## Known vocabulary drift

- _None yet._ When a term drifts (a synonym sneaks in), record it here with the
  fix so it's never reintroduced.
