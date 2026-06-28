# backend-handoff.md — living handoff (frontend → backend)

> The frontend cannot edit the backend repo. This document is the courier
> channel: FE slice status, pinned contract versions, open asks / roadblocks for
> the backend, findings, and likely next asks. The user copies this to the backend
> agent and brings the reply back. Keep it current at every milestone.
>
> Mirrors `../dispatch/dispatch-web/backend-handoff.md`.

## FE slice status

- **download** (Phase 1): smoke-test App.svelte folds `JobEvent`s into view-state
  via `src/features/download/logic.ts` (pure reduce/reconcile/statusLabel). WS
  client injected from `src/adapters/ws.ts`. POST /api/jobs is called from the
  composition root. Phase 3 extended `DownloadState` with `draft: CutDraft |
  null` (captured from the `draft` job event) so the segment editor can consume
  it — the reducer still folds ALL job events; App.svelte routes none.
- **library** (Phase 2, done; Phase 5 rename/organize added): browse view at
  `src/features/library/`. Fetches `GET /api/library → { tracks: Track[] }` via
  the injected `src/adapters/libraryApi.ts` and renders
  #/title/artist/album/duration/format in a `LibraryView.svelte` table.
  View-model derived in pure `logic.ts` (formatDuration / trackNumberLabel /
  toTrackRow / toRows). **Phase 5** added inline rename (`PATCH /api/library/:id`)
  — an Edit action per row builds a pure `toUpdateRequest(original, form)` diff
  (only changed fields), applies it optimistically via `updateTrack`, then
  replaces the row with the backend's authoritative response (which has a NEW
  path-derived id) — plus an "Organize library" button (`POST
  /api/library/organize`) that bulk-moves every file to the current
  pathTemplate and replaces the whole list. The component now owns the raw
  `Track[]` and derives rows via `$derived(toRows(tracks))` so the rename diff
  has the original to compare against. Composed in App.svelte behind a
  Download/Library/Settings tab switcher; download feature left intact.
- **settings** (Phase 5, done): settings view at `src/features/settings/`.
  Loads `GET /api/settings` and saves `PUT /api/settings` via the injected
  `src/adapters/settings.ts` (`fetchSettings` / `saveSettings`). Pure `logic.ts`
  holds the pathTemplate token list (`PATH_TEMPLATE_TOKENS`), the backend's
  default template, format options, the `updateField` reducer (every field edit
  dispatches through it), `isDirty` (gates Save), and `previewPath` (a
  DISPLAY-ONLY render of the template against a sample track — token
  substitution + empty-defaults, NO sanitization, which is the backend's job).
  `SettingsView.svelte` is a thin form over outputDir (text) / format
  (mp3|flac select) / pathTemplate (text + variable helper + live preview); a
  "Saved ✓" badge flashes and clears on next edit. Composed in App.svelte as a
  third tab.
- **segment-editor** (Phase 4, done): cut-plan editor at
  `src/features/segment-editor/`. A `CutDraft` delivered by the backend `draft`
  job event is edited through a discriminated-union `EditAction` + pure
  `reduce(draft, action)` (`logic.ts`, zero I/O, unit-tested). The thin
  `SegmentEditor.svelte` is a fully controlled component: `draft` is a prop owned
  by App.svelte; every edit is dispatched via `onaction` (the root applies the
  reducer); confirm → `POST /api/jobs/:jobId/confirm` (`ConfirmDraftRequest`).
  New entity ids are minted in the shell (`crypto.randomUUID`) and carried in
  the action, keeping the reducer pure + deterministic. Composed in App.svelte:
  a Mode selector (`single` | `split-by-chapters`) + Format selector feeds the
  `CreateJobRequest`; the editor renders during the `editing` phase, then live
  cutting/done progress resumes.
  - **Phase 4 (SponsorBlock):** the backend's `draft` event now delivers
    `RemovedSegmentDraft`s carrying real `SponsorCategory` values (sponsor,
    selfpromo, interaction, intro, outro, music_offtopic, …) with
    `enabled: true`. The editor renders each skip on a **per-segment timeline
    bar** (positioned by the pure `removedRegions(seg) → TimelineRegion[]`
    helper — `leftPct`/`widthPct` clamped into the segment) plus a list row with
    a **category badge** (pure `categoryLabel(cat)` → "Sponsor"/"Intro"/
    "Non-music"/…), the label, and the time range. **Enabled skips are the
    "will be cut" regions**: red/dimmed on the bar + `text-error` "will cut"
    tag; disabled skips read muted/line-through. Clicking a bar region or the
    checkbox dispatches the pure `toggleRemovedSegment` reducer (existing).
    The `cutting` event's `segmentIndex`/`total` are NOT yet surfaced in the
    progress card (out of scope for the editor; see Open asks).
  - **Phase 7 (MusicBrainz):** the segment editor gained a **right-side
    metadata sidebar** + a **"Match album"** modal, wired to the backend's
    three new `/api/metadata/*` endpoints via an injected
    `src/adapters/metadataApi.ts` (`createMetadataApi`). Pure logic lives in a
    NEW `src/features/segment-editor/metadata.ts` (zero I/O, unit-tested:
    `metadata.test.ts`): a `reduceSearch` state machine (`idle → searching →
    results → error`), the `buildRecordingSearch`/`buildReleaseSearch` request
    builders, the `sidebarItems` view-model (the "Generated from YouTube"
    entry first, then MB result cards), `fillActions` (click-to-fill →
    `EditAction[]`), and `albumMatchActions` (whole-album fill → `EditAction[]`,
    skipping `none`-confidence matches). Three thin components: `MetadataSidebar`
    (per-segment lookup; recreates via `{#key segment.id}` so its search state
    resets per segment; a mount-only `$effect` runs the initial search with the
    prefilled query under `untrack` so in-progress field edits don't retrigger
    it), `MatchAlbumDialog` (search releases → pick one → GET release detail +
    POST match-album → per-segment confidence preview → Apply), and the existing
    `SegmentEditor` now has a per-segment "Lookup" button (selects a segment for
    the sidebar) + the "Match album" header button + a two-column grid layout
    (`lg:grid-cols-[1fr_20rem]`). Both click-to-fill and album-match flow
    through the existing `onaction` channel as a batch of `EditAction`s — no
    new callback prop. Loading states shown throughout (MB is rate-limited to
    ~1 req/sec server-side; each search may take ~1s).

## Pinned contract version

- `@yt-music/contract` → `file:../yt-music-dl-backend/packages/contract`
  (pinned to the backend's `contract` package source — types resolve from `src/`,
  no build needed for dev).
- Phase 3 consumed the existing contract types verbatim — `CutDraft`,
  `SegmentDraft`, `RemovedSegmentDraft`, `AlbumArtRef`, `ConfirmDraftRequest`,
  `CreateJobRequest`, `JobMode`, `AudioFormat`, and the `draft`/`cutting`/
  `done` `JobEvent` variants. No contract change was required.
- **Phase 4 likewise needed NO contract change** — `RemovedSegmentDraft`
  already carried `category: SponsorCategory | "manual"` + `label`, and
  `SponsorCategory` already enumerated the backend's categories. The FE only
  added display logic over the existing shape.
- **Phase 5 consumed the backend's new contract types verbatim** — `Settings`,
  `SaveSettingsRequest`, `UpdateTrackRequest`, `UpdateTrackResponse`,
  `OrganizeResponse`, and the new optional `Track.track` field. No FE-side
  contract change was required (the `file:` dep resolves the backend's latest
  `src/` directly, commit 5e7d8b9).
- **Phase 7 consumed the backend's new MusicBrainz contract types verbatim**
  (backend commit `113517a`) — `MetadataSearchRequest`, `MetadataResult`,
  `ReleaseTrack`, `ReleaseDetail`, `AlbumMatch`, `AlbumMatchResult`,
  `MatchAlbumRequest`. No FE-side contract change was required; the `file:`
  dep resolved the backend's latest `src/` directly. The FE consumed the three
  `/api/metadata/*` endpoints (search, release/:mbid, match-album) as
  specified, including the 502 `{ error }` error envelope (read by
  `metadataApi.ts`).

## Open asks for the backend

- **Album art upload** (`AlbumArtRef { kind: "uploaded"; uploadId: string }`):
  the editor accepts an `uploadId` as a manual text field, but there is no FE
  upload path yet. We need an upload endpoint (e.g. `POST /api/art` →
  `{ uploadId }`) + an injected adapter before the UI can offer a real file
  picker. Until then `kind: "uploaded"` is only manually settable.
- The `cutting` event carries `segmentIndex` + `total`; the FE progress card
  currently shows only `pct`. If you'd like "Cutting segment 2/5…" shown, no
  contract change is needed — we'd just surface the existing fields (pure
  reducer change on the FE side). No action needed from the backend.

## Findings

- The Vite dev server proxies `/api`, `/ws`, `/health` to the backend on
  `127.0.0.1:24303`, so the FE uses relative URLs only (no CORS, no mixed-content).
- `__APP_VERSION__` is baked at build time from the git short hash (see
  `vite.config.ts`).
- `formatDuration` (pure, in `src/features/library/logic.ts`) is reused by the
  segment editor via its public export (`segment-editor/logic.ts` imports it).
  AGENTS.md permits cross-unit deps through public exports. If preferred, it
  could be promoted to `src/core/format.ts` so neither feature depends on the
  other — trivial follow-up, no contract impact.
- New-segment/new-skip ids are generated in the Svelte shell
  (`crypto.randomUUID()` with a `Date.now`+`Math.random` fallback) and passed
  into the pure reducer via the action. This keeps the reducer deterministic and
  unit-testable with zero mocks.
- **Phase 4:** the SponsorBlock category→display split follows the pure-core /
  thin-component rule: `categoryLabel(cat)` (a friendly string) and
  `removedRegions(seg)` (positioned `TimelineRegion[]`) are PURE view-model
  helpers in `logic.ts` (unit-tested); the category→daisyUI-tone mapping
  (`categoryTone`) is a COMPONENT-local helper because it returns CSS classes
  (a presentation concern — pure core must stay DOM/CSS-free). The existing
  `toggleRemovedSegment`/`addRemovedSegment`/`removeRemovedSegment` reducers
  already carried `category` through unchanged (spread `...r`), so no reducer
  change was needed — only tests were added to lock in that a toggle preserves
  the SponsorBlock `category`.
- **Phase 5:** the rename `UpdateTrackRequest.track?` is "only provided fields
  change" — so an empty track input is OMITTED (leaves the tag unchanged), not
  cleared. There is currently no FE way to CLEAR an existing track number
  (sending `track: undefined` is dropped by JSON). If clearing is wanted, the
  backend would need a sentinel (e.g. `track: null`) — noted as a possible
  follow-up ask. The PATCH URL `encodeURIComponent`s the id defensively (the id
  is path-derived and could in principle contain URL-unsafe chars). The settings
  `previewPath` is display-only (no sanitization) — the real file lands wherever
  the backend puts it.
- **Phase 7:** all metadata decision logic is pure (`metadata.ts`, 34 unit tests
  with zero mocks): the search state machine, request builders, the sidebar
  view-model, click-to-fill, and album-match→`EditAction[]`. The only side-effect
  is the injected `metadataApi` (`fetch`), exactly mirroring the library/settings
  adapter seam. The "Generated from YouTube" sidebar entry uses the segment's
  CURRENT parsed title/artist/album as-is (no MB lookup) — clicking it leaves
  the segment fields UNCHANGED (a no-op: `fillActions` returns `[]` for the
  `youtube` source). This is the spec-permitted "leaves the segment fields
  unchanged" branch; we do NOT snapshot a separate "original YouTube" baseline,
  so a true revert-after-MB-edit is not supported (a possible follow-up). MB
  recording search results omit `trackNumber` (per the backend), so click-to-fill
  only sets `trackNumber` when the result actually carries it; album-match always
  sets it (from the release detail's global track positions). `exactOptionalPropertyTypes`
  is on, so optional fields (`artist`, `album`, `trackNumber`, `error`) are
  conditionally INCLUDED rather than set to `undefined` — the reducer omits the
  key entirely. The sidebar recreates via `{#key segment.id}` on segment switch
  (resetting search state + cancelling the in-flight request via the mount
  effect's cleanup), and its mount search reads props under `untrack` so editing
  a segment's title in the main editor doesn't re-fire the search. The sidebar
  initialises its search `$state` to "searching" directly (not inside the effect)
  so the mount `$effect` never reads `searchState` synchronously — otherwise its
  own async result writes would re-trigger it into an infinite search loop (a
  Svelte-5 `$effect` tracks synchronous reads, including the RHS of
  `searchState = reduceSearch(searchState, …)`). Match-album sends the CURRENT draft to the backend; because the dialog is modal (no edits
  occur mid-dialog), the backend's `segmentIndex` references stay aligned with
  the draft the FE applies against.

## Likely next asks

- The album-art upload endpoint (see "Open asks") — needed for the `uploaded`
  album-art branch to be usable end-to-end.
- Confirmation of the `cutting`/`done` event shapes once the real ffmpeg cut
  flow runs end-to-end (currently matched to the contract as written).
