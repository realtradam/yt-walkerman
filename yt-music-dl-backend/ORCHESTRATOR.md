# ORCHESTRATOR.md — how to drive this project

> **You are the orchestrator.** You do NOT write feature code yourself. You plan,
> summon owner-agents (one per unit), verify their work, resolve errors, and keep
> the build green. This file is your complete operating manual. Read it fully
> before acting. Also read: `AGENTS.md` (the subagent constitution — you enforce
> it), `GLOSSARY.md`, and `../AGENTS.md` (the workspace orchestrator guide).
>
> This mirrors the `../dispatch/dispatch-backend/ORCHESTRATOR.md` in structure,
> adapted for yt-music-dl.

---

## 0. Mental model

This is a **pure core + injected effects** download/tag/organize tool. Every
feature is a package. The team structure is **isomorphic to the module
structure**: one owner-agent per unit, and agents communicate only through
**contracts** — exactly as the code does. Friction between agents (constant
messaging, needing to read another's implementation) is a **signal of a bad
contract boundary**, not normal.

The harness layers (copied from dispatch):
- **Constitution** (`AGENTS.md`) — loaded by every agent. Non-obvious, project-
  specific rules only. If a frontier model could infer it, it's NOT here (P6).
- **Glossary** (`GLOSSARY.md`) — one canonical name per concept.
- **This file** — the orchestrator's workflow.
- **Scoped knowledge** — rules are scoped to the *kind* of agent and the *layer*
  it works in (strict for pure-core, lenient for the shell). Key lesson:
  **scoped rules beat general rules; never write down what a frontier model
  already knows** (P6).

---

## 1. The golden workflow (build/modify a feature)

1. **Plan.** Decide the unit(s); split into dependency-topological **waves** of
   disjoint units. One agent owns one unit; it may ONLY edit its assigned files.
2. **Overlap check FIRST.** Before creating anything new, check `GLOSSARY.md` +
   existing code. If the request *describes* an existing concept under a new name,
   steer to the canonical term. New term? Propose the standard name and **ask the
   user** before adding it to the glossary. Never coin a term silently.
3. **Boundary decision is the USER's.** "New package vs. extend an existing one?"
   — surface it to the user; never decide granularity silently.
4. **Write the prompt** to `prompts/<unit>.md` (gitignored). See §3 for the recipe.
5. **Summon the wave** via the `dispatch` CLI (`umans/umans-glm-5.2`); disjoint
   units run in PARALLEL (§2a). Use `--file` to attach guardrails; **never inline**
   their contents into `--text` (the TOKEN RULE, §2).
6. **Verify** the reports + independently re-run checks (§4). Trust nothing until
   you've re-run `typecheck`/`test`/`check` yourself.
7. **Resolve** any contract gaps / errors (§5).
8. **Commit** the milestone with a clear message + test count. Update `tasks.md`.

---

## 2. Summoning agents via the `dispatch` CLI

The **`dispatch` CLI** is the summon mechanism; **`umans/umans-glm-5.2`** is the
BUILDING agent. The summoned agent is a SEPARATE conversation, NOT this session —
so set `--cwd` to the worktree root so its file tools operate there. It runs
`tsc -b`/vitest/biome via bash and writes its report to `reports/<unit>.md`.

**THE TOKEN RULE — use `--file` to attach guardrails; never inline into `--text`.**
The `--file <path>` flag reads a file from disk and attaches its contents to the
agent's message — the guardrail bytes land in the SUBAGENT's context, never the
orchestrator's. NEVER put `AGENTS.md` / `ORCHESTRATOR.md` / `prompts/<unit>.md`
contents into the `--text` — that duplicates what `--file` delivers AND burns YOUR
context. The `--text` is a SHORT instruction telling the agent what to DO
(implement, verify, report) — not what the rules SAY.

**Canonical summon** — ONE `dispatch` call per unit:

```bash
cd /home/tradam/projects/yt-music-dl/yt-music-dl-backend
dispatch umans/umans-glm-5.2 \
  --cwd /home/tradam/projects/yt-music-dl/yt-music-dl-backend \
  --text "You are the single owner-agent for packages/<unit>/. The attached files are your constitution + operating manual + task — follow them. Then IMPLEMENT the task now: edit ONLY files under packages/<unit>/, run tsc -b / vitest / biome for your package, and write your report to reports/<unit>.md. Reply with ONLY a one-line status + the path reports/<unit>.md — no diffs, no logs." \
  --file AGENTS.md \
  --file ORCHESTRATOR.md \
  --file prompts/<unit>.md \
  > reports/<unit>.run.log 2>&1
```

The `--file` list IS the fixed assembly order: constitution → operating manual →
TASK. The CLI delivers their contents to the agent directly — no read_file
round-trips needed.

**Output discipline — capture the stream, never display it.** The `dispatch`
summon STREAMS the agent's full response to stdout — enormous for a building task.
ALWAYS redirect to a log file (`> reports/<unit>.run.log 2>&1`) and do NOT `cat` it
back wholesale. Read the agent's `reports/<unit>.md` report instead. The
conversation ID prints at the end as `[conversation] <uuid>` — capture it so you
can `dispatch read <short-id>` later. Treat dumping a full run log into context as
a hard failure.

**Run discipline:**
- **Do NOT background it. Use a large timeout** (e.g. 1800000 ms = 30 min).
- One `run_shell` per summon (foreground, large timeout). For PARALLEL agents on
  disjoint files, launch multiple summons as CONCURRENT `run_shell` calls — but
  ONLY when their file sets do not overlap (single-writer rule, §6).

**GOTCHAS:**
- **Don't burn your own tokens.** Re-read THE TOKEN RULE above.
- **No sandbox = state the rules.** The subagent shares the repo cwd (via `--cwd`),
  nothing stops it editing out of its lane except the prompt. Always include the
  ownership rules (they tell the agent: never edit outside `packages/<unit>/`;
  read only OTHER units' contracts; if you must read another unit's impl, REPORT
  and STOP).
- **Make agents IMPLEMENT, not deliberate:** the `--text` says "IMPLEMENT the task
  now … write the report". A plan-only return → re-summon.

---

## 2a. Parallel execution — WAVES

Throughput comes from running disjoint units at once. Organise it as waves:
- **A wave = units that (a) touch DISJOINT files and (b) have no compile-time
  dependency on each other** (each imports only already-built packages + existing
  contracts). Launch a wave by emitting one `dispatch` summon per unit as
  CONCURRENT `run_shell` calls. Later waves depend on earlier ones; the
  composition root (`packages/host-bin/`) is almost always the LAST wave.
- **Pre-author the seam to widen the wave.** Because the orchestrator OWNS
  contracts, author the shared contract type in `packages/contract/src/index.ts`
  FIRST, then summon the producer AND the consumer in the SAME wave against that
  fixed type — neither needs the other's implementation. Authoring the contract
  up front is what turns a sequential producer→consumer chain into one parallel
  wave (and `lsp references` on the new symbol gives the exact consumer set).
- **One writer per file, always** — even across waves.
- **After a wave:** read every report, run the §4 checks ONCE for the whole wave,
  commit the milestone (update `tasks.md`), then start the next wave.

---

## 3. The per-summon `prompts/<unit>.md` is JUST the TASK block

The invariant guardrails — single-writer directory ownership, visibility, coupling,
the engineering standard, isolated verification, and the report format — live ONCE
in `AGENTS.md` (the constitution), attached via `--file`. So `prompts/<unit>.md`
contains ONLY the **TASK**:
1. **Your package:** `packages/<name>/` — name the WHAT.
2. **The job + algorithm**, naming the specific contract types involved.
3. **The specific contract file(s)** to read (e.g.
   `packages/contract/src/index.ts`) and any sibling public surfaces it consumes.
4. **The required test cases** (named).

Keep it scoped (P6): state only the project-specific, non-inferable task.

**Make agents IMPLEMENT, not deliberate.** A summoned owner must edit files + run
its checks + write its report in the one run. If a summon returns only a plan,
re-summon.

---

## 4. Verification (the orchestrator's trust protocol)

The orchestrator confirms work from **contracts + test results + build/diagnostics
output** — that is the designed trust mechanism, and it works because the
boundaries are testable. The tests-at-boundaries ARE how you trust a unit without
depending on its internals.

After each unit/wave:
```bash
bun run typecheck   # tsc -b --pretty — 0 errors
bun run test        # vitest — note the pass count
bun run check       # biome — clean
git status --short  # confirm only the intended files changed
```
Trust the green, not intent. If a check fails, read the report, fix or re-summon.

---

## 5. Resolving contract gaps / errors

- **Contract gap (a unit needs a field that doesn't exist):** the orchestrator
  OWNS contracts. Author the new field in `packages/contract/src/index.ts` first,
  then re-summon the consumer. The producer should already be coding against the
  contract, not the consumer's internals.
- **Cross-unit error:** report it up via `reports/<unit>.md` or the living
  handoff; the user couriers it.
- **`lsp references` does not span repos** (backend ↔ frontend). Cross-repo
  contract changes go through the living handoff `backend-handoff.md` (web repo
  root, tracked).

---

## 6. Visibility / ownership rules

- **One owner per unit.** Each file/module has exactly ONE agent that edits it.
  An agent may ONLY edit the files under its assigned `packages/<unit>/`.
- **Read contracts, not implementations.** An agent reads OTHER units' contracts
  (`packages/contract/src/index.ts` + a unit's public `index.ts` exports), never
  their internal implementation. If you think you must read another unit's impl to
  do your job, the contract is incomplete — REPORT and STOP.
- **Cross-package coupling is typed.** Imports go through a package's public
  exports (`index.ts`) + the shared `@yt-music/contract` types — never another
  package's internals. No string-keyed lookups.
- These rules are NOT enforced by a sandbox — they hold because the briefs state
  them. Always include the ownership rules in every summon.

---

## 7. Reports

When an agent finishes a task, it writes a markdown report to
`reports/<unit>.md` (gitignored):
- What it built (public surface).
- Test/typecheck/biome output (the actual command results, not a claim).
- Any contract gaps or change-requests for other units.
- The path to the report.

The orchestrator reads the report, independently re-runs checks (§4), and only then
commits.

---

## 8. System dependencies (the dispatch server)

The dispatch server must be running for all CLI commands. If `dispatch list`
fails, the server is down — boot it. Probe with `dispatch models`.

For yt-dlp and ffmpeg (the app's own system deps):
```bash
sudo pacman -S yt-dlp ffmpeg
```
