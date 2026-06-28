# 06 — YouTube Chapters (Album Video Splitting)

> Feature: link an album/compilation video (one video, many songs) and the app
> automatically splits it into individual song files based on YouTube "chapters."

## Can we pull chapters? Yes — natively, two ways.

### Way 1: yt-dlp extracts chapters into the info dict

yt-dlp's `--dump-json` / `--dump-single-json` (`-J`) output includes a
`chapters` field whenever the video has chapters. From the LobeHub skill example:

```bash
yt-dlp --dump-json "VIDEO_URL" | jq '.chapters'
```

The `chapters` field is an array of:

```jsonc
[
  {
    "start_time": 0.0,        // seconds (float)
    "end_time": 187.42,
    "title": "Artist - Song One",
    "title_range": "(00:00 - 03:07)"   // formatted display range (may be absent)
  },
  {
    "start_time": 187.42,
    "end_time": 412.8,
    "title": "Artist - Song Two"
  }
]
```

This is exactly the data we need: each chapter = one song with a title and
start/end timestamps. **No scraping required** — it's a structured field in the
JSON yt-dlp already produces for metadata extraction.

### Way 2: yt-dlp can split by chapters directly

yt-dlp has a `SplitChapters` post-processor exposed via the `--split-chapters`
flag:

```bash
# Split video into chapter files
yt-dlp --split-chapters URL

# With custom output template for chapters (section_number / section_title)
yt-dlp --split-chapters \
  -o "chapter:%(title)s - %(section_number)s %(section_title)s.%(ext)s" \
  URL
```

Output-template fields available for chapter splits:
- `section_number` — 1-based chapter index
- `section_title` — the chapter title (= song name for album videos)
- `section_start` — chapter start time
- `section_end` — chapter end time

And `--force-keyframes-at-cuts` forces keyframes at the cut points for cleaner
splits (requires re-encoding at the boundaries; slightly slower but avoids
glitches).

### Way 3: `--download-sections` (download only specific chapters/time-ranges)

```bash
# Download only chapters matching a regex
yt-dlp --download-sections "Song One" URL

# Download a time range (* prefix = time range, not chapter name)
yt-dlp --download-sections "*10:15-13:42" URL

# Multiple sections
yt-dlp --download-sections "*0:00-3:00" --download-sections "*5:00-8:00" URL
```

This lets us download *just* one song from a long video, or a curated set of
time-ranges — useful after the user reviews the cut plan.

## Recommended approach: backend-orchestrated (not yt-dlp-native)

There are two philosophies for the split feature:

### Option A — Let yt-dlp do everything (`--split-chapters`)
One command: download → split → tag. yt-dlp handles it.
- **Pro**: simplest, no orchestration code.
- **Con**: black box. The user can't *preview* what will be split before
  downloading. Can't edit chapter titles, merge two chapters, or trim the
  intro/outro of a song. Can't combine chapters with SponsorBlock removal in a
  reviewable way.

### Option B — Backend orchestrates ✅ RECOMMENDED
1. Fetch metadata: `yt-dlp --dump-json` → extract `chapters[]` (pure read).
2. Fetch SponsorBlock segments (see doc 07) → compute the "keep" vs "cut"
   intervals.
3. **Show the user a preview**: the chapter list + which SponsorBlock segments
   will be removed, as an editable timeline. They can adjust boundaries, fix
   titles (strip "Artist - " prefix, etc.), merge/split chapters.
4. Download the full audio once (raw, unsplit).
5. Run a **pure function**: `computeCutPlan(chapters, sponsorSegments, userEdits) → CutPlan`.
   This produces a list of `{ start, end, title }` segments to extract — fully
   unit-testable, zero I/O.
6. Execute the cut plan with ffmpeg (an injected effect): one `ffmpeg` invocation
   per song using `-ss`/`-to` (stream copy or re-encode).
7. Tag each output file with `node-id3` / yt-dlp's `--embed-metadata`.

This fits the dispatch architecture perfectly:
- `computeCutPlan` is **pure core** (unit-tested with no mocks).
- The ffmpeg execution is an **injected effect** at the edge.
- The user-editable preview is the kind of "surface" dispatch models (declared
  data, rendered generically).

## Chapter title parsing (the messy reality)

YouTube chapter titles for album videos are inconsistent. Common patterns:

| Raw chapter title | Desired tag: title | Desired tag: artist |
|---|---|---|
| `Artist - Song Name` | `Song Name` | `Artist` |
| `Song Name` | `Song Name` | (from uploader) |
| `01. Song Name` | `Song Name` | (from uploader) |
| `Artist - 01. Song Name` | `Song Name` | `Artist` |
| `Song Name (Official Audio)` | `Song Name` | (from uploader) |
| `00:00 Song Name` | `Song Name` | (from uploader) |

A **pure parser** `parseChapterTitle(raw) → { artist?, track, trackNumber? }`
handles these. yt-dlp's `--parse-metadata` does this at the CLI level too, but
doing it in TS gives us the preview/edit UX. Make it a pure function with
pattern tests — dispatch's strict-core testing applies.

## Edge cases

- **No chapters**: some album videos have no chapter markers. Fall back to a
  single track (the whole video) or offer manual split-point entry in the UI.
- **Chapter 0 = "Intro"**: often the first chapter is an intro/not a song. The
  user review step catches this; offer "exclude this chapter."
- **Overlapping with SponsorBlock**: a SponsorBlock `music_offtopic` segment
  might fall *inside* a chapter (e.g., a mid-song talking break). The cut plan
  must handle sub-chapter cuts → produces a song with a gap stitched out.
  See doc 07 for the stitch logic.
- **Very long videos**: downloading the full audio first is fine (audio is
  small relative to video). For a 2-hour compilation at 256kbps Opus ≈ 230 MB.

## What this adds to the contract

```ts
// New types in @yt-music/contract
export interface Chapter {
  title: string;
  startTime: number;   // seconds
  endTime: number;     // seconds
}

export interface VideoInfo {
  // ... existing fields
  chapters?: Chapter[];   // present if the video has chapters
}

export interface CutSegment {
  start: number;          // seconds
  end: number;            // seconds
  title: string;          // cleaned song title
  artist?: string;        // parsed or user-set
  trackNumber?: number;
  removedSegments?: SponsorSegment[]; // SB segments cut from within this song
}

export type JobMode = "single" | "split-by-chapters";
```

The download job carries a `mode`: `single` (one track) or `split-by-chapters`
(album video → N tracks). The backend produces one output file per `CutSegment`.
