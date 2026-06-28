# yt-music-dl web — Agent Guide (root AGENTS.md)

> Loaded every session — the single source of truth for working in this repo.
> Non-obvious, project-specific rules only. Full design: `../.research/`.

## What this is

The **web frontend** for yt-music-dl — a SEPARATE repo from the backend
(`../yt-music-dl-backend`). It consumes the backend's typed contracts
(`@yt-music/contract`) over HTTP + WebSocket. Built with the backend's
methodology: pure core / inject effects / no ambient state / typed contracts.

## Stack

Bun + Vite + Svelte 5 (runes) + TypeScript (strict). Biome for lint/format
(tabs, double quotes, semicolons, width 100) — **biome covers `.ts`/`.js` ONLY;
`.svelte` correctness is `svelte-check`'s job.** TailwindCSS v4 + DaisyUI.

## Repo geography

```
src/app/        composition root (imports + wires feature modules)
src/core/       PURE: protocol, wire types, helpers
src/features/   <unit>/ (logic/ pure · ui/ svelte · adapter/ effects)
src/adapters/   injected browser effects: WS client, fetch
```

Backend (SEPARATE repo, contracts only): `../yt-music-dl-backend` — consume
`@yt-music/contract` (`file:` dep). Do NOT edit it.

## The non-negotiable rules

- **Pure core / injected shell.** Decision logic (reducers, view-models,
  cut-plan edit reducers) is pure `input → output`: zero DOM, zero `fetch`/WS,
  zero Svelte import. Effects (WebSocket, fetch) are INJECTED at the edges.
- **No ambient state.** State is owned per-unit and passed explicitly. No
  module-global mutable store reached from everywhere.
- **Components are thin.** A `.svelte` file wires props/events to pure logic and
  renders; it holds no business logic. The segment editor is a thin wrapper over
  pure reducers.
- **Contracts are the cross-unit surface.** Cross-unit deps go through a unit's
  public exports + `@yt-music/contract` — never another unit's internals.
- biome covers `.ts`/`.js`; `.svelte` correctness is `svelte-check`'s job.

## Backend seam (cross-repo)

The backend is `../yt-music-dl-backend` (separate repo; `lsp references` does NOT
span the boundary). You consume `@yt-music/contract` as a pinned `file:` dep.
- **Contract change (a shared type):** edit it in the backend's
  `packages/contract/src/index.ts`, run `lsp references` in the backend, and update
  every consumer yourself.
- **Backend contract change you can't make (you can't edit the backend repo):**
  REPORT IT UP via the living handoff `backend-handoff.md` (repo root, tracked):
  FE slice status, pinned contract versions, open asks / roadblocks for the
  backend, findings, and likely next asks. The user couriers it to the backend and
  brings the reply back. On the new version: re-pin the `file:` dep → update FE
  consumers. **NEVER edit the backend repo.**

Keep `backend-handoff.md` current at every milestone.

## Vocabulary

Shared backend terms are canonical — adopted VERBATIM from the backend's
`GLOSSARY.md` (job, job event, CutDraft, SegmentDraft, CutPlan, Chapter,
SponsorSegment, track, …). Never redefine a backend term. FE-specific terms (if
any arise) go in a web-repo `GLOSSARY.md` under "Frontend-specific". Before naming
anything new, check the backend glossary + existing code; ask the user before
coining a term.

## Tribal knowledge tracking

- `backend-handoff.md` (repo root, tracked) — the living handoff: FE slice status,
  pinned contract versions, open asks for the backend. Keep it current at every
  milestone.
- `reports/<name>.md` (gitignored) — optionally record a finished milestone: what
  you built, the public surface, verification output, contract gaps.
- `prompts/<unit>.md` (gitignored) — the task block for a summoned FE agent.

## Verification (run these yourself)

```
bun run typecheck   # svelte-check — 0 errors
bun run test        # vitest
bun run check       # biome (.ts/.js) — clean
bun run build       # vite build — succeeds
```

## Commands

- `bun run dev` — Vite dev server (port 24304). Full stack: backend `../bin/up`
  (HTTP :24303) + FE Vite :24304.
