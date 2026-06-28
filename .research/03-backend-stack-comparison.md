# 03 — Backend Stack Comparison: Python vs Bun/TypeScript vs Hybrid

> Question: *Should we switch to a different backend stack?*

## Verdict: Stay on Bun + TypeScript (the dispatch stack).

The only serious argument for switching is that yt-dlp is written in Python and
offers a cleaner in-process API. That argument does **not** outweigh the cost of
abandoning the shared-language, shared-contract, shared-toolchain architecture
that is the entire point of mirroring dispatch.

## Detailed comparison

### Option 1: Bun + TypeScript, shell out to yt-dlp binary ✅ RECOMMENDED

**Stack**: Bun, TypeScript (strict), Biome, Vitest, `bun:sqlite`. Identical to
`dispatch-backend`. Drive yt-dlp via `youtube-dl-exec` or a custom `Bun.spawn`
wrapper (see doc 01).

| Pros | Cons |
|---|---|
| Mirrors dispatch exactly — shared Biome/Vitest/tsc config, muscle memory | Progress comes from parsing stdout JSON lines (trivial, see doc 01) |
| Shared TypeScript contracts flow `file:` backend → frontend (dispatch's core value) | Must manage/symlink the yt-dlp binary (youtube-dl-exec handles this) |
| One language, one LSP, one formatter across both repos | — |
| Bun is very fast; `bun:sqlite` is built in | — |
| yt-dlp standalone binary needs **no Python at runtime** | — |
| Async streaming (`AsyncIterable<DownloadEvent>`) fits the pure-reducer model | — |
| Pure download state-machine is unit-testable with zero mocks | — |

### Option 2: Python (FastAPI + `import yt_dlp`) ❌ REJECTED

**Stack**: FastAPI, yt-dlp as a library, SQLite, Pydantic. Frontend still
Svelte/TS.

| Pros | Cons |
|---|---|
| `progress_hooks` gives clean in-process callbacks (no stdout parsing) | **Breaks the dispatch contract model** — can't share TS types with the Svelte frontend without a codegen step (we'd have to build + maintain a JSON Schema → TS pipeline) |
| yt-dlp is native — no subprocess, no binary management | Second language + toolchain (pip, venv, ruff/mypy, pytest) to learn/maintain |
| Pydantic models are nice | No `bun:sqlite` equivalent built-in; more setup |
| | Dispatch's `file:` contract dep pattern (`"@dispatch/wire": "file:../backend/packages/wire"`) is impossible — Python packages can't be consumed by npm |
| | Two deploy artifacts (Python server + static frontend) instead of one ecosystem |
| | The user's environment/muscle-memory is dispatch (Bun). Context-switching cost. |

**The contract problem is decisive.** Dispatch's frontend consumes the backend's
typed contracts as pinned `file:` deps:
```json
"@dispatch/wire": "file:../dispatch-backend/packages/wire"
```
This is what makes `lsp references` and type-safe API calls work across the repo
boundary. A Python backend cannot provide this. We'd either duplicate types
manually (drift risk) or build a codegen pipeline (maintenance burden) — both
defeat the purpose of mirroring dispatch.

### Option 3: Hybrid (Bun backend + Python sidecar) ❌ REJECTED

Bun backend handles API/WS/DB/contracts; a tiny Python service (or even a
stdin/stdout pipe) runs yt-dlp as a library for the "clean progress_hooks" win.

| Pros | Cons |
|---|---|
| Best of both: clean Python progress hooks + TS contracts | **Over-engineered for a personal tool.** Two processes, IPC protocol, two dep trees, two deploy targets. |
| | The "win" (stdout parsing vs callbacks) is ~20 lines of code difference. Not worth a second runtime. |
| | Debugging across the process boundary is harder. |

### What about the `youtube-dl-exec` Python postinstall check?

`youtube-dl-exec`'s postinstall script checks for `python3` to run its install
logic. This is the *only* Python touchpoint in the recommended stack, and it's:
- Build-time only (postinstall), not runtime.
- Skippable: `YOUTUBE_DL_SKIP_PYTHON_CHECK=true npm install`.
- Or avoid entirely: use a custom `Bun.spawn` wrapper and manage the binary via a
  `bin/install-yt-dlp` script (download the standalone binary from GitHub releases).

So even this doesn't justify a Python backend.

## When you *would* reconsider Python

- If this were a high-throughput multi-user service (yt-dlp's GIL / threading
  matters under concurrency) — it's not, it's a personal Walkman music tool.
- If we needed yt-dlp's Python-only features (custom extractors, plugin
  development in Python) — we don't.
- If the stdout progress parsing proved flaky in practice — it won't;
  `--progress-template` is stable, documented output.

## Recommendation

**Option 1.** Build the backend in Bun + TypeScript, identical stack to
`dispatch-backend`. Wrap yt-dlp behind a typed `Downloader` contract. The
~20 lines of stdout-JSON-line parsing is a small price for keeping the entire
dispatch methodology intact: shared contracts, shared toolchain, pure-core
testability, `file:` dep wiring.
