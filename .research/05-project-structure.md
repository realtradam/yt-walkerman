# 05 — Proposed Project Structure (mirroring ../dispatch)

> Mirrors the `../dispatch` workspace: a root directory (not a git repo)
> containing two sibling repos — backend and frontend — plus `bin/` and
> `worktrees/`. Same stack, same conventions, same architecture principles.

## Workspace layout

```
yt-music-dl/                            ← workspace root (NOT a git repo)
├── yt-music-dl-backend/                ← backend repo (git, branch: dev)
│   ├── packages/                       ← monorepo workspaces (Bun)
│   │   ├── host-bin/                   entry point — boots the server
│   │   ├── downloader/                  yt-dlp wrapper (effect at the edge)
│   │   ├── tagger/                      node-id3 + music-metadata wrapper
│   │   ├── library/                     organize/scan files, manage collection
│   │   ├── job-store/                   download state machine + cut-plan logic (pure core)
│   │   ├── storage-sqlite/              bun:sqlite persistence
│   │   ├── transport-http/             REST API (jobs, library, settings)
│   │   ├── transport-ws/               WebSocket (live progress, surfaces)
│   │   ├── sponsorblock/                SB API client (fetch wrapper — effect)
│   │   ├── cutter/                      ffmpeg cut/concat executor (effect)
│   │   ├── contract/                    shared types ← consumed by frontend as file: dep
│   │   └── cli/                         (optional) CLI to drive downloads
│   ├── bin/                            install, setup-env, build, up
│   ├── AGENTS.md                       architecture rules (mirrors dispatch-backend)
│   ├── biome.json                      tabs, double quotes, semicolons, width 100
│   ├── tsconfig.base.json              strict + noUncheckedIndexedAccess + ...
│   ├── vitest.config.ts
│   ├── package.json                    workspaces: ["packages/*"]
│   └── .env / .env.example
├── yt-music-dl-web/                    ← frontend repo (git, branch: dev)
│   ├── src/
│   │   ├── app/                        composition root
│   │   ├── core/                       pure: transcript/cache/protocol/wire
│   │   ├── features/
│   │   │   ├── download/               download form, progress view, job list
│   │   │   ├── segment-editor/         cut-plan editor: timeline, per-segment
│   │   │   │                           title/art/trim, add/remove/split/merge,
│   │   │   │                           toggle SB segments (pure reducers + .svelte)
│   │   │   ├── library/                browse/edit/re-tag the collection
│   │   │   └── settings/               output format, path template, etc.
│   │   ├── adapters/                   WS client, fetch, IndexedDB
│   │   └── app.css
│   ├── AGENTS.md                       FE architecture rules (mirrors dispatch-web)
│   ├── biome.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json                    "@yt-music/contract": "file:../yt-music-dl-backend/packages/contract"
├── bin/
│   └── up                              bring up backend (--watch) + frontend (vite)
├── worktrees/                          feature worktrees (per-feature: backend/ + frontend/)
├── .research/                          ← this directory
└── AGENTS.md                           workspace root orchestrator guide (mirrors dispatch root)
```

## Naming

Following dispatch's convention (`dispatch-backend`, `dispatch-web`), ours are:
- `yt-music-dl-backend`
- `yt-music-dl-web`

Shared contract package: `@yt-music/contract` (mirrors `@dispatch/wire`,
`@dispatch/ui-contract`).

## Backend package responsibilities (mirroring dispatch's kernel/extensions split)

Dispatch's principle: **pure core / injected shell / typed contracts / no ambient
state.** Applied here:

| Package | Layer | Responsibility | I/O? |
|---|---|---|---|
| `contract` | shared | TS types for Job, JobEvent, VideoInfo, Chapter, SponsorSegment, CutDraft, CutPlan, Track, Settings | none |
| `job-store` | **pure core** | download state machine: `reconcile(JobEvent[]) → JobState`; pending→info→editing→cutting→tagging→done/failed; resume/recovery. Also: `parseChapterTitle`, `computeDefaultDraft`, `computeKeepRanges`, `finalizeCutPlan` | **zero** |
| `downloader` | shell (edge) | spawns yt-dlp, parses `--progress-template` JSON lines → `AsyncIterable<JobEvent>`; `getInfo(url)` via `--dump-json`; cancel via kill | subprocess |
| `sponsorblock` | shell (edge) | `fetch` wrapper for `GET /api/skipSegments/:hashPrefix` → `SponsorSegment[]` | network |
| `cutter` | shell (edge) | executes `CutPlan` with ffmpeg: `-ss`/`-to` stream-copy + concat demuxer; lossless | subprocess + fs |
| `tagger` | shell (edge) | reads/writes tags via node-id3 + music-metadata; drives yt-dlp `--embed-metadata`; embeds per-segment album art | filesystem |
| `library` | shell (edge) | scans output dir, indexes tracks, moves/renames per template | filesystem |
| `storage-sqlite` | shell (edge) | persists jobs + cut drafts + library + settings via `bun:sqlite`; append-only + reconcile (dispatch durability) | sqlite |
| `transport-http` | shell | REST: POST /jobs, POST /jobs/:id/confirm, POST /jobs/:id/art, GET /library, PUT /settings... | network |
| `transport-ws` | shell | pushes JobEvent stream to connected clients (progress + draft + cutting UI) | network |
| `host-bin` | composition | wires everything: load contract, inject downloader+sb+cutter+tagger+store into the HTTP/WS server | boot |

The **pure core** (`job-store`) has zero I/O and is unit-tested with no mocks
(dispatch's asymmetric testing: strict core, lenient shell). The downloader is an
injected effect — testable by feeding it canned event streams.

## The contract (the one cross-repo surface)

`packages/contract/src/index.ts` exports the types both repos share:

```ts
export type JobId = string;
export type JobStatus =
  | "pending" | "fetching-info" | "editing"   // pre-cut: gather data, user edits plan
  | "downloading" | "cutting" | "tagging"     // execution
  | "done" | "failed" | "cancelled";

export interface VideoInfo {
  id: string;            // youtube id
  title: string;
  uploader: string;
  duration: number;     // seconds
  thumbnail: string;
  webpageUrl: string;
  chapters?: Chapter[]; // present if the video has chapters (album compilations)
  // ...
}

export interface Chapter {
  title: string;
  startTime: number;    // seconds
  endTime: number;
}

export type SponsorCategory =
  | "sponsor" | "selfpromo" | "interaction"
  | "intro" | "outro" | "preview"
  | "music_offtopic" | "filler";

export interface SponsorSegment {
  start: number;        // seconds
  end: number;
  category: SponsorCategory;
  uuid: string;
}

// The editable cut-plan document the frontend manipulates (see doc 07)
export interface SegmentDraft {
  id: string;
  title: string;
  artist: string;
  album: string;
  trackNumber: number;
  albumArt: AlbumArtRef;
  start: number;        // seconds — trimmable
  end: number;
  removedSegments: RemovedSegmentDraft[];
}
export interface CutDraft {
  sourceVideoId: string;
  sourceDuration: number;
  segments: SegmentDraft[];
  globalAlbum: string;
  globalAlbumArt: AlbumArtRef;
  globalArtist: string;
}
export interface CutPlan { segments: CutSegment[]; }  // finalized — resolved + validated

export type JobEvent =
  | { type: "info"; info: VideoInfo }
  | { type: "draft"; draft: CutDraft }                       // sensible defaults → editor
  | { type: "progress"; pct: number; speed: string; eta: string; downloaded: number; total: number }
  | { type: "cutting"; segmentIndex: number; total: number; pct: number }
  | { type: "done"; files: string[] }
  | { type: "error"; message: string };

export interface Job {
  id: JobId;
  url: string;
  mode: "single" | "split-by-chapters";
  status: JobStatus;
  format: "flac" | "mp3";
  events: JobEvent[];     // append-only
  createdAt: number;
}

export interface Track { /* library entry — read from tagged files */ }
export interface Settings { outputDir: string; format: "flac" | "mp3"; pathTemplate: string; }
```

The frontend imports this as `"@yt-music/contract": "file:../yt-music-dl-backend/packages/contract"`
and mirrors it to `.dispatch/*.reference.md` (dispatch pattern). `lsp references`
within each repo works; cross-repo changes go through the living handoff doc.

## Stack — identical to dispatch

### Backend
- **Bun** (runtime + `bun:sqlite`)
- **TypeScript** strict (`tsconfig.base.json` with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, composite/project refs)
- **Biome** (tabs, double quotes, semicolons, width 100) — same config as dispatch
- **Vitest**
- Commands: `bun run typecheck` (`tsc -b --pretty`), `bun run test`, `bun run check`
  (biome), `bun run dev` (`bun --watch packages/host-bin/src/main.ts`)

### Frontend
- **Bun + Vite + Svelte 5 (runes) + TypeScript** (strict)
- **TailwindCSS v4 + DaisyUI** (same as dispatch-web)
- **Biome** (.ts/.js) + **svelte-check** (.svelte)
- **Vitest + @testing-library/svelte**
- Consumes `@yt-music/contract` as a `file:` dep
- Commands mirror dispatch-web: `typecheck`, `test`, `check`, `build`, `dev`

## bin/up (mirrors dispatch's bin/up)

A `bin/up` script at the workspace root that brings up both:
- backend: `bun --watch packages/host-bin/src/main.ts` → HTTP + WS
- frontend: `bun run dev` (vite) → dev server with HMR

With a cleanup trap that kills both process groups on Ctrl-C (copy the dispatch
`bin/up` structure: `setsid` per child, `kill -TERM -$PG`).

## External dependencies to install (system level, require user)

These are the runtime binaries the backend shells out to. They are NOT npm
packages and must be installed via the system package manager. I (the agent)
cannot install them — the user must.

| Binary | Purpose | Arch Linux command |
|---|---|---|
| `yt-dlp` | download engine | `sudo pacman -S yt-dlp` |
| `ffmpeg` | audio extract/transcode + metadata muxing (yt-dlp dep) | `sudo pacman -S ffmpeg` |
| `flac` / `metaflac` | (optional) in-place FLAC tag edits | `sudo pacman -S flac` |

> `yt-dlp` and `ffmpeg` are **hard requirements**. `metaflac` is optional (only
> for FLAC tag editing in the UI; MP3 editing uses the pure-JS `node-id3`).

## Suggested first features (implementation order)

1. **Contract + downloader**: `@yt-music/contract` types (Job, JobEvent,
   VideoInfo, Chapter); `downloader` package that spawns yt-dlp with
   `--progress-template` + `--dump-json` and yields `JobEvent[]`. Pure reducer in
   `job-store` (`reconcile`). Unit tests (feed canned JSON lines). *Binary fetched
   by `bin/install-yt-dlp`.*
2. **storage-sqlite + transport-http**: persist jobs; `POST /jobs { url }`,
   `GET /jobs`. `bun:sqlite`, append-only + reconcile (dispatch durability).
3. **transport-ws**: push `JobEvent` to clients. The frontend progress bar.
4. **Frontend download feature**: paste URL → see live progress. Svelte + WS.
5. **Chapters + SponsorBlock (album splitting)**: `downloader.getInfo` exposes
   `chapters[]`; `sponsorblock` client fetches segments; `computeDefaultDraft`
   (pure) builds sensible defaults; WS emits `{ type: "draft" }`.
6. **Segment editor (frontend)**: timeline + per-segment title/art/trim,
   add/remove/split/merge, toggle SB segments. Pure reducers + thin `.svelte`.
   `POST /jobs/:id/confirm { draft }`.
7. **cutter (ffmpeg)**: `finalizeCutPlan` (pure) → `cutter` executes with
   `-c copy` + concat demuxer (lossless). WS progress per segment.
8. **tagger**: embed per-segment metadata + album art (`node-id3` / ffmpeg).
9. **library**: scan output dir, index with `music-metadata`, show collection.
10. **Organize**: path templates, move/rename, album grouping.

## What to do next (ask the user)

1. **Confirm the stack decision** (Bun + TS, shell out to yt-dlp) — or raise
   objections to the research before we scaffold.
2. **Install system deps**: `sudo pacman -S yt-dlp ffmpeg` (and optionally `flac`).
3. **Scaffold the workspace**: I can create the two repos, `bin/up` +
   `bin/install-yt-dlp`, the `contract` package, `AGENTS.md` files (mirroring
   dispatch), biome/tsconfig, and a minimal `host-bin` + downloader skeleton.
