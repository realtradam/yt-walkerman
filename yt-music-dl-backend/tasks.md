# tasks.md — live progress tracker

> Updated at each milestone. What's done, in-flight, blocked. The orchestrator
> reads this to know the project state; summoned agents update their rows.

## Done

- [x] **Research** — `.research/` (8 docs): stack decision (Bun+TS, shell out to
      yt-dlp), chapters, SponsorBlock, ffmpeg, tagging, project structure.
- [x] **Scaffold backend** — Bun + TS monorepo: `contract`, `job-store` (pure
      reducer + tests), `downloader` (arg builders + tests), `host-bin` (Bun.serve).
      typecheck/test/check green.
- [x] **Scaffold frontend** — Vite + Svelte 5 + Tailwind/DaisyUI. Consumes
      `@yt-music/contract` as `file:` dep. typecheck/check/build green.
- [x] **bin/up** — full stack (backend :24303 + frontend :24304), Tailscale-ready,
      Vite proxy for /api, /ws, /health.
- [x] **Governance** — AGENTS.md (root + backend + web), GLOSSARY.md,
      ORCHESTRATOR.md, tasks.md. Orchestrator role + worktree workflow + core
      principles written in.
- [x] **Phase 1: single-track download** — end-to-end vertical slice:
      `downloader` (real Bun.spawn yt-dlp: getInfo + download + progress parsing,
      13 tests), `storage-sqlite` (bun:sqlite, append-only events, reconcile
      recovery, 5 tests), `host-bin` (POST /api/jobs, GET /api/jobs/:id, WS /ws
      with subscribe + event replay, binary resolution), `contract` (API +
      WS protocol types), frontend (download form + live progress over WS,
      pure download reducer, 7 tests). Verified: downloaded a real MP3 (7.4 MB,
      properly tagged) end-to-end.
- [x] **Phase 2: tagging + library (backend)** — `tagger` (pure core:
      detectFormat/toTags/buildId3Tags; shell: createTagReader via music-metadata,
      createTagWriter via node-id3/ID3v2 MP3; 12 tests) + `library` (pure core:
      trackId/toTrack/isAudioFile; shell: createLibrary scans output dir, indexes
      via injected TagReader, listTracks(): Track[]; 9 tests) + `host-bin`
      GET /api/library → { tracks: Track[] }. typecheck/test/check green (39
      tests). Verified end-to-end via curl against real output/ MP3s. Frontend
      library browse handed off to the web agent.
- [x] **Phase 3: album splitting (chapters)** — `cut-plan` (PURE core:
      parseChapterTitle, computeKeepRanges, computeDefaultDraft, finalizeCutPlan
      + CutPlanError validation; 40 tests), `sponsorblock` (thin fetch client:
      hash-prefix API, injectable fetch, optional/graceful; 15 tests), `cutter`
      (ffmpeg executor: FLAC atrim-re-encode [lossless + correct duration] /
      MP3 stream-copy + concat demuxer; pure arg builders + 5 real-ffmpeg
      integration tests; 18 tests), `host-bin` split-by-chapters flow
      (getInfo → draft → await confirm → download raw → finalize → cut → tag →
      done) + POST /api/jobs/:id/confirm. downloader bug fix (yt-dlp writes
      Destination lines to STDOUT, not stderr — was silently broken since Phase
      1). typecheck/test/check green (116 tests). Verified end-to-end against
      https://youtu.be/7yzGBaiAMfw: 7 chapters → 7 tagged MP3s with correct
      durations, both packages-direct and real HTTP+WS+confirm host E2E.
      Frontend segment editor handed off to the web agent.
- [x] **Phase 4: SponsorBlock integration (backend verified)** — the
      sponsorblock → cut-plan → cutter pipeline was already wired in Phase 3;
      this phase verified it end-to-end + hardened edge-case tests. Verified:
      host-bin `runSplitJob` calls `sponsorblock.getSegments()` (graceful 404 →
      empty draft), `computeDefaultDraft` includes sponsors as toggleable
      `removedSegments` (enabled by default, labeled), `finalizeCutPlan` computes
      correct `keepRanges` (excluding enabled segments), the cutter extracts +
      concats each range (lossless), and `{type:"cutting"}` progress events fire
      per segment. Added 11 pure-core tests to cut-plan (40 → 51): touching
      adjacent segments, whole-chapter coverage, zero-length segments, unsorted
      input, boundary-at-start/end, end-to-end draft→finalize with real SB data,
      boundary-spanning sponsors, disabled toggles, default-category matrix.
      Tested against real SponsorBlock API (7yzGBaiAMfw=no data, JGwNGJdvx8/
      9bZkp7q19f0=sponsor data) + real host E2E (7 chapters → 7 MP3s, 7 cutting
      progress events). typecheck/test/test:bun/check green (127 vitest + 5 bun
      tests). Frontend handed off to conversation 54bf6fde (FE4).

- [x] **Phase 5: Organize (settings + path templates + move/rename)** —
      settings persistence, a pure path-template engine, and library
      move/rename. NEW package `path-template` (PURE core: `renderPathTemplate`,
      `sanitizePathComponent`, `padTrackNumber`; 28 tests covering empty
      fields, fallbacks, special-char sanitization, unicode, and path-traversal
      defense). `contract` gained `track?` on `Track` + `UpdateTrackRequest` /
      `UpdateTrackResponse` / `SaveSettingsRequest` / `OrganizeResponse`.
      `tagger` gained `track` (read via music-metadata `common.track.no`, write
      via node-id3 TRCK). `storage-sqlite` gained a single-row `settings` table
      + `getSettings()` (persisted-or-default) / `saveSettings()` (4 new bun
      tests). `library` gained `applyPathTemplate()` (read tags → render → move)
      + `renameTrack()` (merge tags → write → move → new Track), with a
      `writer?` injection (8 new integration tests against a real temp dir).
      `host-bin` wires `GET/PUT /api/settings`, `PATCH /api/library/:id`
      (rename), `POST /api/library/organize` (bulk move), and applies the path
      template after every download (single + split). Verified end-to-end: a
      real tagged MP3 PATCH-renamed to `{artist}/{album}/{track} - {title}.{ext}`,
      file moved on disk, new path-derived id returned. typecheck/test/test:bun/
      check green (169 vitest + 9 bun tests). Frontend handed off to conversation
      322772a1 (FE5).

- [x] **Phase 6: FLAC tagging** — `tagger` now WRITES FLAC, not just MP3. New
      pure core `buildMetaflacArgs(tags, filePath) → string[]` (ZERO I/O; builds
      the metaflac argv: `--remove-all-tags` → `--set-tag FIELD=VALUE` for
      non-empty title/artist/album → `TRACKNUMBER=N` when track>0 → optional
      `--import-picture-from <artPath>` → file path). Each argv token is one raw
      element (execFile, NOT a shell) so `;`/`'`/`"`/newlines/`=`/unicode pass
      verbatim (verified against metaflac 1.5.0). New `MetaflacTags` type (Tags
      minus duration/format + optional artPath) + `resolveMetaflac` (explicit →
      env → guarded `Bun.which` → 'metaflac'). `createTagWriter(metaflacBin?)`
      now branches on detectFormat: mp3→node-id3 (unchanged), flac→metaflac via
      `node:child_process` execFile (works under Node/vitest + Bun, same as the
      cutter — NOT Bun.spawn). 17 pure unit tests + 6 integration tests against
      real metaflac+ffmpeg+music-metadata (write→read round-trip, overwrite,
      empty fields, special chars, MP3 regression, unsupported-format error).
      host-bin passes `YTMDL_METAFLAC_PATH` to both writers + removed the
      'best-effort; FLAC writes deferred' comment — the split flow now tags FLAC
      output correctly. No contract change (Track/Tags already had `track`).
      typecheck/test/test:bun/check green (192 vitest + 9 bun tests).

## Next

(none — all seven phases complete)

- [x] **Phase 7: MusicBrainz text search (backend)** — NEW package
      `@yt-music/musicbrainz`: thin HTTP client for the MB web service API.
      PURE core (zero I/O): `buildRecordingSearchUrl` /
      `buildReleaseSearchUrl` / `buildReleaseLookupUrl` (Lucene query folding,
      URL encoding), `parseRecordingSearch` / `parseReleaseSearch` /
      `parseReleaseDetail` (media[].tracks[] → flat track list with GLOBAL
      running position for multi-disc), `matchAlbumToDraft` (exact-count →
      positional 1:1; mismatched → greedy normalized Levenshtein title match,
      no duplicate track assignments; confidence position/title/none) +
      `normalizeTitle` / `levenshtein` / `titleSimilarity` helpers. INJECTED
      shell `createMusicBrainzClient(opts)`: injectable fetch + baseUrl + UA,
      serialized promise-chain rate-limited to 1 req/sec (MB's hard limit). 45
      tests with canned JSON fixtures (no network). `contract` gained
      MetadataSearchRequest/MetadataResult/ReleaseTrack/ReleaseDetail/
      AlbumMatch/AlbumMatchResult/MatchAlbumRequest. `host-bin` wires
      `createMusicBrainzClient()` + 3 routes: POST /api/metadata/search,
      GET /api/metadata/release/:mbid, POST /api/metadata/match-album (fetches
      release → pure matchAlbumToDraft). typecheck/test/test:bun/check green
      (237 vitest + 9 bun tests). Frontend handed off to conversation
      453ec154 (FE7).
