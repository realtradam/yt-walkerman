# yt-music-dl-web

Vite + Svelte 5 + Tailwind/DaisyUI frontend for yt-music-dl. Mirrors the
`dispatch-web` architecture (pure core / injected shell / typed contracts).

Consumes `@yt-music/contract` from the backend as a `file:` dep.

## Commands

```sh
bun install
bun run typecheck   # svelte-check
bun run test        # vitest
bun run check       # biome (.ts/.js)
bun run build       # vite build
bun run dev         # vite dev server (port 24304)
```

Full stack: `../bin/up` (backend :24303 + this frontend :24304).
