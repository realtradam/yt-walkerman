# 08 — MusicBrainz Integration (Phase 7)

> Text-only metadata lookup via the MusicBrainz web service API. No
> fingerprinting — we search by artist + recording/release title.

## API Summary

- **Root URL**: `https://musicbrainz.org/ws/2/`
- **Format**: `fmt=json` query param
- **Auth**: None. Must set a meaningful `User-Agent` header.
- **Rate limit**: **1 request per second** (must throttle client-side)
- **No API key required**

## Two search modes

### 1. Recording search (per-track lookup)

Search for individual recordings by artist + title:

```
GET /ws/2/recording?query=artist:"Pink Floyd" AND recording:"Time"&limit=10&fmt=json
```

Returns recordings with `score` (0-100), each linked to releases (albums the
track appears on). Each recording has: title, artist-credit, releases[], length,
id (MBID).

### 2. Release search (album match-all)

Search for a release (album) by artist + album name:

```
GET /ws/2/release?query=artist:"Pink Floyd" AND release:"Dark Side of the Moon"&limit=10&fmt=json
```

Then fetch the full release with its track listing:

```
GET /ws/2/release/<MBID>?inc=recordings+artist-credits+release-groups&fmt=json
```

Returns the complete release with `media[]` → `tracks[]` → each track has:
title, position, number, length, recording (with MBID).

## Matching algorithm (album match-all)

Given a CutDraft with N segments (chapters) and a MusicBrainz release with M
tracks:

1. If N == M: match by position (chapter[0] → track[1], chapter[1] → track[2], etc.)
2. If N != M: match by title similarity (Levenshtein or normalized string compare)
   - Normalize: lowercase, strip punctuation/parentheticals, collapse whitespace
   - Best match per chapter, no duplicates
3. Fill each segment with: title (from MB), artist (from MB release), album
   (from MB release), trackNumber (from MB track position)

## Contract types (new in @yt-music/contract)

```ts
// Search request
interface MetadataSearchRequest {
  query: string;       // free text or "artist:X recording:Y"
  artist?: string;     // optional artist hint
  type: "recording" | "release";
}

// A single search result
interface MetadataResult {
  id: string;          // MBID
  type: "recording" | "release";
  title: string;       // recording title or release title
  artist: string;      // artist name
  album?: string;      // release title (for recordings)
  trackNumber?: number; // track position in release
  score: number;       // 0-100 relevance
  raw: MusicBrainzRaw;  // raw MB data for the frontend to display
}

// Full release with track list (for album match-all)
interface ReleaseDetail {
  id: string;          // MBID
  title: string;       // album title
  artist: string;      // album artist
  date?: string;       // release date
  tracks: ReleaseTrack[];
}

interface ReleaseTrack {
  position: number;    // track number (1-based)
  title: string;
  length?: number;     // duration in ms
  recordingId: string; // MBID of the recording
}

// Album match result: which segments match which tracks
interface AlbumMatchResult {
  matches: Array<{
    segmentIndex: number;
    track: ReleaseTrack;
    confidence: "position" | "title" | "none";
  }>;
}
```

## HTTP API (new endpoints in host-bin)

```
POST /api/metadata/search
  Body: MetadataSearchRequest
  → { results: MetadataResult[] }

GET /api/metadata/release/:mbid
  → ReleaseDetail (with tracks)

POST /api/metadata/match-album
  Body: { draft: CutDraft, releaseId: string }
  → AlbumMatchResult (segmentIndex → ReleaseTrack mapping)
```

## Package structure

```
packages/musicbrainz/
├── src/
│   ├── index.ts          # pure: buildSearchUrl, parseSearchResponse,
│   │                     #       parseReleaseResponse, matchAlbumToDraft
│   ├── index.test.ts      # unit tests (pure functions, no network)
└── package.json
```

The pure functions (buildSearchUrl, parse*, matchAlbumToDraft) are tested with
canned JSON fixtures — zero network calls in tests. The shell (createClient)
wraps `fetch` and is rate-limited to 1 req/sec.

## Frontend design

### Sidebar (right panel in segment editor)

When a segment is selected:
1. Top entry: "Generated from YouTube" — the current parsed title/artist
2. Below: MusicBrainz search results (clickable cards)
3. Search box at top to refine query
4. Each result card shows: title, artist, album, track number, score

Clicking a result fills the selected segment's fields.

### Album match-all

Button in the segment editor header: "Match Album"
1. Opens a search dialog: artist + album name input
2. Shows release search results
3. User selects a release → backend fetches full track list
4. Backend matches tracks to chapters → fills ALL segments at once
5. User can still individually adjust any segment afterward
