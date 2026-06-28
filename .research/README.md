# .research/ — yt-music-dl feasibility & stack research

Research conducted 2026-06-25 to decide the architecture for downloading, tagging,
and organizing YouTube audio for a Sony Walkman, mirroring the `../dispatch`
two-repo workspace.

## Documents

| # | Document | Question answered |
|---|---|---|
| 00 | [summary-and-recommendation](00-summary-and-recommendation.md) | The executive summary + recommendation |
| 01 | [yt-dlp-integration-options](01-yt-dlp-integration-options.md) | Should we create bindings to hook into yt-dlp? → own `Bun.spawn` wrapper |
| 02 | [native-js-youtube-libraries](02-native-js-youtube-libraries.md) | Are there good JS libraries we could use? |
| 03 | [backend-stack-comparison](03-backend-stack-comparison.md) | Should we switch to a different backend stack (Python)? |
| 04 | [audio-tagging-and-formats](04-audio-tagging-and-formats.md) | Tagging libraries, Walkman formats, ffmpeg |
| 05 | [project-structure](05-project-structure.md) | Proposed layout mirroring dispatch (2 repos) |
| 06 | [youtube-chapters-splitting](06-youtube-chapters-splitting.md) | Album video splitting via YouTube chapters |
| 07 | [sponsorblock-and-ffmpeg](07-sponsorblock-and-ffmpeg.md) | SponsorBlock API + ffmpeg cut/stitch + segment editor (Approach B) |

## Bottom line

- **Stack**: Bun + TypeScript backend + Vite/Svelte frontend (same as dispatch).
- **Download**: yt-dlp standalone binary, wrapped in our **own** TS package
  (user decision — no external dep), driven via `--progress-template` JSON lines
  → WebSocket → frontend.
- **Do NOT** switch to Python — it breaks the shared-contract model that is the
  entire point of mirroring dispatch. yt-dlp's binary needs no Python at runtime.
- **Album splitting**: yt-dlp's `--dump-json` includes a `chapters[]` field;
  the backend extracts it and the frontend shows a reviewable timeline editor
  with sensible defaults before cutting.
- **SponsorBlock**: direct API (`GET /api/skipSegments`) fetches non-music
  segments; we fetch them ourselves (not yt-dlp's `--sponsorblock-remove`) so the
  user can preview/toggle keep/remove. ffmpeg cuts + stitches with lossless
  stream copy (`-c copy` + concat demuxer).
- **Segment editor (Approach B)**: frontend controls each segment — title, album
  art, add/remove/split/merge, trim, toggle SB. Defaults + edit reducers +
  finalization are pure functions; the Svelte editor is a thin component over them.
- **Tagging**: yt-dlp `--embed-metadata --embed-thumbnail` on download;
  `node-id3` (write) + `music-metadata` (read) + ffmpeg for per-segment art.
- **System deps to install**: `yt-dlp`, `ffmpeg` (and optionally `flac`).
