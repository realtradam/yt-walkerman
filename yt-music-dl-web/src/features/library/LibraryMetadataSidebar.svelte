<!--
	src/features/library/LibraryMetadataSidebar.svelte — thin component.

	The per-track MusicBrainz lookup panel (right side of the library view). It
	is a thin variant of the segment editor's MetadataSidebar.svelte, adapted for
	a library Track instead of a SegmentDraft: the search request is built by
	buildTrackSearch (not buildRecordingSearch), the sidebar view-model is
	trackSidebarItems (not sidebarItems), and clicking a result calls onfill
	with an UpdateTrackRequest (a PATCH body) instead of EditAction[] (in-memory
	draft edits).

	The shared search state machine (reduceSearch), the SidebarItem view-model,
	and toSidebarItem are reused via re-exports from ./logic.js (which pulls them
	from ../segment-editor/metadata.js). The only side-effect is the injected
	MetadataApi.search call (rate-limited server-side to ~1 req/sec, so a search
	may take ~1s — a loading state is shown).

	The parent recreates this component via {#key track.id} when the selected
	track changes, which resets the search state and re-runs the mount search.
	A mount-only $effect runs the initial search with the prefilled query
	(track title); untrack keeps the parent's track-list updates from
	re-triggering it. Clicking a card calls onfill; on success the parent closes
	the sidebar (sets selectedTrackId = null).
-->
<script lang="ts">
	import { untrack } from "svelte";
	import type { Track, UpdateTrackRequest } from "@yt-music/contract";
	import type { MetadataApi } from "../../adapters/metadataApi.js";
	import {
		buildTrackSearch,
		initialSearchState,
		reduceSearch,
		toUpdateRequestFromItem,
		trackSidebarItems,
		type SearchState,
		type SidebarItem,
	} from "./logic.js";

	interface Props {
		track: Track;
		api: MetadataApi;
		onfill: (req: UpdateTrackRequest) => Promise<void>;
		onclose: () => void;
	}

	let { track, api, onfill, onclose }: Props = $props();

	// Captured once at init (NOT a tracked read in an effect) so the mount search
	// uses the track's current title without re-running on track-list updates.
	// svelte-ignore state_referenced_locally
	// — intentional: the prefilled query is a one-time snapshot of the title.
	const initialQuery = track.title;
	// Start "searching" when there's a query (the mount effect fires the search),
	// else "idle" (just the "Current tags" entry shows). Initialising to
	// "searching" directly (rather than setting it inside the effect) means the
	// effect never reads `searchState` synchronously — so the async result writes
	// can't re-trigger it (which would loop: searchOk → effect → search → …).
	let searchState = $state<SearchState>(
		initialQuery.trim()
			? { status: "searching", query: initialQuery, results: [] }
			: initialSearchState(initialQuery),
	);

	// The full sidebar list: the live "Current tags" entry + the last search's
	// MB results.
	let items = $derived<SidebarItem[]>(trackSidebarItems(track, searchState.results));

	// Applying state: while a PATCH is in flight after clicking a result.
	let applying = $state(false);
	let applyError = $state<string | undefined>(undefined);

	// Mount-only initial search. The body reads NO reactive state synchronously
	// (initialQuery is a const; buildTrackSearch reads props under untrack; api
	// is a stable reference) → it runs once and is not re-triggered by its own
	// async writes to `searchState`. Cleanup cancels the in-flight request when
	// the track changes (parent {#key} unmounts this instance).
	$effect(() => {
		if (!initialQuery.trim()) return; // nothing to query — current-tags entry only
		let cancelled = false;
		const req = untrack(() => buildTrackSearch(track, initialQuery));
		api.search(req)
			.then((results) => {
				if (!cancelled) searchState = reduceSearch(searchState, { type: "searchOk", results });
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					searchState = reduceSearch(searchState, {
						type: "searchFailed",
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	});

	// User-initiated search (Search button / Enter). Invoked from an event
	// handler, so reads of track are NOT tracked — no untrack needed here.
	async function doSearch(query: string) {
		const req = buildTrackSearch(track, query);
		if (!req.query) return;
		searchState = reduceSearch(searchState, { type: "searchStarted", query: query.trim() });
		try {
			const results = await api.search(req);
			searchState = reduceSearch(searchState, { type: "searchOk", results });
		} catch (err) {
			searchState = reduceSearch(searchState, {
				type: "searchFailed",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Click a sidebar item → build a PATCH body → call onfill. The "Current
	// tags" entry produces an empty body (no-op). On success the parent closes
	// the sidebar; on error the sidebar stays open so the user can try another
	// result.
	async function apply(item: SidebarItem) {
		const req = toUpdateRequestFromItem(item);
		if (Object.keys(req).length === 0) return; // current tags — no-op
		applying = true;
		applyError = undefined;
		try {
			await onfill(req);
			// parent closes the sidebar on success (selectedTrackId = null)
		} catch (err) {
			applyError = err instanceof Error ? err.message : String(err);
		} finally {
			applying = false;
		}
	}

	function onSearchSubmit(e: SubmitEvent) {
		e.preventDefault();
		void doSearch(searchState.query);
	}
</script>

<div class="card bg-base-100 shadow-sm border border-base-300">
	<div class="card-body gap-3">
		<div class="flex items-center justify-between">
			<h3 class="card-title text-base">Metadata</h3>
			<button class="btn btn-ghost btn-xs" onclick={onclose} aria-label="Close metadata panel">✕</button>
		</div>
		<p class="text-xs text-base-content/60 -mt-2">
			{track.title || "(untitled)"} · click a result to update this track's tags
		</p>

		<!-- search box (prefilled with the track title) -->
		<form class="join w-full" onsubmit={onSearchSubmit}>
			<input
				class="input join-item input-sm flex-1"
				placeholder="Search MusicBrainz…"
				value={searchState.query}
				disabled={applying}
				oninput={(e) =>
					(searchState = reduceSearch(searchState, { type: "setQuery", query: e.currentTarget.value }))}
			/>
			<button
				class="btn join-item btn-sm"
				type="submit"
				disabled={searchState.status === "searching" || applying}
			>
				{#if searchState.status === "searching"}
					<span class="loading loading-spinner loading-xs"></span>
				{:else}
					Search
				{/if}
			</button>
		</form>

		<!-- rate-limit hint while searching -->
		{#if searchState.status === "searching"}
			<p class="text-xs text-base-content/50">MusicBrainz is rate-limited (~1 req/sec)…</p>
		{/if}

		<!-- search error -->
		{#if searchState.status === "error"}
			<div class="alert alert-error py-2 text-sm">
				<span>{searchState.error}</span>
			</div>
			<button class="btn btn-ghost btn-xs self-start" onclick={() => void doSearch(searchState.query)}>
				Retry
			</button>
		{/if}

		<!-- apply error (PATCH failed — sidebar stays open) -->
		{#if applyError}
			<div class="alert alert-error py-2 text-sm">
				<span>Couldn't update: {applyError}</span>
			</div>
		{/if}

		<!-- applying hint -->
		{#if applying}
			<p class="text-xs text-base-content/50">
				<span class="loading loading-spinner loading-xs"></span>
				Updating track tags…
			</p>
		{/if}

		<!-- results list -->
		<div class="flex flex-col gap-1.5">
			{#each items as item (item.source + (item.id ?? "current"))}
				<button
					type="button"
					class="card-bordered rounded-box border border-base-300 bg-base-100 p-2 text-left transition-colors hover:bg-base-200 focus:bg-base-200 focus:outline-none {applying
						? 'pointer-events-none opacity-60'
						: ''}"
					onclick={() => void apply(item)}
				>
					<div class="flex items-center justify-between gap-2">
						{#if item.source === "youtube"}
							<span class="badge badge-sm badge-secondary">Current</span>
						{:else}
							<span class="badge badge-sm badge-accent">MusicBrainz</span>
						{/if}
						{#if item.score !== undefined}
							<span class="badge badge-sm badge-ghost tabular-nums">{item.score}%</span>
						{:else if item.source === "youtube"}
							<span class="text-[10px] text-base-content/40">current</span>
						{/if}
					</div>
					<p class="mt-1 truncate text-sm font-medium">{item.title || "(untitled)"}</p>
					<p class="truncate text-xs text-base-content/70">{item.artist}</p>
					<p class="truncate text-xs text-base-content/50">
						{#if item.album}{item.album}{:else}<span class="italic">no album</span>{/if}
						{#if item.trackNumber !== undefined} · #{item.trackNumber}{/if}
					</p>
				</button>
			{/each}

			{#if searchState.status === "results" && searchState.results.length === 0}
				<p class="py-4 text-center text-sm text-base-content/50">
					No MusicBrainz matches. The "Current" entry above keeps the existing tags.
				</p>
			{/if}
		</div>
	</div>
</div>
