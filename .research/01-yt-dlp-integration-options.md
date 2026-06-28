# 01 — yt-dlp Integration Options (the core "bindings" question)

> Question: *Should we create bindings to hook into existing programs like yt-dlp?*

## Background: what yt-dlp is

`yt-dlp` is a Python project (a fork of youtube-dl) but it ships **standalone
binaries** for every platform — a single self-contained executable with no Python
runtime requirement. This is the key fact that shapes the integration decision:
**you do not need Python in your stack to use yt-dlp.**

It supports 1000+ sites, is updated frequently (often weekly) to counter YouTube's
anti-scraping changes, and has a large active community.

## Option A — Native/FFI bindings (REJECTED)

One could imagine building native Node addons (N-API) or Python C-extensions that
call into yt-dlp's internals. **Don't.** yt-dlp's internals are pure Python and
change constantly. There are no C-level entry points to bind to. You'd be wrapping
Python module imports, which is just subprocess-with-extra-steps. No such library
exists or is maintained. **Rejected.**

## Option B — Shell out to the yt-dlp binary (RECOMMENDED)

Spawn the `yt-dlp` executable as a child process and parse its output. yt-dlp is
designed for this — it has structured output modes:

### Progress output: `--progress-template`
yt-dlp can emit **JSON progress objects** line-by-line on stdout:

```
yt-dlp --progress-template '{"pct": "%(progress._percent_str)s", "speed": "%(progress._speed_str)s", "eta": "%(progress._eta_str)s", "downloaded": "%(progress.downloaded_bytes)s", "total": "%(progress.total_bytes)s"}' URL
```

Each line is a complete JSON object — trivial to parse with `JSON.parse` per line
in a streaming reader. This gives us everything dispatch's progress tracking
needs: percentage, speed, ETA, byte counts.

### Metadata without downloading: `--dump-json` / `--print`
```
yt-dlp --dump-json URL            → full info dict as one JSON line
yt-dlp --print "%(title)s" URL    → just a field
yt-dlp -J URL                     → alias for --dump-json
```

The info dict includes: `title`, `uploader`, `duration`, `upload_date`,
`thumbnail`, `track`, `artist`, `album`, `playlist`, `formats[]`, etc. This is
the metadata we tag the audio file with.

### Embedding metadata + thumbnail on download
```
yt-dlp -x --audio-format flac \
  --embed-metadata --embed-thumbnail \
  --parse-metadata "%(title)s:%(track)s" \
  URL
```
yt-dlp does the tagging as a **post-processor** — no separate tagging step needed
for the initial download. (We still want `node-id3` for later user edits — see
`04-audio-tagging-and-formats.md`.)

### Cancellation
`subprocess.kill()` (Node `child_process`) or `proc.kill()` (Bun) cancels cleanly.
yt-dlp handles SIGTERM and leaves `.part` files that it can resume.

### Implementation: two sub-choices

#### B1 — Use `youtube-dl-exec` (npm package)
- **`youtube-dl-exec`** v3.1.8 (published 6 days ago as of research), 91 dependents,
  126 versions, maintained by microlink.io. MIT.
- Auto-downloads + auto-updates the yt-dlp binary on `npm install` (postinstall).
- Exposes `youtubedl.exec(url, flags)` → returns the **subprocess** so you can pipe
  stdout/stderr for progress and call `.kill()`.
- Also a simpler `youtubedl(url, flags)` → returns parsed output (for `--dump-json`).
- Flags are passed as camelCase JS objects: `{ dumpSingleJson: true, ... }`.
- **Caveat**: the postinstall script checks for `python3` on the system. Set
  `YOUTUBE_DL_SKIP_PYTHON_CHECK=true` to skip, or just manage the binary manually.
- Works under Bun.

#### B2 — Custom `Bun.spawn` wrapper (~150 lines) ✅ CHOSEN
- Full transparency, zero dependencies, total control over arg building.
- We manage the binary ourselves: download from GitHub releases, pin a version,
  store in a known path. A `bin/install-yt-dlp` script (mirrors dispatch's
  `bin/` convention).
- Best fit with dispatch's "no hidden dependencies, effects are explicit" ethos.
- More code to write but it's simple and we own it.

**Decision (user-confirmed)**: Build **B2** — our own wrapper. Rationale: no
external dependency to maintain, we build it right, we understand it fully so
maintenance and updates are easy. yt-dlp's CLI is stable and well-documented;
a thin typed wrapper over `Bun.spawn` + `--progress-template` is straightforward.
The wrapper interface is defined as a **typed contract** (`Downloader`) so the
implementation is swappable and testable. Binary management via a
`bin/install-yt-dlp` script that fetches the standalone binary from GitHub
releases — no Python involved at any point.

## Option C — Python `import yt_dlp` (requires Python backend — see doc 03)

If the backend were Python, you'd do:
```python
import yt_dlp

def hook(d):
    if d['status'] == 'downloading':
        emit_progress(d['_percent_str'], d['_speed_str'], d['_eta_str'])

with yt_dlp.YoutubeDL({
    'progress_hooks': [hook],
    'format': 'bestaudio/best',
    'postprocessors': [
        {'key': 'FFmpegExtractAudio', 'preferredcodec': 'flac'},
        {'key': 'EmbedThumbnail'},
        {'key': 'FFmpegMetadata'},
    ],
}) as ydl:
    info = ydl.extract_info(url)
```

This is the cleanest API — `progress_hooks` gives direct callback objects instead
of stdout lines. **But it forces a Python backend**, which we reject for the
reasons in `03-backend-stack-comparison.md`. Noted for completeness.

## Concrete recommendation

```
┌─────────────────────────────────────────────────────┐
│  yt-dlp binary  ←──spawn──  downloader package     │
│  (standalone)                 (Bun.spawn wrapper)   │
│       ↑                              │              │
│       │                              ▼              │
│   --progress-template  ──►  parse JSON lines        │
│   --dump-json                (pure reducer)          │
│   --embed-metadata                  │                │
│                                    ▼                │
│                          push to WebSocket ──► SPA   │
└─────────────────────────────────────────────────────┘
```

- Define a `Downloader` interface (contract): `start(url, opts) → AsyncIterable<DownloadEvent>`,
  `cancel(jobId)`, `getInfo(url) → VideoInfo`.
- Implement it with `youtube-dl-exec` (or custom spawn) behind that interface.
- `DownloadEvent` is a discriminated union: `{ type: "progress", ... } | { type: "info", ... } | { type: "done", path } | { type: "error", message }`.
- The reducer that folds `DownloadEvent[] → JobState` is **pure** — fully unit
  tested with no mocks (dispatch testing principle).
