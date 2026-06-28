# Glossary — canonical vocabulary (yt-music-dl-web)

> One name per concept. Shared backend terms are adopted VERBATIM (no drift).
> New term? The orchestrator proposes the standard name and the user confirms
> before it lands. "Aliases to avoid" maps wrong names back to the canonical.

## Shared with the backend (canonical — do NOT redefine)

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **job** | One download request: a URL → one or more audio files. Identified by `JobId`. Has a status lifecycle and an append-only event log. | task, download |
| **job event** | One entry in a job's append-only event log (`JobEvent`): info, draft, progress, cutting, done, error. | log entry |
| **JobStatus** | The lifecycle state of a job, DERIVED from events: `pending → fetching-info → editing → downloading → cutting → tagging → done \| failed \| cancelled`. | state |
| **VideoInfo** | The metadata the backend extracts: title, uploader, duration, thumbnail, chapters. | metadata |
| **chapter** | A YouTube chapter marker: `{ title, startTime, endTime }`. For album videos, each chapter = one song. | section, timestamp |
| **CutDraft** | The editable cut-plan document the frontend manipulates: a list of `SegmentDraft`s + global album/artist/art. Computed as "sensible defaults" by the backend, then user-edited here. | edit plan, cut list |
| **SegmentDraft** | One editable song in the `CutDraft`: title, artist, album, trackNumber, albumArt, time range, and toggleable removedSegments. | track, item |
| **RemovedSegmentDraft** | A segment to cut out from within a song (SponsorBlock or manual), toggleable via `enabled`. | skip, cut point |
| **CutPlan** | The finalized, validated plan the backend executes with ffmpeg. Derived from the confirmed `CutDraft`. | final plan |
| **SponsorSegment** | A non-music segment from the SponsorBlock API. | skip segment |
| **track** | A library entry: a tagged audio file in the output collection. | song (when meaning the entry), file |
| **AlbumArtRef** | A reference to album art: `video-thumbnail`, `url`, or `uploaded`. | cover art |

## Frontend-specific

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **feature module** | A self-contained FE feature (download, segment-editor, library, …); feature-as-a-library, composed at the root. | — |
| **composition root** | The single place (`src/app/`) that imports + wires feature modules. | — |
| **segment editor** | The FE feature module (`src/features/segment-editor/`) that renders the `CutDraft` timeline and applies the pure edit reducers. The thin Svelte component over pure logic. | cut editor, plan editor |
| **edit reducer** | A pure function `(draft, action) → draft` that mutates the `CutDraft` (editSegmentTitle, addSegment, splitSegment, mergeSegments, toggleRemovedSegment, …). Tested with zero mocks. | — |
| **WS client** | The injected browser effect (`src/adapters/`) that connects to the backend WebSocket and yields `JobEvent`s. | socket |
| **handoff** | `backend-handoff.md` (repo root, tracked): the living document of FE slice status, pinned contract versions, open asks for the backend. The user couriers it between repos. | handoff doc |

## Known vocabulary drift

- _None yet._ When a term drifts (a synonym sneaks in), record it here with the
  fix so it's never reintroduced.
