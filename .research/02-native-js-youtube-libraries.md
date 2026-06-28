# 02 — Native JS YouTube Download Libraries

> Question: *Are there good JS libraries we could use (instead of shelling out)?*

## Summary verdict

**Use yt-dlp (binary) as the download engine.** Pure-JS YouTube downloaders are
inherently fragile because YouTube constantly changes its player cipher and
signature algorithm. yt-dlp's community ships fixes within days; a JS library
cannot keep pace unless it's very actively maintained. The one exception worth
watching is `youtubei.js`, which is excellent for metadata/search but still riskier
than yt-dlp for reliable audio extraction.

## Library survey

### ❌ `@distube/ytdl-core` — ABANDONED
- **Status: ARCHIVED Aug 16, 2025.** Read-only. The maintainer explicitly says:
  > "@distube/youtube depends on youtubei.js from now on. This fork will be no
  > longer maintained. Please use alternatives (e.g. youtubei.js) instead."
- Was the most popular pure-JS downloader (513 stars, 15.7k dependents at peak).
- Forked from `fent/node-ytdl-core` (the original, also effectively unmaintained).
- History of constant breakage: needed runtime update checks, warned users every
  12h to upgrade. This epitomizes why pure-JS download is fragile.
- **Do not use.**

### ✅ `youtubei.js` (YouTube.js) — excellent, but role-limited
- **GitHub**: LuanRT/YouTube.js — 5k stars, 14.8k dependents, **73 contributors**.
- **Very actively maintained**: v17.2.0 released June 24, 2026 (1 day before this
  research). 1,647 commits, 108 releases.
- Pure TypeScript client for YouTube's **internal** API (InnerTube).
- Works on Node.js, Deno, browsers.
- Can fetch video info, search, browse, get streaming data, and download.
- **MIT license.**
- **Why not use it for download?** It accesses YouTube's private API and must
  reverse-engineer the player's signature/decipher logic. When YouTube changes
  this (as they did in late 2025 — requiring Deno/JS runtime for yt-dlp's
  extractors too), youtubei.js updates but there's inherent lag and risk. yt-dlp
  has a larger community catching these breaks faster.
- **Recommended role**: Use youtubei.js if we later build a **search/browse UI**
  (search YouTube for music, list results, show thumbnails) without needing the
  YouTube Data API v3 (which requires a Google Cloud project + quota). It's a
  great fit for the "discover" half of the app. For the actual audio extraction,
  defer to yt-dlp.

### ⚠️ `ytdlp-nodejs` — wraps the binary, feature-rich but less proven
- v3.4.4 (5 months old at research time), 16 dependents, beta notice on v3.4.0.
- 0 dependencies. TypeScript with fluent builder API.
- Auto-downloads the yt-dlp binary + ffmpeg. Progress callbacks, streaming,
  audio extraction (mp3/flac/aac/opus/wav/alac), metadata, thumbnails.
- API example:
  ```ts
  const result = await ytdlp
    .download(url)
    .extractAudio().audioFormat('flac')
    .embedThumbnail().embedMetadata()
    .on('progress', (p) => console.log(p.percentage_str))
    .run();
  ```
- **Pros**: nicest API, covers exactly our use case (audio extract + tag).
- **Cons**: smaller community (16 dependents vs 91), beta, single maintainer
  (iqbal-rashed), less battle-tested. If it breaks, we wait on one person.
- **Verdict**: A reasonable choice if we want maximal convenience, but
  `youtube-dl-exec` is safer due to maturity.

### ✅ `youtube-dl-exec` — the pragmatic wrapper (our pick)
- v3.1.8 (6 days old), 91 dependents, 126 versions. Maintained by microlink.io
  (a company, not a solo dev). MIT.
- Auto-installs yt-dlp binary on postinstall.
- Exposes the raw subprocess (`youtubedl.exec(...)`) for progress/cancellation.
- Thin — doesn't hide yt-dlp; just manages the binary and gives typed flag access.
- **This is our recommended wrapper** (see doc 01, Option B1).

### Other (not deeply investigated)
- `yt-dlp-exec` — minor npm variant, similar approach.
- `@distube/yt-dlp` — DisTube's binary wrapper; had a stdout/stderr mixing bug
  (issue #17) that broke JSON parsing. Avoid.

## The late-2025 YouTube change (context)

In late 2025, YouTube changed its player in a way that **broke all third-party
clients** (youtube-dl, yt-dlp, youtubei.js). The fix required a JavaScript runtime
to execute YouTube's own player JS. yt-dlp added support for using Node/Deno as
the JS runtime for extractors (`--extractor-args "youtube:player_client=..."`).
Both `ytdlp-nodejs` and `youtube-dl-exec` support passing this through. This
event validates the choice to depend on yt-dlp (the community fixed it) rather
than a standalone JS lib (which had to independently catch up).

## Decision matrix

| Need | Tool |
|---|---|
| Reliable audio download + extract | **yt-dlp binary** (via youtube-dl-exec or custom) |
| Tag on download | yt-dlp `--embed-metadata --embed-thumbnail` |
| YouTube search/browse UI (future) | **youtubei.js** |
| Read existing file metadata | `music-metadata` |
| Edit ID3 tags on existing files | `node-id3` |
| ❌ Pure-JS download as primary engine | rejected (fragile, ytdl-core dead) |
