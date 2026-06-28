<!--
	src/features/segment-editor/MetadataSidebar.svelte — thin component.

	The per-segment MusicBrainz lookup panel (right side of the editor). It is a
	thin wrapper over the PURE `metadata.ts`: the search state machine
	(`reduceSearch`), the request builder (`buildRecordingSearch`), the sidebar
	view-model (`sidebarItems` — the "Generated from YouTube" entry first, then MB
	cards), and the click-to-fill actions (`fillActions`). The only side-effect is
	the injected `MetadataApi.search` call (rate-limited server-side to ~1 req/sec,
	so a search may take ~1s — a loading state is shown).

	The parent recreates this component via `{#key segment.id}` when the selected
	segment changes, which resets the search state and re-runs the mount search.
	A mount-only `$effect` runs the initial search with the prefilled query
	(segment title); `untrack` keeps field edits in the main editor from
	re-triggering it. Clicking a card dispatches cut-plan edits through `onfill`.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import type { SegmentDraft } from "@yt-music/contract";
	import type { MetadataApi } from "../../adapters/metadataApi.js";
	import type { EditAction } from "./logic.js";
	import {
		buildRecordingSearch,
		fillActions,
		initialSearchState,
		reduceSearch,
		sidebarItems,
		type SearchState,
		type SidebarItem,
	} from "./metadata.js";

	interface Props {
		segment: SegmentDraft;
		globalArtist: string;
		api: MetadataApi;
		onfill: (actions: EditAction[]) => void;
		onclose: () => void;
	}

	let { segment, globalArtist, api, onfill, onclose }: Props = $props();

	// Captured once at init (NOT a tracked read in an effect) so the mount search
	// uses the segment's current parsed title without re-running on field edits.
	// svelte-ignore state_referenced_locally
	// — intentional: the prefilled query is a one-time snapshot of the title.
	const initialQuery = segment.title;
	// Start "searching" when there's a query (the mount effect fires the search),
	// else "idle" (just the "Generated from YouTube" entry shows). Initialising to
	// "searching" directly (rather than setting it inside the effect) means the
	// effect never reads `searchState` synchronously — so the async result writes
	// can't re-trigger it (which would loop: searchOk → effect → search → …).
	let searchState = $state<SearchState>(
		initialQuery.trim()
			? { status: "searching", query: initialQuery, results: [] }
			: initialSearchState(initialQuery),
	);

	// The full sidebar list: the live "Generated from YouTube" entry (reflects
	// in-progress edits in the main editor) + the last search's MB results.
	let items = $derived<SidebarItem[]>(sidebarItems(segment, searchState.results));

	// Mount-only initial search. The body reads NO reactive state synchronously
	// (initialQuery is a const; buildRecordingSearch reads props under untrack;
	// api is a stable reference) → it runs once and is not re-triggered by its
	// own async writes to `searchState`. Cleanup cancels the in-flight request
	// when the segment changes (parent {#key} unmounts this instance) so a stale
	// result never overwrites the new one.
	$effect(() => {
		if (!initialQuery.trim()) return; // nothing to query — YouTube entry only
		let cancelled = false;
		const req = untrack(() => buildRecordingSearch(segment, initialQuery, globalArtist));
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
	// handler, so reads of segment/globalArtist are NOT tracked — no untrack
	// needed here. Refuses to fire when there's nothing to query.
	async function doSearch(query: string) {
		const req = buildRecordingSearch(segment, query, globalArtist);
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

	function apply(item: SidebarItem) {
		onfill(fillActions(segment.id, item));
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
			Track #{segment.trackNumber} · click a result to fill this segment
		</p>

		<!-- search box (prefilled with the segment title) -->
		<form class="join w-full" onsubmit={onSearchSubmit}>
			<input
				class="input join-item input-sm flex-1"
				placeholder="Search MusicBrainz…"
				value={searchState.query}
				oninput={(e) =>
					(searchState = reduceSearch(searchState, { type: "setQuery", query: e.currentTarget.value }))}
			/>
			<button
				class="btn join-item btn-sm"
				type="submit"
				disabled={searchState.status === "searching"}
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

		<!-- error -->
		{#if searchState.status === "error"}
			<div class="alert alert-error py-2 text-sm">
				<span>{searchState.error}</span>
			</div>
			<button class="btn btn-ghost btn-xs self-start" onclick={() => void doSearch(searchState.query)}>
				Retry
			</button>
		{/if}

		<!-- results list -->
		<div class="flex flex-col gap-1.5">
			{#each items as item (item.source + (item.id ?? "youtube"))}
				<button
					type="button"
					class="card-bordered rounded-box border border-base-300 bg-base-100 p-2 text-left transition-colors hover:bg-base-200 focus:bg-base-200 focus:outline-none"
					onclick={() => apply(item)}
				>
					<div class="flex items-center justify-between gap-2">
						{#if item.source === "youtube"}
							<span class="badge badge-sm badge-secondary">YouTube</span>
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
					No MusicBrainz matches. The "YouTube" entry above keeps the current fields.
				</p>
			{/if}
		</div>
	</div>
</div>
