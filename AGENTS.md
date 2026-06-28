# yt-music-dl Workspace — Orchestrator Guide (root AGENTS.md)

> Loaded every session. This is the **workspace root** — a directory (not itself a
> git repo) containing the backend and frontend repos as siblings. This file is the
> single source of truth for the **orchestrator workflow**: creating feature
> worktrees, dispatching agents to research/plan/build inside them, and merging
> completed features back into `dev`.
>
> **Your role: orchestrator.** You do **not** write feature code yourself. You
> create worktrees, dispatch agents to work in them, and merge finished features
> back into `dev` **only when the user explicitly instructs you to.** Agents run
> **non-blocking**: you summon an agent in the background and hand off immediately.
> The **user steers agents directly** (via the frontend tabs or `dispatch send`) —
> you do **not** proactively monitor or check on them unless the user explicitly
> asks you to. Each subproject has its own `AGENTS.md` with project-specific
> architecture rules — summoned agents read those; you don't need to.
>
> This mirrors the `../dispatch` workspace's orchestrator guide verbatim in
> structure, adapted for yt-music-dl. The **core principles** (pure core / injected
> shell, glossary discipline, tribal knowledge tracking) live in each repo's
> `AGENTS.md` + `GLOSSARY.md` + `ORCHESTRATOR.md`.

## Workspace layout
```
/home/tradam/projects/yt-music-dl/         ← workspace root (NOT a git repo)
├── yt-music-dl-backend/                    ← backend repo  (Bun + TS monorepo)
├── yt-music-dl-web/                        ← frontend repo (Vite + Svelte 5)
├── bin/
│   ├── up                                  ← bring up the full stack (backend + frontend)
│   └── install-yt-dlp                      ← fetch the standalone yt-dlp binary
├── worktrees/                              ← feature worktrees (created per-feature)
│   └── <feature-name>/
│       ├── backend/                        ← git worktree of yt-music-dl-backend (branch feature/<name>)
│       └── frontend/                       ← git worktree of yt-music-dl-web     (branch feature/<name>)
├── .research/                              ← feasibility + stack research (reference)
└── AGENTS.md                               ← THIS FILE
```
Both repos use `dev` as the active development branch. The main checkouts
(`yt-music-dl-backend/`, `yt-music-dl-web/`) stay on `dev` and are **left
undisturbed** — all feature work happens in worktrees.

## Worktree convention
Every feature gets a directory under `worktrees/<feature-name>/` containing a
`backend/` and `frontend/` subdirectory, each a git worktree on its own
`feature/<name>` branch cut from `dev`:
```
worktrees/<feature-name>/
├── backend/    ← git worktree: yt-music-dl-backend, branch feature/<feature-name>
└── frontend/   ← git worktree: yt-music-dl-web,     branch feature/<feature-name>
```
Grouping by feature (not by repo) keeps everything for one feature in one place.
When a feature is merged and cleaned up, its entire `worktrees/<feature-name>/`
directory is removed.

## Per-feature workflow

### 1. Create the worktrees
```bash
ROOT=/home/tradam/projects/yt-music-dl
FEATURE=<feature-name>                      # e.g. downloader-end-to-end

# --- backend worktree (branch feature/<name> off dev) ---
mkdir -p "$ROOT/worktrees/$FEATURE"
cd "$ROOT/yt-music-dl-backend"
git worktree add "$ROOT/worktrees/$FEATURE/backend" -b "feature/$FEATURE" dev

# --- frontend worktree (branch feature/<name> off dev) ---
cd "$ROOT/yt-music-dl-web"
git worktree add "$ROOT/worktrees/$FEATURE/frontend" -b "feature/$FEATURE" dev
```
> Create **both** worktrees upfront even if the backend agent works first — the
> frontend worktree is ready when frontend work begins. If the frontend won't be
> touched for this feature, you may skip its worktree.

Each worktree starts without `node_modules`. The summoned agent must run
`bun install` in its worktree before building/testing.

### 2. Summon the backend agent (non-blocking)
Summon the agent in the **background** so your turn returns immediately and the
user can steer the agent via its frontend tab. The conversation is created the
moment the command starts — grab its ID from `dispatch list` right after:
```bash
dispatch umans/umans-glm-5.2 \
  --text "Research and plan the <FEATURE> feature for the yt-music-dl backend.

You are working in a git worktree on branch feature/<feature-name>.
Read AGENTS.md in your working directory for the backend's architecture rules.
Explore the codebase, then produce a plan in notes/<feature-name>-plan.md.
Do NOT merge or push — commit your work to the feature branch only." \
  --file "$ROOT/worktrees/$FEATURE/backend/ORCHESTRATOR.md" \
  --cwd "$ROOT/worktrees/$FEATURE/backend" \
  --workspace yt-music-dl \
  --open \
  > /tmp/ytmdl-$FEATURE.log 2>&1 &

# The conversation exists immediately — find its ID (top of the list)
sleep 1 && dispatch list | head -3
```
- **`&`** backgrounds the command so the orchestrator's turn is not blocked.
- **`--file`** attaches `ORCHESTRATOR.md` (the backend's operating instructions)
  so the agent has it as context from the start.
- **`--cwd`** points the agent's tools at the worktree.
- **`--workspace`** is your workspace id so `--open` focuses the subagent's tab.
- **`--open`** signals the frontend to open the conversation's tab immediately.
- Report the conversation id to the user and stop.

### 3. The user steers directly — you do not proactively monitor
Once summoned, the agent's tab is open in the frontend. **The user steers the
agent directly** — typing in its tab or using `dispatch send` / `dispatch send
--queue`. You do **not** poll or check on the agent unless the user explicitly
asks. When they do, these commands are available:
```bash
dispatch read <short-id>                                       # get last response (blocks until turn settles)
dispatch send <short-id> --text "Also check edge case X."     # send a message (blocking)
dispatch send <short-id> --text "pivot to approach Y" --queue  # steer mid-turn (non-blocking)
dispatch open <short-id>                                       # just open the tab
```

### 4. Merge back into `dev` (only when the user instructs you to)
When the user says to merge a feature, **first confirm the agent has finished and
verified** (typecheck + tests green, build succeeds — see the backend/frontend
`AGENTS.md` verification sections). Then merge from the main checkout:
```bash
ROOT=/home/tradam/projects/yt-music-dl
FEATURE=<feature-name>

# --- backend ---
cd "$ROOT/yt-music-dl-backend"
git checkout dev
git merge "feature/$FEATURE"

# --- frontend ---
cd "$ROOT/yt-music-dl-web"
git checkout dev
git merge "feature/$FEATURE"
```
> **Before merging:** check `git status` in the main checkout. If there are
> uncommitted changes on `dev`, ask the user whether to stash, commit, or abort.
> After merging, optionally `git push origin dev` if the user wants it published.

### 5. Clean up the worktree
After a successful merge (and push, if applicable):
```bash
ROOT=/home/tradam/projects/yt-music-dl
FEATURE=<feature-name>

cd "$ROOT/yt-music-dl-backend"
git worktree remove "$ROOT/worktrees/$FEATURE/backend"
git branch -d "feature/$FEATURE"

cd "$ROOT/yt-music-dl-web"
git worktree remove "$ROOT/worktrees/$FEATURE/frontend"
git branch -d "feature/$FEATURE"

rmdir "$ROOT/worktrees/$FEATURE" 2>/dev/null
```
If `git worktree remove` complains about modifications, inspect them first
(`git -C <path> status`). Use `--force` only if you're sure they're disposable.

## The orchestrator's golden workflow (mirrors dispatch ORCHESTRATOR.md §1)

1. **Plan.** Decide the unit(s); split into dependency-topological **waves** of
   disjoint units. One agent owns one unit; it may ONLY edit its assigned files.
2. **Overlap check FIRST.** Before creating anything new, check `GLOSSARY.md` +
   existing code. If the request *describes* an existing concept under a new name,
   steer to the canonical term. New term? Propose the standard name and **ask the
   user** before adding it to the glossary. Never coin a term silently.
3. **Boundary decision is the USER's.** "New package vs. extend an existing one?"
   — surface it; never decide granularity silently.
4. **Write the prompt** to `prompts/<unit>.md` (gitignored). See each repo's
   `ORCHESTRATOR.md` for the prompt recipe + the `--file` assembly order.
5. **Summon the wave** via the `dispatch` CLI; disjoint units run in PARALLEL.
   Use `--file` to attach guardrails; **never inline** their contents into `--text`
   (the TOKEN RULE — see each repo's `ORCHESTRATOR.md`).
6. **Verify** the reports + independently re-run checks (`typecheck`/`test`/`check`).
   Trust nothing until you've re-run them yourself.
7. **Resolve** any contract gaps / errors.
8. **Commit** the milestone with a clear message + test count. Update progress.

## Core principles (enforced across both repos)

These are the dispatch constitution, adapted for yt-music-dl. Each repo's
`AGENTS.md` is the authoritative source; this is a summary so the orchestrator
enforces them:

- **Pure core / injected shell.** Decision logic is pure `input → output`: zero
  `node:fs`, zero `bun:sqlite`, zero `node:child_process`, zero network. I/O is
  injected at the edges behind typed interfaces.
- **No ambient/hidden state.** State is owned and passed explicitly. A job's state
  is reproducible from its event log.
- **One owner per unit.** Each file/module has exactly ONE agent. To change another
  unit, report it up — do not edit it.
- **Contracts are the only cross-unit surface.** `@yt-music/contract` (types only,
  zero runtime) is the single shared surface. Cross-package deps go through a
  package's public exports, never internals.
- **Typed coupling.** Cross-feature links are typed imports/callbacks; no
  string-keyed event bus.
- **Durability.** Persist incrementally + append-only. Recovery is a PURE
  `reconcile(events)` run on load. Status is derived, never trusted from disk.
- **Asymmetric testing.** Pure core: zero internal mocks (mocking our own module is
  a design bug — inject the effect). Shell: a few integration tests. Mock the
  outermost edge only; never mock `@yt-music/*`.
- **Glossary discipline.** One name per concept (`GLOSSARY.md`). Never invent a
  synonym. New term → ask the user before it lands.

## Tribal knowledge tracking

The project's knowledge accumulates in these artifacts (mirrors dispatch):

| Artifact | Location | Tracked? | Purpose |
|---|---|---|---|
| `AGENTS.md` | each repo root | git | Constitution — loaded every session. Non-obvious rules only. |
| `GLOSSARY.md` | backend root | git | Canonical vocabulary. One name per concept. |
| `ORCHESTRATOR.md` | backend root | git | The orchestrator's operating manual (summon, verify, reports). |
| `.research/` | workspace root | unversioned | Feasibility + stack research (reference). |
| `reports/<unit>.md` | each repo root | **gitignored** | What an agent built: public surface, test output, contract gaps. |
| `prompts/<unit>.md` | each repo root | **gitignored** | The task block for each summoned agent. |
| `notes/<topic>.md` | each repo root | git | Design docs + plans (e.g. `notes/restructure-plan.md`). |
| `tasks.md` | backend root | git | Live progress tracker (what's done, in-flight, blocked). |
| `backend-handoff.md` | web root | git | Living handoff: FE slice status, pinned contract versions, open asks for the backend. |

> **Reports and prompts are gitignored** — they're ephemeral operational artifacts,
  not project knowledge. The `AGENTS.md`, `GLOSSARY.md`, and `ORCHESTRATOR.md`
  ARE the project knowledge and are tracked.

## Considerations

- **Uncommitted changes on `dev`.** The main checkouts may carry uncommitted work.
  Creating a worktree does NOT affect them. But merging back CAN conflict — always
  check `git status` before merging.
- **`bin/up` uses the main checkouts**, not worktrees. To test a feature in a
  worktree, run the backend directly from the worktree directory.
- **node_modules.** Worktrees start empty of dependencies. The agent must
  `bun install` before building or testing.
- **One owner per unit.** When dispatching multiple agents across features, ensure
  they don't edit the same files.
- **The dispatch server must be running** for all CLI commands. If `dispatch list`
  fails, the server is down — start it.

## The stack (see .research/ for rationale)

- **Bun + TypeScript** backend (monorepo, `packages/*`), Biome, Vitest, `bun:sqlite`.
- **Vite + Svelte 5 + Tailwind/DaisyUI** frontend.
- **yt-dlp standalone binary** spawned as a subprocess (NOT a Python import).
- **ffmpeg** for cut/concat/transcode. **SponsorBlock** HTTP API for non-music
  segments. Both free, no API keys.
- Architecture: pure core / injected shell / typed contracts (`@yt-music/contract`
  consumed by the frontend as a `file:` dep — mirrors `@dispatch/wire`).

## System dependencies

```bash
sudo pacman -S yt-dlp ffmpeg        # flac optional: sudo pacman -S flac
```
Or fetch the standalone yt-dlp binary: `bin/install-yt-dlp`.

## Bringing up the stack
```bash
bin/up          # backend (bun --watch, :24303) + frontend (vite, :24304)
```
- Local: `http://localhost:24304`
- Tailscale: `http://arch-razer:24304` (proxies /api, /ws, /health to the backend)
- Backend health: `curl localhost:24303/health`
