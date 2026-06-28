<!--
	src/features/segment-editor/MatchAlbumDialog.svelte — thin component.

	The "Match Album" modal: search MusicBrainz for a release by artist + album,
	pick one, then match the whole `CutDraft` against its track list and fill every
	position/title-confidence segment at once. It is a thin wrapper over the PURE
	`metadata.ts` (request builders, `albumMatchActions`, `matchedSegmentCount`);
	the only side-effects are the three injected `MetadataApi` calls (search
	releases → GET release detail → POST match-album), each of which may take ~1s
	under the server-side MB rate limit, so each step shows a loading state.

	The parent renders this only while open (so inputs reset to the draft's
	global artist/album each time). `onapply` receives the cut-plan edits; the
	root folds each over the pure `reduce`. The draft is unchanged during the
	dialog (modal), so the backend's `segmentIndex` references stay aligned.
-->
<script lang="ts">
	import type {
		AlbumMatch,
		AlbumMatchResult,
		CutDraft,
		MetadataResult,
		ReleaseDetail,
	} from "@yt-music/contract";
	import type { MetadataApi } from "../../adapters/metadataApi.js";
	import type { EditAction } from "./logic.js";
	import {
		albumMatchActions,
		buildReleaseSearch,
		matchedSegmentCount,
	} from "./metadata.js";

	interface Props {
		draft: CutDraft;
		api: MetadataApi;
		onapply: (actions: EditAction[]) => void;
		onclose: () => void;
	}

	let { draft, api, onapply, onclose }: Props = $props();

	// Inputs prefilled from the draft's globals (reset each open via parent {#if}).
	// svelte-ignore state_referenced_locally
	// — intentional: capture the initial global value to prefill the search box,
	// not a reactive derived (we don't want edits to reflow the inputs).
	let artistInput = $state(draft.globalArtist);
	// svelte-ignore state_referenced_locally
	let albumInput = $state(draft.globalAlbum);

	// Release-search state.
	let releaseResults = $state<MetadataResult[]>([]);
	let releaseSearching = $state(false);
	let releaseSearchError = $state<string | undefined>(undefined);

	// Selected release + its match.
	let selected = $state<MetadataResult | null>(null);
	let releaseDetail = $state<ReleaseDetail | null>(null);
	let matchResult = $state<AlbumMatchResult | null>(null);
	let matching = $state(false);
	let matchError = $state<string | undefined>(undefined);

	let totalSegments = $derived(draft.segments.length);
	let matchedCount = $derived(matchResult ? matchedSegmentCount(matchResult) : 0);
	let canApply = $derived(matchResult !== null && releaseDetail !== null && !matching);

	async function searchReleases() {
		const req = buildReleaseSearch(albumInput, artistInput, draft.globalAlbum, draft.globalArtist);
		if (!req.query) return;
		releaseSearching = true;
		releaseSearchError = undefined;
		releaseResults = [];
		selected = null;
		releaseDetail = null;
		matchResult = null;
		matchError = undefined;
		try {
			releaseResults = await api.search(req);
		} catch (err) {
			releaseSearchError = err instanceof Error ? err.message : String(err);
		} finally {
			releaseSearching = false;
		}
	}

	// Pick a release → fetch its detail, then match the draft against its tracks.
	async function selectRelease(r: MetadataResult) {
		selected = r;
		releaseDetail = null;
		matchResult = null;
		matchError = undefined;
		matching = true;
		try {
			const detail = await api.release(r.id);
			releaseDetail = detail;
			const result = await api.matchAlbum({ draft, releaseId: r.id });
			matchResult = result;
		} catch (err) {
			matchError = err instanceof Error ? err.message : String(err);
		} finally {
			matching = false;
		}
	}

	function apply() {
		if (!canApply || !releaseDetail || !matchResult) return;
		onapply(albumMatchActions(draft, releaseDetail, matchResult));
		onclose();
	}

	function onBackdropClick() {
		if (!releaseSearching && !matching) onclose();
	}

	// presentation-only (no pure meaning) — confidence → friendly label + tone.
	function confidenceLabel(c: AlbumMatch["confidence"]): string {
		if (c === "position") return "Position";
		if (c === "title") return "Title";
		return "No match";
	}
	function confidenceTone(c: AlbumMatch["confidence"]): string {
		if (c === "position") return "badge-success";
		if (c === "title") return "badge-info";
		return "badge-ghost";
	}

	function onSearchSubmit(e: SubmitEvent) {
		e.preventDefault();
		void searchReleases();
	}
</script>

<div
	class="modal modal-open"
	role="dialog"
	aria-modal="true"
	aria-label="Match album"
>
	<div class="modal-box max-w-2xl">
		<div class="flex items-center justify-between">
			<h3 class="text-lg font-bold">Match album</h3>
			<button
				class="btn btn-ghost btn-xs"
				onclick={onclose}
				disabled={releaseSearching || matching}
				aria-label="Close">✕</button
			>
		</div>
		<p class="mt-1 text-sm text-base-content/60">
			Find a MusicBrainz release and fill every segment whose track matches by position or title.
		</p>

		<!-- release search -->
		<form class="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onsubmit={onSearchSubmit}>
			<label class="form-control">
				<span class="label-text mb-1 text-xs">Artist</span>
				<input
					class="input input-sm"
					value={artistInput}
					oninput={(e) => (artistInput = e.currentTarget.value)}
					placeholder="Artist"
				/>
			</label>
			<label class="form-control">
				<span class="label-text mb-1 text-xs">Album</span>
				<input
					class="input input-sm"
					value={albumInput}
					oninput={(e) => (albumInput = e.currentTarget.value)}
					placeholder="Album"
				/>
			</label>
			<label class="form-control sm:justify-end">
				<span class="label-text mb-1 text-xs text-transparent sm:invisible">go</span>
				<button class="btn btn-sm btn-primary" type="submit" disabled={releaseSearching}>
					{#if releaseSearching}<span class="loading loading-spinner loading-xs"></span>{/if}
					Search
				</button>
			</label>
		</form>

		{#if releaseSearchError}
			<div class="alert alert-error mt-3 py-2 text-sm">
				<span>{releaseSearchError}</span>
			</div>
		{/if}

		<!-- release results -->
		{#if releaseSearching}
			<div class="flex items-center gap-2 py-6 text-base-content/60">
				<span class="loading loading-spinner loading-sm"></span>
				<span class="text-sm">Searching MusicBrainz releases…</span>
			</div>
		{:else if releaseResults.length > 0}
			<div class="mt-3 max-h-52 overflow-y-auto rounded-box border border-base-300">
				<ul class="divide divide-base-300">
					{#each releaseResults as r (r.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center justify-between gap-2 p-2 text-left transition-colors hover:bg-base-200 {selected?.id === r.id
									? 'bg-base-200'
									: ''}"
								onclick={() => void selectRelease(r)}
							>
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{r.title}</p>
									<p class="truncate text-xs text-base-content/60">{r.artist}</p>
								</div>
								<span class="badge badge-sm badge-ghost tabular-nums">{r.score}%</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- match preview -->
		{#if selected}
			<div class="mt-3 rounded-box bg-base-200 p-3">
				{#if matching}
					<div class="flex items-center gap-2 text-sm text-base-content/60">
						<span class="loading loading-spinner loading-xs"></span>
						<span>Fetching release + matching {totalSegments} segments…</span>
					</div>
				{:else if matchError}
					<div class="alert alert-error py-2 text-sm">
						<span>{matchError}</span>
					</div>
				{:else if matchResult}
					<div class="flex flex-wrap items-center justify-between gap-2">
						<p class="text-sm font-medium">
							{matchedCount} of {matchResult.matches.length} segments matched
						</p>
						<span class="text-xs text-base-content/50">
							{totalSegments - matchedCount} left unchanged (no match)
						</span>
					</div>
					<ul class="mt-2 max-h-48 space-y-1 overflow-y-auto">
						{#each matchResult.matches as m (m.segmentIndex)}
							<li class="flex items-center gap-2 text-xs">
								<span class="badge badge-sm {confidenceTone(m.confidence)}">
									{confidenceLabel(m.confidence)}
								</span>
								<span class="truncate text-base-content/60">
									#{draft.segments[m.segmentIndex]?.trackNumber ?? "?"}
									{draft.segments[m.segmentIndex]?.title || "(untitled)"}
								</span>
								<span class="text-base-content/40">→</span>
								<span class="truncate font-medium">{m.track.title}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		<div class="modal-action">
			<button class="btn btn-ghost btn-sm" onclick={onclose} disabled={releaseSearching || matching}>
				Cancel
			</button>
			<button class="btn btn-primary btn-sm" onclick={apply} disabled={!canApply}>
				Apply {matchedCount} match{matchedCount === 1 ? "" : "es"}
			</button>
		</div>
	</div>
	<!-- click the backdrop (not the box) to close -->
	<button
		class="modal-backdrop"
		type="button"
		onclick={onBackdropClick}
		aria-label="Close"></button
	>
</div>
