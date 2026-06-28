# 07 — SponsorBlock + ffmpeg (Cut & Stitch Non-Music Segments)

> Feature: use SponsorBlock's timestamps to identify non-music parts (intro
> chatter, sponsorship, outros) and cut/stitch the audio to keep only the music.

## SponsorBlock — what it is and what it gives us

SponsorBlock is a crowdsourced database + API marking non-content segments in
YouTube videos. Users submit start/end times for segments; the community votes on
accuracy. The public API is free, unlimited, no API key, at `https://sponsor.ajay.app`.

### The API we need: `GET /api/skipSegments`

**Simplest form (by video ID):**
```
GET https://sponsor.ajay.app/api/skipSegments?videoID=dQw4w9WgXcQ&categories=["sponsor","intro","outro","selfpromo","music_offtopic"]
```

**Response** (200, array):
```jsonc
[
  {
    "segment": [0.0, 15.23],     // [startTime, endTime] in SECONDS (float)
    "UUID": "abc123...",
    "category": "intro",
    "videoDuration": 212.5
  },
  {
    "segment": [200.0, 210.0],
    "UUID": "def456...",
    "category": "music_offtopic",
    "videoDuration": 212.5
  }
]
```

**Privacy-preserving form (by hash prefix):**
```
GET https://sponsor.ajay.app/api/skipSegments/{sha256HashPrefix}?categories=[...]
```
where the prefix is the first 4 chars of `sha256(videoID)`. Returns multiple
videos' segments; we filter by `videoID`. Recommended by the docs so the server
doesn't know exactly which video you queried. Trivial to implement:
```ts
const prefix = sha256(videoId).slice(0, 4);
```

**Error codes**: 400 (bad input), 404 (no segments for this video / category).
A 404 is *normal* — many videos have no SponsorBlock submissions. Handle gracefully.

### Categories (from SponsorBlock Types wiki + yt-dlp)

| Category | Meaning | Use for music? |
|---|---|---|
| `sponsor` | paid promotion / sponsorship | ✅ remove |
| `selfpromo` | creator's own promo (merch, Patreon) | ✅ remove |
| `interaction` | "like and subscribe" reminders | ✅ remove |
| `intro` | animation/intro before content | ✅ remove |
| `outro` | credits/end cards | ✅ remove |
| `preview` | recap/preview of other videos | ✅ remove |
| `filler` | tangential fluff (off-topic, not sponsor) | ⚠️ aggressive — optional |
| `music_offtopic` | **non-music sections in music videos** | ✅✅ THE key one |
| `poi_highlight` | point of interest (single timestamp, not a range) | ❌ not a range |
| `chapter` | chapter marker | ❌ handled via yt-dlp chapters (doc 06) |

For a **music** app, the defaults: remove `sponsor`, `selfpromo`, `interaction`,
`intro`, `outro`, `music_offtopic`. Leave `filler` off by default (aggressive) but
expose as a toggle. `poi_highlight` is a point, not a range — ignore it.

### There's an NPM wrapper (optional)

`sponsorblock-api` on npm. But the API is one GET that returns JSON — a
~20-line `fetch` wrapper is cleaner and dependency-free (matches our "build our
own wrapper" decision for yt-dlp). Recommended: roll our own thin client.

### yt-dlp ALSO has built-in SponsorBlock (important context)

yt-dlp can remove/mark sponsor segments natively:
```bash
# Remove sponsor segments during download
yt-dlp --sponsorblock-remove sponsor,intro,outro,selfpromo,music_offtopic URL

# Mark them as chapters instead (keep the content, just label it)
yt-dlp --sponsorblock-mark all URL

# Custom chapter title for marked segments
yt-dlp --sponsorblock-mark all --sponsorblock-chapter-title "Sponsor" URL
```

**Why we don't just use `--sponsorblock-remove`:** same reasoning as chapter
splitting (doc 06). It's a black box — the user can't preview what gets cut, can't
adjust boundaries, can't see the sponsor segments on a timeline before
committing. We want the **review-then-cut** UX. So we:
1. Fetch SponsorBlock segments ourselves (direct API) → for the preview UI.
2. Fetch chapters via yt-dlp `--dump-json` → for the preview UI.
3. Let the user review/edit the cut plan.
4. Download the **raw, uncut** audio (NO `--sponsorblock-remove`).
5. Execute the cut+stitch with ffmpeg ourselves.

This gives full transparency and control, and the cut-plan computation is pure
testable logic.

## ffmpeg: cutting and stitching

### The cut operation (extract one song = a time range)

```bash
# Stream copy (fast, lossless, no re-encode) — works if cut points align to frames
ffmpeg -ss 187.42 -to 412.8 -i input.flac -c copy song_2.flac
```
- `-ss` before `-i` = seek (fast, seeks to nearest keyframe).
- `-to` = end time.
- `-c copy` = no re-encode (lossless, instant).
- **Caveat**: with `-c copy`, the cut may not be sample-accurate (snaps to
  keyframes). For audio this is usually inaudible, but for precise cuts use
  `--force-keyframes-at-cuts` semantics → re-encode (`-c:a flac` or the target
  codec). For FLAC source, re-encoding to FLAC is lossless anyway.

### The stitch operation (remove a segment from WITHIN a song)

When a SponsorBlock segment (e.g., a mid-song talking break) falls *inside* a
chapter's range, we need to cut it out and join the two halves. Two approaches:

#### Approach 1: concat demuxer (fast, lossless with `-c copy`)
Create a concat list file `list.txt`:
```
file 'part1.flac'
file 'part2.flac'
```
Then:
```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy song_stitched.flac
```
Requires the parts to have the same codec/params (they will — same source file).
`-c copy` = no re-encode.

#### Approach 2: single ffmpeg command with multiple -ss/-to segments + filter
For a song from `start..end` with a removed segment at `r1..r2` (where
`start < r1 < r2 < end`):
```bash
ffmpeg -i input.flac \
  -ss 0 -to r1 -c copy part1.flac \
  -ss r2 -to end -c copy part2.flac
# then concat part1 + part2 (approach 1)
```
Or in one pass with the `atrim`/`concat` audio filters (re-encodes):
```bash
ffmpeg -i input.flac -filter_complex \
  "[0:a]atrim=0:r1,asetpts=N/SR/TB[p1]; \
   [0:a]atrim=r2:end,asetpts=N/SR/TB[p2]; \
   [p1][p2]concat=n=2:v=0:a=1[out]" \
  -map "[out]" song.flac
```
The filter approach is sample-accurate but re-encodes. For FLAC→FLAC this is
lossless; for MP3 it's a generation loss (prefer approach 1 with `-c copy`).

### Recommendation: concat demuxer + `-c copy` (Approach 1)

For a music app, lossless is paramount. Plan:
1. For each final song segment, compute the "keep" sub-ranges (chapter range
   minus any SponsorBlock segments that overlap it).
2. Extract each keep sub-range with `ffmpeg -ss X -to Y -i input -c copy partN.ext`.
3. Concat the parts with the concat demuxer + `-c copy`.

This is **all lossless stream copy** — no re-encode, no quality loss, fast.

**Edge case — sample-accurate cuts**: if `-c copy` cut precision isn't enough (audible
click at the join), fall back to re-encoding just that segment. Detect via a
config flag. For FLAC (our primary format), re-encode-to-FLAC is lossless, so we
can always re-encode for precision without quality loss.

## The pure cut-plan function (the heart of the feature)

This is the **pure core** — fully unit-tested, zero I/O:

```ts
// packages/job-store/src/cut-plan.ts — PURE

interface Interval { start: number; end: number; }

/**
 * Given a chapter (the song's full range) and SponsorBlock segments that may
 * overlap it, compute the "keep" sub-ranges (what to extract + concat).
 * Pure: input → output, no side effects.
 */
export function computeKeepRanges(
  chapter: Interval,
  sponsorSegments: Interval[],  // only those overlapping the chapter
): Interval[] {
  // Sort segments by start, clip to chapter bounds, subtract from chapter.
  // Returns the gaps between sponsor segments within the chapter.
}

/**
 * Full plan: chapters × sponsor segments × user edits → list of songs,
 * each with its keep-ranges and metadata.
 */
export function computeCutPlan(
  chapters: Chapter[],
  sponsorSegments: SponsorSegment[],
  userEdits: UserEdits,
): CutPlan { ... }
```

Test cases (no mocks needed):
- No chapters → single track, no sponsor → one keep range.
- Chapter with no overlapping sponsor → one keep range = the chapter.
- Chapter with one sponsor fully inside → two keep ranges.
- Chapter with sponsor spanning the boundary → one keep range (sponsor clipped).
- Adjacent sponsors → merged into one gap.
- User-merged two chapters → combined range, sponsors re-computed.

## What this adds to the contract

```ts
export interface SponsorSegment {
  start: number;       // seconds
  end: number;
  category: SponsorCategory;
  uuid: string;
}

export type SponsorCategory =
  | "sponsor" | "selfpromo" | "interaction"
  | "intro" | "outro" | "preview"
  | "music_offtopic" | "filler";

export interface CutPlan {
  segments: CutSegment[];   // see doc 06 — each song's keep-ranges + metadata
}

// New job event types
export type JobEvent =
  | { type: "info"; info: VideoInfo; chapters?: Chapter[]; sponsorSegments?: SponsorSegment[] }
  | { type: "progress"; ... }
  | { type: "cutplan"; plan: CutPlan }   // emitted after user confirms the plan
  | { type: "cutting"; segmentIndex: number; total: number; pct: number }
  | { type: "done"; files: string[] }
  | { type: "error"; message: string };
```

## System dependency

ffmpeg is already required (for yt-dlp audio extraction). **No new system
dependency** for SponsorBlock — it's a plain HTTPS GET, no binary needed.

## New package: `sponsorblock`

Add to the backend monorepo:
```
packages/sponsorblock/
└── src/
    ├── client.ts      # fetch wrapper — getSegments(videoId): Promise<SponsorSegment[]>
    └── client.test.ts
```
A thin `fetch`-based client (~30 lines) hitting the hash-prefix endpoint for
privacy. Pure-response parsing. This is an **injected effect** (network) — the
cut-plan logic that *consumes* its output is the pure core.

## The segment editor (Approach B, confirmed)

> **User decision**: Approach B — backend-orchestrated. The frontend gets full
> control: edit each segment's title + album art, add/remove segments, adjust
> boundaries. The backend presents **sensible defaults** (computed from chapters +
> SponsorBlock + title parsing); the user changes whatever they want before
> confirming. The confirmed plan drives the ffmpeg cut/stitch.

This is a **review-then-cut** flow. The user never sees raw ffmpeg — they see a
timeline of songs with editable fields, and the cut plan is derived from their
edits. The "sensible defaults" and the "edit → cut plan" derivation are both
**pure functions** (zero I/O, fully unit-tested). The Svelte component is a thin
wrapper over that pure logic.

### The editable model: `CutDraft`

The backend computes a *draft* from the raw data; the frontend mutates a copy of
that draft; the user confirms → the backend derives the final `CutPlan` and
executes it.

```ts
// @yt-music/contract

/** A single editable song in the cut-plan editor. */
export interface SegmentDraft {
  id: string;                  // stable client-side id (for keyed list rendering)
  title: string;               // editable — defaults to parsed chapter title
  artist: string;              // editable — defaults to uploader or parsed from title
  album: string;               // editable — defaults to playlist title or uploader
  trackNumber: number;         // editable — defaults to 1-based section index
  albumArt: AlbumArtRef;       // editable — defaults to video thumbnail
  // The time range of this song in the source video:
  start: number;               // seconds — editable (trim)
  end: number;                 // seconds — editable (trim)
  // Sponsor segments that fall within [start, end] — shown on the timeline
  // so the user sees what will be removed. Each is toggleable.
  removedSegments: RemovedSegmentDraft[];
}

export interface RemovedSegmentDraft {
  uuid: string;                // SponsorBlock UUID (or synthetic id for manual)
  start: number;               // seconds, relative to the source video
  end: number;
  category: SponsorCategory | "manual";  // "manual" = user-added split point
  enabled: boolean;            // user can re-include a segment they'd rather keep
  label: string;               // human label: "Sponsor", "Intro", "Non-music"...
}

export type AlbumArtRef =
  | { kind: "video-thumbnail" }            // use the source video's thumbnail
  | { kind: "url"; url: string }           // a fetched image URL
  | { kind: "uploaded"; uploadId: string }; // user-uploaded image (stored server-side)

/** The full editable document the frontend manipulates. */
export interface CutDraft {
  sourceVideoId: string;
  sourceDuration: number;       // seconds — for the timeline ruler
  segments: SegmentDraft[];     // ordered; user can reorder
  globalAlbum: string;          // "apply to all" album field
  globalAlbumArt: AlbumArtRef;  // "apply to all" art
  globalArtist: string;         // "apply to all" artist
}
```

### Sensible defaults — a pure function

`computeDefaultDraft(info, chapters, sponsorSegments) → CutDraft` is **pure**:
no I/O, fully unit-tested. Its rules:

| Field | Default | Source |
|---|---|---|
| `segments` | one per chapter (or one for the whole video if no chapters) | yt-dlp `chapters[]` |
| `segment.title` | cleaned chapter title (strip ` Artist - `, `01. `, `(Official Audio)`) | `parseChapterTitle()` from doc 06 |
| `segment.artist` | uploader/channel name (unless parsed from title) | `info.uploader` |
| `segment.album` | playlist title if in a playlist, else uploader | `info.playlist_title ?? info.uploader` |
| `segment.trackNumber` | 1-based chapter index | enumerate |
| `segment.albumArt` | the video's thumbnail | `info.thumbnail` |
| `segment.start/end` | chapter start/end times | `chapter.start_time/end_time` |
| `segment.removedSegments` | SponsorBlock segments overlapping the chapter, `enabled: true` | `computeKeepRanges()` |

If SponsorBlock returns `music_offtopic` segments, those default to
`enabled: true` (remove them). `sponsor`/`intro`/`outro` also default on. The user
can toggle any off if they disagree (e.g., the "intro" is actually part of the
song's build-up).

### Frontend editing operations (all pure reducers over `CutDraft`)

The frontend is a thin Svelte component calling pure reducer functions:

```ts
// All pure: (draft, action) → draft. Tested with zero mocks.
editSegmentTitle(draft, segmentId, title): CutDraft
editSegmentArtist(draft, segmentId, artist): CutDraft
setSegmentAlbumArt(draft, segmentId, artRef): CutDraft
trimSegment(draft, segmentId, newStart, newEnd): CutDraft
removeSegment(draft, segmentId): CutDraft        // drops a song entirely
addSegment(draft, at: number): CutDraft           // manual split point → new song
splitSegment(draft, segmentId, at: number): CutDraft  // split one song into two
mergeSegments(draft, idA, idB): CutDraft          // combine two adjacent songs
reorderSegments(draft, fromIndex, toIndex): CutDraft
toggleRemovedSegment(draft, segmentId, uuid): CutDraft  // keep/remove an SB segment
addManualCut(draft, segmentId, at): CutDraft      // manual stitch point within a song
applyGlobalAlbum(draft, album): CutDraft          // set album on all segments
applyGlobalArtist(draft, artist): CutDraft
applyGlobalAlbumArt(draft, artRef): CutDraft
```

These mirror dispatch-web's "state is a pure reducer; Svelte runes are a thin
reactive wrapper over it, never the home of logic" principle. The `.svelte` file
wires props/events to these reducers and renders; it holds no business logic.

### Confirm → derive final plan → execute

When the user confirms, the frontend sends the edited `CutDraft` back:

```
POST /jobs/:id/confirm  { draft: CutDraft }
```

The backend runs the **pure** `finalizeCutPlan(draft) → CutPlan` (resolves
global fields, validates non-overlapping segments, computes final keep-ranges
from the enabled `removedSegments`), then executes with ffmpeg.

### Updated download flow (with both new features + the editor)

```
1. POST /jobs { url, mode: "split-by-chapters" }
2. downloader.getInfo(url) ──► VideoInfo + chapters[]
3. sponsorblock.getSegments(videoId) ──► SponsorSegment[]
4. computeDefaultDraft(info, chapters, sponsorSegments) ──► CutDraft  (pure defaults)
5. ──► WS: { type: "draft", draft }   ← frontend renders the editor with defaults
6. (user edits segments: titles, art, add/remove, trim, toggles SB) ──► pure reducers
7. POST /jobs/:id/confirm { draft }   ← user happy with the plan
8. downloader.downloadRaw(url) ──► raw.flac   (no --sponsorblock-remove)
9. finalizeCutPlan(draft) ──► CutPlan   (pure — resolves globals + keep-ranges)
10. for each segment: ffmpeg extract + concat (injected effect) ──► WS progress
11. tagger.tag(file, segmentMetadata) ──► one file per segment
12. ──► WS: { type: "done", files: [...] }
```

Steps 4, 6, 9 are **pure** — the logic that matters (what gets cut, what the
defaults are, how edits resolve) is fully unit-testable with no mocks. Steps 2, 3,
8, 10, 11 are **injected effects** at the edges. The Svelte editor (step 6) is a
thin component over pure reducers. This is the dispatch architecture applied
end-to-end.

### Album art handling

- **Default**: the video thumbnail (yt-dlp provides the URL; the backend
  downloads it during `getInfo`).
- **Per-segment override**: the user can upload an image per segment. The upload
  goes to the backend (`POST /jobs/:id/art` → returns `uploadId`); the draft
  references it as `{ kind: "uploaded", uploadId }`.
- **Fetch by URL**: user can paste an image URL (e.g., from MusicBrainz or a
  cover-art database) → `{ kind: "url", url }`.
- **Apply to all**: the global album-art field sets every segment's art at once.
- At execution time, the tagger downloads the resolved image and embeds it as the
  APIC frame (MP3 via `node-id3`) or PICTURE block (FLAC via ffmpeg/`metaflac`).
