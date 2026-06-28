<!--
	src/features/library/LibraryView.svelte — thin component.

	Wires the injected LibraryApi to the pure view-model: it fetches the raw
	Track[] on mount (GET /api/library), derives display rows via toRows
	(logic.ts), and renders. Rename (PATCH /api/library/:id) edits a track's tags
	inline; the diff is built by the pure `toUpdateRequest`, applied optimistically
	via `updateTrack`, then replaced by the backend's authoritative response
	(which has a NEW id — derived from its path). "Organize library"
	(POST /api/library/organize) bulk-moves every file to the current path
	template and replaces the whole list. No business logic here — only
	loading/error/edit/organize wiring.
-->
<script lang="ts">
	import type { Track } from "@yt-music/contract";
	import type { LibraryApi } from "../../adapters/libraryApi.js";
	import {
		hasTrackInputError,
		toRows,
		toTrackEditForm,
		toUpdateRequest,
		updateTrack,
		type TrackEditForm,
		type TrackRow,
	} from "./logic.js";

	interface Props {
		api: LibraryApi;
	}
	let { api }: Props = $props();

	// The component owns the raw Track[] (the source) and derives display rows
	// from it (pure toRows). Holding the raw tracks lets the rename diff build a
	// correct PATCH body against the original.
	let tracks = $state<Track[]>([]);
	let rows = $derived<TrackRow[]>(toRows(tracks));
	let loading = $state(true);
	let error = $state<string | undefined>(undefined);

	// Inline rename state. editingId selects a row; editForm holds the in-progress
	// edits. `renaming` covers the brief window after an optimistic update while
	// the backend response (new id + path) is in flight.
	let editingId = $state<string | null>(null);
	// Always present (a stale/empty form when not editing); `editingId !== null`
	// marks the active edit. Keeping the form non-null avoids nullable-narrowing
	// issues inside event-handler closures.
	let editForm = $state<TrackEditForm>({ title: "", artist: "", album: "", track: "" });
	let renaming = $state(false);
	let renameError = $state<string | undefined>(undefined);

	// "Organize library" state.
	let organizing = $state(false);
	let organizeMessage = $state<string | null>(null);

	// The track currently being edited (looked up from the source list), the
	// computed PATCH body, and derived save-gating flags — all pure downstream of
	// editForm + editingId + tracks.
	let editOriginal = $derived<Track | null>(
		editingId !== null ? tracks.find((t) => t.id === editingId) ?? null : null,
	);
	let editRequest = $derived(
		editOriginal !== null ? toUpdateRequest(editOriginal, editForm) : {},
	);
	let editDirty = $derived(Object.keys(editRequest).length > 0);
	let editTrackError = $derived(editingId !== null && hasTrackInputError(editForm.track));
	let canSave = $derived(editDirty && !editTrackError && !renaming);
	let busy = $derived(renaming || organizing);

	$effect(() => {
		const current = api;
		let cancelled = false;
		loading = true;
		error = undefined;
		current
			.list()
			.then((list) => {
				if (cancelled) return;
				tracks = list;
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	function startEdit(track: Track) {
		editingId = track.id;
		editForm = toTrackEditForm(track);
		renameError = undefined;
	}

	function cancelEdit() {
		editingId = null;
		editForm = { title: "", artist: "", album: "", track: "" };
		renameError = undefined;
	}

	async function saveEdit() {
		if (!canSave || editingId === null) return;
		const oldId = editingId;
		const req = editRequest;
		const prev = tracks.find((t) => t.id === oldId);
		if (!prev) {
			cancelEdit();
			return;
		}
		// Optimistic: reflect the tag edits locally (id + path stay until the
		// backend responds with the moved file's new id + path).
		tracks = tracks.map((t) => (t.id === oldId ? updateTrack(prev, req) : t));
		editingId = null;
		editForm = { title: "", artist: "", album: "", track: "" };
		renameError = undefined;
		renaming = true;
		try {
			const updated = await api.rename(oldId, req);
			// The returned track has a NEW id + path. Replace in place by the old
			// id; if it's gone (e.g. a concurrent organize superseded it), refetch.
			const stillThere = tracks.some((t) => t.id === oldId);
			if (stillThere) {
				tracks = tracks.map((t) => (t.id === oldId ? updated : t));
			} else {
				tracks = await api.list();
			}
		} catch (err) {
			// Revert the optimistic update.
			tracks = tracks.map((t) => (t.id === oldId ? prev : t));
			renameError = err instanceof Error ? err.message : String(err);
		} finally {
			renaming = false;
		}
	}

	async function organize() {
		organizing = true;
		organizeMessage = null;
		error = undefined;
		try {
			const res = await api.organize();
			tracks = res.tracks;
			organizeMessage = `Moved ${res.moved} file(s) to match the path template.`;
			cancelEdit();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			organizing = false;
		}
	}
</script>

<div class="card bg-base-100 shadow">
	<div class="card-body gap-3">
		<div class="flex items-center justify-between">
			<h2 class="card-title text-lg">Library</h2>
			<div class="flex items-center gap-3">
				{#if !loading && !error}
					<span class="text-sm text-base-content/60">{rows.length} track(s)</span>
				{/if}
				<button
					class="btn btn-sm btn-outline"
					disabled={busy || loading || editingId !== null}
					onclick={organize}
				>
					{#if organizing}<span class="loading loading-spinner loading-xs"></span>{/if}
					Organize library
				</button>
			</div>
		</div>

		{#if organizeMessage}
			<div class="alert alert-success py-2">
				<span>{organizeMessage}</span>
			</div>
		{/if}

		{#if loading}
			<div class="flex items-center gap-2 text-base-content/60">
				<span class="loading loading-spinner loading-sm"></span>
				<span>Loading library…</span>
			</div>
		{:else if error}
			<div class="alert alert-error">
				<span>{error}</span>
			</div>
		{:else if rows.length === 0}
			<div class="alert">
				<span>No tracks yet — download something to populate the library.</span>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="table table-zebra">
					<thead>
						<tr>
							<th class="w-12 text-right">#</th>
							<th>Title</th>
							<th>Artist</th>
							<th>Album</th>
							<th class="text-right">Duration</th>
							<th>Format</th>
							<th class="text-right">Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as row (row.id)}
							<tr>
								{#if editingId === row.id}
									<!-- edit mode -->
									<td>
										<input
											class="input input-bordered input-xs w-14 text-center"
											inputmode="numeric"
											placeholder="—"
											value={editForm.track}
											oninput={(e) => (editForm.track = e.currentTarget.value)}
										/>
										{#if editTrackError}
											<div class="mt-0.5 text-xs text-error">whole no. ≥ 1</div>
										{/if}
									</td>
									<td>
										<input
											class="input input-bordered input-sm w-full"
											value={editForm.title}
											oninput={(e) => (editForm.title = e.currentTarget.value)}
										/>
									</td>
									<td>
										<input
											class="input input-bordered input-sm w-full"
											value={editForm.artist}
											oninput={(e) => (editForm.artist = e.currentTarget.value)}
										/>
									</td>
									<td>
										<input
											class="input input-bordered input-sm w-full"
											value={editForm.album}
											oninput={(e) => (editForm.album = e.currentTarget.value)}
										/>
									</td>
									<td class="text-right tabular-nums text-base-content/50">{row.durationLabel}</td>
									<td>
										<span class="badge badge-ghost badge-sm uppercase">{row.format}</span>
									</td>
									<td class="text-right">
										<div class="join">
											<button
												class="btn btn-xs btn-primary join-item"
												disabled={!canSave}
												onclick={saveEdit}
											>
												{#if renaming}<span class="loading loading-spinner loading-xs"></span>{/if}
												Save
											</button>
											<button
												class="btn btn-xs join-item"
												disabled={renaming}
												onclick={cancelEdit}
											>
												Cancel
											</button>
										</div>
									</td>
								{:else}
									<td class="text-right tabular-nums text-base-content/60">{row.trackLabel}</td>
									<td class="font-medium">{row.title}</td>
									<td>{row.artist}</td>
									<td class="text-base-content/70">{row.album}</td>
									<td class="text-right tabular-nums">{row.durationLabel}</td>
									<td>
										<span class="badge badge-ghost badge-sm uppercase">{row.format}</span>
									</td>
									<td class="text-right">
										<button
											class="btn btn-xs btn-ghost"
											disabled={editingId !== null || busy}
											onclick={() => {
												const t = tracks.find((x) => x.id === row.id);
												if (t) startEdit(t);
											}}
										>
											Edit
										</button>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if renameError}
				<div class="alert alert-error py-2">
					<span>Couldn't save: {renameError}</span>
				</div>
			{/if}
		{/if}
	</div>
</div>
