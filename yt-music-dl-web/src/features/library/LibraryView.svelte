<!--
	src/features/library/LibraryView.svelte — thin component.

	Wires the injected LibraryApi + MetadataApi to the pure view-model: it
	fetches the raw Track[] on mount (GET /api/library), derives display rows via
	toRows (logic.ts), and renders. Rename (PATCH /api/library/:id) edits a
	track's tags inline; the diff is built by the pure `toUpdateRequest`,
	applied optimistically via `updateTrack`, then replaced by the backend's
	authoritative response (which has a NEW id — derived from its path).
	"Organize library" (POST /api/library/organize) bulk-moves every file to
	the current path template and replaces the whole list.

	MusicBrainz metadata search: a "Lookup" button per track opens a sidebar
	(LibraryMetadataSidebar) that searches MusicBrainz and, on click, calls
	PATCH /api/library/:id with the new metadata (reusing the existing rename
	endpoint — the backend handles tag write + file move). A "Match Album"
	button in the header opens a dialog (LibraryMatchAlbumDialog) that batch-
	updates all tracks matched to a release. No business logic here — only
	loading/error/edit/organize/metadata wiring.
-->
<script lang="ts">
	import type { Track, UpdateTrackRequest } from "@yt-music/contract";
	import type { LibraryApi } from "../../adapters/libraryApi.js";
	import type { MetadataApi } from "../../adapters/metadataApi.js";
	import LibraryMatchAlbumDialog from "./LibraryMatchAlbumDialog.svelte";
	import LibraryMetadataSidebar from "./LibraryMetadataSidebar.svelte";
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
		metadataApi: MetadataApi;
	}
	let { api, metadataApi }: Props = $props();

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

	// Metadata sidebar: the currently-selected track (null = panel closed).
	// Clicking "Lookup" on a track selects it; the sidebar recreates via
	// {#key} on track id so its search state resets per track.
	let selectedTrackId = $state<string | null>(null);
	let selectedTrack = $derived(
		selectedTrackId !== null ? (tracks.find((t) => t.id === selectedTrackId) ?? null) : null,
	);

	// "Match Album" modal.
	let matchAlbumOpen = $state(false);

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

	// Apply MusicBrainz metadata to a track via PATCH /api/library/:id (the
	// backend rewrites tags + moves the file). Same optimistic-update pattern
	// as saveEdit: reflect locally, then replace with the authoritative response
	// (new id + path). On success the sidebar closes (selectedTrackId = null);
	// on error the sidebar stays open so the user can try another result.
	async function applyMetadata(req: UpdateTrackRequest): Promise<void> {
		if (selectedTrackId === null) return;
		const oldId = selectedTrackId;
		const prev = tracks.find((t) => t.id === oldId);
		if (!prev) return;
		// Optimistic: reflect the tag edits locally (id + path stay until the
		// backend responds with the moved file's new id + path).
		tracks = tracks.map((t) => (t.id === oldId ? updateTrack(prev, req) : t));
		try {
			const updated = await api.rename(oldId, req);
			const stillThere = tracks.some((t) => t.id === oldId);
			if (stillThere) {
				tracks = tracks.map((t) => (t.id === oldId ? updated : t));
			} else {
				tracks = await api.list();
			}
			// Close the sidebar on success — the track's id changed (moved file).
			selectedTrackId = null;
		} catch (err) {
			// Revert the optimistic update + re-throw so the sidebar shows the error.
			tracks = tracks.map((t) => (t.id === oldId ? prev : t));
			throw err;
		}
	}

	// Batch-apply an album match: sequentially PATCH each matched track. The
	// backend moves files (each PATCH may take a moment), so we do them one at
	// a time to avoid concurrent file-move conflicts. After all PATCHes, refetch
	// the full list (ids may have changed). Throws on the first failure (the
	// dialog shows the error and stays open).
	async function applyMatchAlbum(
		updates: { id: string; request: UpdateTrackRequest }[],
	): Promise<void> {
		for (const { id, request } of updates) {
			await api.rename(id, request);
		}
		tracks = await api.list();
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
					disabled={busy || loading || editingId !== null || matchAlbumOpen}
					onclick={() => (matchAlbumOpen = true)}
				>
					Match album
				</button>
				<button
					class="btn btn-sm btn-outline"
					disabled={busy || loading || editingId !== null || matchAlbumOpen}
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
		{:else}
			<!-- track table + metadata sidebar -->
			<div class="grid gap-4 lg:grid-cols-[1fr_20rem]">
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
											<div class="join">
												<button
													class="btn btn-xs btn-ghost join-item {selectedTrackId === row.id
														? 'text-primary'
														: ''}"
													disabled={editingId !== null || busy || matchAlbumOpen}
													onclick={() => {
														const t = tracks.find((x) => x.id === row.id);
														if (t)
															selectedTrackId = selectedTrackId === row.id ? null : row.id;
													}}
													aria-pressed={selectedTrackId === row.id}
												>
													Lookup
												</button>
												<button
													class="btn btn-xs btn-ghost join-item"
													disabled={editingId !== null || busy || matchAlbumOpen}
													onclick={() => {
														const t = tracks.find((x) => x.id === row.id);
														if (t) startEdit(t);
													}}
												>
													Edit
												</button>
											</div>
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<!-- metadata sidebar (right column) -->
				<div>
					{#if selectedTrack}
						{#key selectedTrack.id}
							<LibraryMetadataSidebar
								track={selectedTrack}
								api={metadataApi}
								onfill={applyMetadata}
								onclose={() => (selectedTrackId = null)}
							/>
						{/key}
					{:else}
						<div
							class="rounded-box border border-dashed border-base-300 p-4 text-center text-sm text-base-content/50"
						>
							Pick <span class="font-medium text-base-content/70">Lookup</span> on a track to search
							MusicBrainz, or use <span class="font-medium text-base-content/70">Match album</span> to fill
							all at once.
						</div>
					{/if}
				</div>
			</div>

			{#if renameError}
				<div class="alert alert-error py-2">
					<span>Couldn't save: {renameError}</span>
				</div>
			{/if}
		{/if}
	</div>
</div>

{#if matchAlbumOpen}
	<LibraryMatchAlbumDialog
		tracks={tracks}
		api={metadataApi}
		onapply={applyMatchAlbum}
		onclose={() => (matchAlbumOpen = false)}
	/>
{/if}
