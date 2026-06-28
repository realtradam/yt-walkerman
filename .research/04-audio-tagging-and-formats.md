# 04 — Audio Tagging & Walkman Formats

> Covers: tag libraries, audio formats, ffmpeg, and the Walkman's requirements.

## Sony Walkman supported formats

Researched from Sony NW-A306 / NW-A45 help guides (representative of the modern
Walkman NW-A series that the user likely owns). The device is an Android-based
high-res audio player.

| Format | Extensions | Bit depth / Bitrate | Sample rate |
|---|---|---|---|
| **MP3** | .mp3 | 32–320 kbps (VBR supported) | 32, 44.1, 48 kHz |
| **FLAC** | .flac | 16 / 24 bit | 8 kHz – 384 kHz (hi-res!) |
| **AAC** | .mp4, .m4a, .3gp | 16–320 kbps | 8 – 48 kHz |
| HE-AAC | .mp4, .m4a, .3gp | 32–144 kbps | 8 – 48 kHz |
| Apple Lossless | .mp4, .m4a | 16 / 24 bit | 8 kHz – 384 kHz |
| WAV | .wav | 16/24/32 bit | 8 kHz – 384 kHz |
| AIFF | .aif, .aiff | 16/24/32 bit | 8 kHz – 384 kHz |
| DSD | .dsf, .dff | 1 bit | 2.8 / 5.6 / 11.3 MHz |
| APE | .ape | 8/16/24 bit | 8 – 192 kHz |
| MQA | .mqa.flac | (via FLAC container) | — |
| WMA | .wma | 32–320 kbps | 44.1 kHz |

### Recommended target formats

1. **FLAC** (primary) — lossless, supports 24-bit hi-res, natively supported by
   the Walkman, displays the "HR" hi-res badge. YouTube audio tops out around
   256 kbps AAC (~Opus 160), so FLAC won't add real fidelity, but it's lossless
   (no generation loss) and maximally compatible with the Walkman's tag/metadata
   + cover-art features. File sizes are larger.
2. **MP3** (compatibility fallback) — universal, smaller, fine if storage matters.
   Use 320 kbps CBR for best MP3 quality.

> Note: YouTube serves audio as Opus/AAC in a WebM/MP4 container. yt-dlp + ffmpeg
> transcode to FLAC or MP3. "Hi-res" from YouTube is marketing — the source is
> ~256 kbps max. FLAC here means "lossless copy of the source," not true hi-res.

## Tagging: the two-stage approach

### Stage 1 — Tag on download (yt-dlp post-processors)

yt-dlp does tagging as a built-in post-processor — no extra code for the initial
download:

```
yt-dlp -x --audio-format flac \
  --embed-metadata \
  --embed-thumbnail \
  --parse-metadata "%(title)s:%(track)s" \
  --parse-metadata "%(uploader)s:%(artist)s" \
  URL
```

- `--embed-metadata` (alias `--add-metadata`): writes title, artist, date, etc.
  from the info dict into the file's tags (uses ffmpeg's metadata muxer).
- `--embed-thumbnail`: writes the video thumbnail as cover art (APIC frame for
  MP3, FLAC PICTURE block).
- `--parse-metadata`: maps yt-dlp info fields → tag fields (e.g., set `track` from
  the video title, `artist` from uploader). Powerful for cleanup.

**This means the download path needs zero separate tagging code.** yt-dlp hands us
a properly tagged file. The backend just records the metadata in SQLite for the
organize/browse UI.

### Stage 2 — Edit/re-tag existing files (JS libraries)

For the UI feature "edit this track's tags" (fix artist, album, cover art), we need
JS libraries that read + write tags:

#### `music-metadata` — READ any format ✅
- **npm**: `music-metadata`, v11.12.3, **1362 dependents**, last published 3 months ago.
- Author: Borewit. Supports MP3, MP4/M4A, FLAC, Ogg, WAV, AIFF, and many more.
- Parses both the container and tag formats (ID3v1/v2, Vorbis comments, MP4 atoms).
- **Read-only** (parsing). Use for: displaying current metadata in the UI,
  verifying tags after yt-dlp writes them, building the library index.
- Example:
  ```ts
  import { parseFile } from "music-metadata";
  const { common, format } = await parseFile("song.flac");
  console.log(common.artist, common.album, common.title);
  console.log(format.duration, format.sampleRate, format.bitsPerSample);
  ```

#### `node-id3` — WRITE ID3v2 (MP3) ✅
- **npm**: `node-id3`, v0.2.9, **138 dependents**, last published 5 months ago.
- Pure JavaScript ID3v2 **writer and reader**. MP3-focused.
- Writes: title, artist, album, year, track, genre, **APIC (album art)**, etc.
- Example:
  ```ts
  import nodeID3 from "node-id3";
  const tags = { title: "Song", artist: "Artist", album: "Album",
    APIC: { mime: "image/jpeg", type: { id: 3, name: "Cover" },
            data: coverBuffer } };
  nodeID3.write(tags, "song.mp3");
  ```
- **Limitation**: ID3v2 only → MP3. **Does not write FLAC Vorbis comments or MP4
  atoms.** For multi-format writes, see below.

#### Multi-format write: `ffmpeg` or `metaflac`/`kid3`
For writing tags to FLAC/M4A from JS, the cleanest options are:
- **ffmpeg** (via `fluent-ffmpeg`): re-mux with new metadata. Works for all
  formats but re-processes the file (fast for stream-copy, but not in-place edits).
- **kid3-cli**: a command-line tagger that handles all formats in-place. Can be
  driven from JS like yt-dlp (spawn + parse). Most robust for "edit tags on any
  format."
- There's no single great pure-JS multi-format tag writer as of research.
  `node-id3` covers MP3 (the most common case); for FLAC we can use ffmpeg's
  metadata muxer or a `metaflac` wrapper.

**Recommendation**: Use `node-id3` for MP3 edits (covers most users). For FLAC tag
edits, shell out to `metaflac` (from flac package) or use ffmpeg. Keep the tag
**interface** format-agnostic so the implementation can evolve.

#### `fluent-ffmpeg` — audio conversion (if needed)
- **npm**: `fluent-ffmpeg`, wraps the ffmpeg CLI. Used for transcode (e.g., FLAC→MP3
  for a device that needs MP3) and for re-muxing metadata.
- ffmpeg is **already a required dependency of yt-dlp** (for audio extraction and
  merging), so it's available regardless.

## The tag data model

The info we care about (mirrors what a music player displays):

| Tag | yt-dlp info field | Notes |
|---|---|---|
| title / track | `title` | Often "Artist - Song (MV)"; needs parse-metadata cleanup |
| artist | `uploader` / `channel` | Uploader ≠ artist for MV channels; user-editable |
| album | (manual) | yt-dlp has no album concept; default to "YouTube" or playlist name |
| year/date | `upload_date` | YYYYMMDD → YYYY |
| genre | (manual) | Default "Music" or derive |
| cover art | `thumbnail` | yt-dlp embeds automatically |
| duration | `duration` | seconds |
| source URL | `webpage_url` | Store in a custom/URL tag for traceability |
| youtube ID | `id` | Store for dedup + re-download |

A key **organize** feature: let the user override artist/album/title before
download (or edit after), since YouTube metadata is messy ("OFFICIAL MV",
"【Lyrics】", etc.). The UI's tag editor (Stage 2) is where the real value is.
