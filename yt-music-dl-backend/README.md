# yt-music-dl-backend

Bun + TypeScript backend for downloading, splitting, tagging, and organizing
YouTube audio. Mirrors the `dispatch-backend` architecture (pure core / injected
shell / typed contracts).

See `../.research/` for the full design rationale and `AGENTS.md` for the rules.

## Stack

- **Bun** (runtime + `bun:sqlite`)
- **TypeScript** (strict, project references via `tsc -b`)
- **Biome** (tabs, double quotes, semicolons, width 100)
- **Vitest**
- **yt-dlp** standalone binary (subprocess, not a Python import)

## Commands

```sh
bun install            # install deps (first run)
bun run typecheck      # tsc -b --pretty
bun run test           # vitest
bun run check          # biome lint + format
bun run dev            # bun --watch packages/host-bin/src/main.ts
```

## System dependencies

The backend shells out to `yt-dlp` and `ffmpeg`:

```sh
sudo pacman -S yt-dlp ffmpeg
```

Or fetch the yt-dlp standalone binary via `../bin/install-yt-dlp`.

## Packages

| Package | Layer | Role |
|---|---|---|
| `contract` | shared | typed contracts (consumed by frontend as a `file:` dep) |
| `job-store` | pure core | download state machine, cut-plan logic |
| `downloader` | edge | yt-dlp subprocess wrapper |
| `host-bin` | composition | boots the server |
