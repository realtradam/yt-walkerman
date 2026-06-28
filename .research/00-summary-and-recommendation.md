# yt-music-dl — Research Summary & Recommendation

> Date: 2026-06-25
> Scope: decide how to download, tag, and organize YouTube audio for a Sony
> Walkman, mirroring the `../dispatch` two-repo workspace structure.

## TL;DR / Recommendation

**Keep the dispatch stack (Bun + TypeScript backend, Vite + Svelte frontend).
Shell out to the `yt-dlp` standalone binary — do NOT switch to a Python backend.**

```
yt-music-dl/                        ← workspace root (NOT a git repo), mirrors ../dispatch
├── yt-music-dl-backend/            ← Bun + TS monorepo (packages/*)
│   └── packages/downloader/        ← thin yt-dlp wrapper (effect at the edge)
├── yt-music-dl-web/                ← Vite + Svelte 5 + Tailwind/DaisyUI
├── bin/up                          ← bring up the full stack
├── worktrees/                      ← feature worktrees
└── AGENTS.md
```

- **Download**: `yt-dlp` standalone binary, driven from the backend via our own
  thin TypeScript wrapper built on `Bun.spawn` + yt-dlp's `--progress-template`
  JSON. **We build the wrapper ourselves** (user decision) — no external npm
  dependency to maintain; we understand it fully. Binary fetched by a
  `bin/install-yt-dlp` script. See `01-yt-dlp-integration-options.md`.
- **Progress tracking**: yt-dlp emits one JSON progress object per line on stdout
  (`--progress-template`). The backend parses these and pushes them to the
  frontend over a WebSocket — exactly the dispatch surface/WS pattern.
- **Album splitting (chapters)**: yt-dlp's `--dump-json` includes a `chapters[]`
  field (start/end/title per song). We extract this and let the user review/edit
  in a timeline editor before cutting. See `06-youtube-chapters-splitting.md`.
- **SponsorBlock**: direct API (`GET /api/skipSegments`) fetches non-music
  segments (`music_offtopic`, `sponsor`, `intro`, etc.). We **do not** use
  yt-dlp's `--sponsorblock-remove` — we fetch the segments ourselves, show them
  on the timeline, and let the user toggle keep/remove. See
  `07-sponsorblock-and-ffmpeg.md`.
- **Cut & stitch**: ffmpeg with lossless stream copy (`-c copy` + concat
  demuxer) — no re-encode, no quality loss. The cut plan is computed by a **pure
  function** from chapters + SponsorBlock + user edits.
- **Segment editor (Approach B, confirmed)**: the frontend shows **sensible
  defaults** (parsed titles, uploader as artist, video thumbnail as album art,
  SB segments pre-flagged for removal) and gives the user full control — edit
  title/artist/album/trackNumber per segment, set album art per segment, add /
  remove / split / merge / reorder segments, trim boundaries, toggle SB segments.
  Defaults + edit reducers + finalization are all **pure functions** (unit-tested,
  zero mocks); the Svelte editor is a thin component over them.
- **Tagging**: yt-dlp's `--embed-metadata` + `--embed-thumbnail` for the initial
  download; for per-segment user-set tags: `node-id3` (ID3v2 write, MP3) +
  `music-metadata` (read any format) + ffmpeg for FLAC cover art.
- **Audio conversion**: `ffmpeg` (required by yt-dlp for merging/extracting anyway).

## The three questions, answered

### Q1: Should we create bindings to hook into existing programs like yt-dlp?

**Yes — but a thin wrapper around the CLI binary, not FFI/native bindings.**

yt-dlp ships a **standalone self-contained binary** (no Python runtime needed at
download time). It has first-class progress output via `--progress-template`
(emits JSON lines) and `--print` (structured metadata). A ~150-line TypeScript
wrapper over `Bun.spawn` / `child_process.spawn` gives us:

- Real-time progress (bytes, percentage, speed, ETA) → push to WS
- Cancellation (`subprocess.kill()`)
- Metadata extraction without downloading (`--dump-json`)
- Playlist enumeration

This is simpler, more robust, and more upgrade-proof than native bindings. yt-dlp
updates frequently to counter YouTube changes — a binary swap is trivial; a native
binding would need recompilation. See `01-yt-dlp-integration-options.md`.

### Q2: Are there good JS libraries we could use?

**Yes, several — but yt-dlp (binary) remains the reliability winner.**

| Library | Approach | Verdict |
|---|---|---|
| `youtube-dl-exec` | Wraps yt-dlp binary, auto-installs it | ✅ Best mature wrapper (91 dependents, updated 6 days ago) |
| `ytdlp-nodejs` | Wraps yt-dlp binary, fluent API + progress | ⚠️ Feature-rich but less battle-tested (16 dependents, beta) |
| `youtubei.js` (YouTube.js) | Pure JS, YouTube internal API | ✅ Excellent for metadata/search, fragile for download |
| `@distube/ytdl-core` | Pure JS download | ❌ **ARCHIVED Aug 2025**, abandoned |
| Custom `Bun.spawn` wrapper | Direct CLI | ✅ Most transparent; ~150 lines |

Pure-JS downloaders (youtubei.js, ytdl-core) break constantly because YouTube
changes its player/signature cipher. yt-dlp has a large community pushing fixes
within days. **Use yt-dlp as the download engine**; use `youtubei.js` only if we
later want a richer YouTube search/browse UI without an API key.

See `02-native-js-youtube-libraries.md`.

### Q3: Should we switch to a different backend stack (Python)?

**No. Stay on Bun + TypeScript.** See `03-backend-stack-comparison.md`.

The appeal of Python is that yt-dlp *is* Python — you'd `import yt_dlp` and get
clean `progress_hooks` callbacks instead of parsing stdout. But:

1. **It breaks the dispatch pattern.** Dispatch's whole value is shared typed
   contracts flowing `file:` from backend → frontend. A Python backend can't share
   TypeScript types without a codegen step we'd have to build and maintain.
2. **yt-dlp's standalone binary needs no Python at runtime.** The only Python
   touchpoint is the `youtube-dl-exec` postinstall check — skippable, or we manage
   the binary ourselves.
3. **Progress via stdout is a solved problem.** `--progress-template` emits clean
   JSON; parsing a line stream is trivial and maps perfectly onto the dispatch
   "pure reducer over an event stream" model.
4. **Single toolchain.** Biome, Vitest, `tsc -b`, `bun install` — one set of
   commands, one editor/LSP config, muscle memory from dispatch carries over.

A Python sidecar (hybrid) was considered and rejected as over-engineering for a
personal tool — it doubles the deploy surface for a marginal API-cleanliness gain.

## Recommended library stack

| Concern | Choice | Why |
|---|---|---|
| Download engine | `yt-dlp` binary | Reliability, huge community, multi-site |
| Wrapper | **our own** `Bun.spawn` wrapper (user decision) | No external dep; we own + understand it |
| Chapters | yt-dlp `--dump-json` → `chapters[]` field | Structured; see doc 06 |
| Non-music segments | SponsorBlock API (direct `fetch`) | `music_offtopic` etc.; see doc 07 |
| Cut & stitch | `ffmpeg` `-c copy` + concat demuxer | Lossless, no re-encode |
| Segment editing | pure reducers + thin Svelte component | Approach B; see doc 07 |
| Progress → frontend | WebSocket (dispatch surface pattern) | Already proven in dispatch |
| Initial tagging | yt-dlp `--embed-metadata --embed-thumbnail` | Free, correct, zero extra deps |
| Read metadata | `music-metadata` (1362 deps) | Supports every audio format |
| Write ID3 tags | `node-id3` (138 deps) | Pure JS, MP3 focus |
| Audio conversion | `ffmpeg` (already a yt-dlp dep) | FLAC/MP3/AAC transcode |
| Walkman target formats | FLAC (hi-res), MP3 (compat) | See `04-audio-tagging-and-formats.md` |

## How this fits the dispatch architecture

Dispatch's "pure core / injected shell" maps onto this project cleanly:

- **Pure core**: the download state machine (pending → downloading →
  fetching-info → editing → cutting → tagging → done/failed); progress reducer
  over yt-dlp event lines; `computeDefaultDraft` (sensible defaults from chapters
  + SB); the segment-edit reducers (title/art/trim/add/remove/merge); the
  `finalizeCutPlan` + `computeKeepRanges` cut-plan logic; `parseChapterTitle`;
  file-organization rules. Zero I/O. Fully unit-tested with no mocks.
- **Injected shell (effects at edges)**: the yt-dlp subprocess spawner, the
  SponsorBlock `fetch` client, the ffmpeg cut executor, the filesystem writer,
  the SQLite store (`bun:sqlite`), the WS transport.
- **No ambient state**: download jobs + cut drafts live in an explicit store, not
  module globals.
- **Typed contracts**: backend exports a `@yt-music/contract` package (Job,
  JobEvent, CutDraft, CutPlan, Chapter, SponsorSegment, ...) consumed by the
  frontend as a `file:` dep — exactly like dispatch's `@dispatch/wire`.
- **Thin components**: the Svelte segment editor wires props/events to pure
  reducers and renders; it holds no business logic (dispatch-web principle).

See `05-project-structure.md` for the full proposed layout.
