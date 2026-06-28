# yt-music-dl backend — Constitution (root AGENTS.md)

> Loaded every session. Non-obvious, project-specific rules only. If a fresh
> frontier model could infer it from the code, it is NOT here (P6).
> Full design + rationale: `../.research/` (esp. 05-project-structure.md).

## What this project is

A backend for downloading YouTube audio, splitting album videos into songs via
chapters, removing non-music segments via SponsorBlock, tagging, and organizing
the collection for a Sony Walkman. It is a SEPARATE repo from the web frontend
(`../yt-music-dl-web`), which consumes this repo's typed contracts.

## Stack

Bun + TypeScript (strict, project references via `tsc -b`). Biome for
lint/format (tabs, double quotes, semicolons, width 100). Vitest for tests.
SQLite via `bun:sqlite`. The `yt-dlp` standalone binary for downloads (driven
via `Bun.spawn`, NOT a Python import — see `.research/01`).

## The non-negotiable architecture rules

- **Pure core / injected shell.** Decision logic (the download state machine,
  cut-plan computation, chapter-title parsing, keep-range math, the segment-edit
  reducers) is pure `input → output`: zero `node:fs`, zero `bun:sqlite`, zero
  `node:child_process`, zero network. I/O is passed in / injected at the edges.
- **Effects live at the edges, injected.** The yt-dlp spawner, the SponsorBlock
  `fetch`, the ffmpeg cutter, the filesystem writer, the SQLite store — all are
  injected effects behind typed interfaces. The pure core never imports a
  concrete effect.
- **No ambient/hidden state.** State is owned and passed explicitly. No stateful
  singletons. A job's state must be reproducible from its event log.
- **One owner per unit.** Each file/module has exactly ONE agent that edits it.
  To change another unit, report the needed change up — do not edit it.
- **Contracts are the only cross-unit surface.** `@yt-music/contract` (types
  only, zero runtime) is the single shared surface. Cross-package deps go
  through a package's public exports, never internals.
- **yt-dlp is a subprocess, not a library.** We spawn the standalone binary and
  parse `--progress-template` JSON lines. Never `import` a Python/yt-dlp module.
  The wrapper is OUR code (`packages/downloader`) — no external npm wrapper dep.

## Durability (never leave the system broken)

Persist incrementally + append-only. Recovery is a PURE `reconcile(events)` run
on load that repairs any partial job. Status is derived, never trusted from disk.

## Testing (asymmetric — strict core, lenient shell)

- **Pure core** (`job-store`, cut-plan, parsers): zero internal mocks. A test
  that mocks our own module is a DESIGN BUG — fix the code (inject the effect),
  not the test. Demand high coverage; it's cheap because the code is pure.
- **Imperative shell** (downloader spawner, cutter, transport): a few
  integration tests against real / in-memory backends. Don't chase pure-unit
  coverage here, and don't mock sibling packages.
- Mocking the OUTERMOST edge (real network/clock/subprocess) is fine; mocking
  `@yt-music/*` is a smell.

## Commands

- `bun run typecheck` — `tsc -b --pretty`
- `bun run test` — vitest
- `bun run check` — biome (lint + format)
- `bun run dev` — `bun --watch packages/host-bin/src/main.ts`

## System dependencies (NOT npm — install via pacman)

- `yt-dlp` — download engine. `sudo pacman -S yt-dlp`
- `ffmpeg` — audio extract/transcode/cut/concat. `sudo pacman -S ffmpeg`
- `flac` / `metaflac` (optional) — in-place FLAC tag edits. `sudo pacman -S flac`

The `bin/install-yt-dlp` script at the workspace root fetches the standalone
binary if you prefer not to use the system package.

## Vocabulary

Use the canonical terms in `GLOSSARY.md`. Never invent a synonym for an existing
concept. Prefer standard/training-baked names. Before naming anything new, check
`GLOSSARY.md` + existing code; if the concept exists under another name, use the
canonical one. New term? Ask the user before it lands in the glossary.

## Tribal knowledge tracking

The project's knowledge accumulates in these artifacts (see `../AGENTS.md` for the
full table). The key ones for THIS repo:

- `GLOSSARY.md` — canonical vocabulary (tracked).
- `ORCHESTRATOR.md` — the orchestrator's operating manual (tracked).
- `tasks.md` — live progress tracker: what's done, in-flight, blocked. Update at
  each milestone.
- `reports/<unit>.md` — what an agent built (gitignored; ephemeral operational
  artifact). Written by the summoned agent, read + verified by the orchestrator.
- `prompts/<unit>.md` — the task block for each summoned agent (gitignored).
- `notes/<topic>.md` — design docs + plans (tracked).

**Reports and prompts are gitignored** — they're ephemeral. The `AGENTS.md`,
`GLOSSARY.md`, and `ORCHESTRATOR.md` ARE the project knowledge and are tracked.

## Reports

When you finish a task, write a markdown report to `reports/<unit>.md`
(gitignored): what you built, the public surface, test/typecheck output, and any
contract gaps or change-requests.
