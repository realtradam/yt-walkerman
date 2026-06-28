<!--
	src/features/segment-editor/SegmentEditor.svelte — thin component.

	A controlled wrapper over the pure edit reducers in ./logic.ts: `draft` is a
	prop (owned by the composition root), every edit is dispatched via `onaction`
	(the root applies `reduce`), and confirm/cancel are surfaced as callbacks. No
	business logic here — display strings come from the pure view-model helpers,
	and the only side-effect is minting ids (`crypto.randomUUID`) for new entities,
	which belongs in the shell, not the pure reducer.

	SponsorBlock skips (Phase 4): the backend's `draft` event delivers
	`RemovedSegmentDraft`s with real `category` values. They render on a
	per-segment timeline bar (positioned by `removedRegions`) + a list row
	showing the category badge + label + time range. Enabled skips are the "will
	be cut" regions (red/dimmed on the bar); toggling dispatches the pure
	`toggleRemovedSegment` reducer. The component never mutates the draft.
-->
<script lang="ts">
	import type { AlbumArtRef, CutDraft, RemovedSegmentDraft } from "@yt-music/contract";
	import type { MetadataApi } from "../../adapters/metadataApi.js";
	import { formatDuration } from "../library/logic.js";
	import MatchAlbumDialog from "./MatchAlbumDialog.svelte";
	import MetadataSidebar from "./MetadataSidebar.svelte";
	import {
		categoryLabel,
		durationLabel,
		formatRange,
		newRemovedSegment,
		newSegment,
		removedDuration,
		removedRegions,
		totalDuration,
		validateDraft,
		type EditAction,
	} from "./logic.js";

	interface Props {
		draft: CutDraft;
		metadataApi: MetadataApi;
		onaction: (action: EditAction) => void;
		onconfirm: () => void;
		oncancel: () => void;
		submitting: boolean;
	}

	let { draft, metadataApi, onaction, onconfirm, oncancel, submitting }: Props = $props();

	let issues = $derived(validateDraft(draft));
	let valid = $derived(issues.length === 0);

	// Metadata sidebar: the currently-selected segment (null = panel closed).
	// Clicking "Lookup" on a segment selects it; the sidebar recreates via
	// {#key} on segment id so its search state resets per segment.
	let selectedSegmentId = $state<string | null>(null);
	let selectedSegment = $derived(
		selectedSegmentId !== null
			? (draft.segments.find((s) => s.id === selectedSegmentId) ?? null)
			: null,
	);
	// "Match Album" modal.
	let matchAlbumOpen = $state(false);

	// Dispatch a batch of cut-plan edits (a sidebar card click or an album match
	// produces several). Each flows through `onaction` so the composition root
	// folds it over the pure `reduce` — no new callback channel needed.
	function applyActions(actions: EditAction[]) {
		for (const action of actions) onaction(action);
	}

	// ── glue helpers (component-local; id minting is a browser effect) ──

	function genId(): string {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			return crypto.randomUUID();
		}
		return `id-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
	}

	function kindLabel(kind: AlbumArtRef["kind"]): string {
		if (kind === "video-thumbnail") return "Thumbnail";
		if (kind === "url") return "URL";
		return "Uploaded";
	}

	function kindToRef(kind: AlbumArtRef["kind"], prev: AlbumArtRef): AlbumArtRef {
		if (kind === "video-thumbnail") return { kind };
		if (kind === "url") return { kind, url: prev.kind === "url" ? prev.url : "" };
		return { kind, uploadId: prev.kind === "uploaded" ? prev.uploadId : "" };
	}

	// daisyUI badge tone per SponsorBlock category (presentation only — no pure
	// meaning). `sponsor` reads red because enabled skips are "what will be cut".
	function categoryTone(category: RemovedSegmentDraft["category"]): string {
		switch (category) {
			case "sponsor":
				return "badge-error";
			case "selfpromo":
			case "music_offtopic":
				return "badge-warning";
			case "interaction":
				return "badge-info";
			case "intro":
			case "outro":
				return "badge-primary";
			case "preview":
				return "badge-accent";
			case "filler":
			case "manual":
				return "badge-ghost";
			default:
				return "badge-ghost";
		}
	}

	// Look up a skip's start/end by uuid to label its bar region (kept here so
	// the bar markup stays declarative). Pure-ish: reads only the draft prop.
	function skipRange(s: { removedSegments: RemovedSegmentDraft[] }, uuid: string): string {
		const r = s.removedSegments.find((x) => x.uuid === uuid);
		return r ? `${formatDuration(r.start)}–${formatDuration(r.end)}` : "";
	}

	function addSegmentDefaults(d: CutDraft): { start: number; end: number } {
		const last = d.segments[d.segments.length - 1];
		let start = last ? last.end : 0;
		let end = Math.min(start + 30, d.sourceDuration);
		if (end <= start) {
			start = Math.max(0, d.sourceDuration - 1);
			end = d.sourceDuration;
		}
		return { start, end };
	}

	function appendSegment() {
		const { start, end } = addSegmentDefaults(draft);
		onaction({
			type: "addSegment",
			segment: newSegment(genId(), start, end, {
				artist: draft.globalArtist,
				album: draft.globalAlbum,
				albumArt: draft.globalAlbumArt,
			}),
		});
	}

	// read a number field from a submitted form by name
	function formNum(e: SubmitEvent, key: string): number | null {
		const f = e.currentTarget;
		if (!(f instanceof HTMLFormElement)) return null;
		const v = new FormData(f).get(key);
		return v === null ? null : Number(v);
	}
</script>

<div class="card bg-base-100 shadow">
	<div class="card-body gap-4">
		<!-- header -->
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 class="card-title text-lg">Edit segments</h2>
				<p class="text-sm text-base-content/60">
					{draft.segments.length} track(s) · {formatDuration(totalDuration(draft))} total audio
				</p>
			</div>
			<div class="flex flex-wrap gap-2">
				<button class="btn btn-ghost btn-sm" onclick={() => (matchAlbumOpen = true)} disabled={submitting}>
					Match album
				</button>
				<button class="btn btn-ghost btn-sm" onclick={oncancel} disabled={submitting}>
					Cancel
				</button>
				<button
					class="btn btn-primary btn-sm"
					onclick={onconfirm}
					disabled={submitting || !valid}
				>
					{#if submitting}<span class="loading loading-spinner loading-xs"></span>{/if}
					Confirm cut
				</button>
			</div>
		</div>

		<!-- validation issues -->
		{#if issues.length > 0}
			<div class="alert alert-warning py-2 text-sm">
				<div>
					<p class="font-medium">{issues.length} issue(s) to fix before confirming:</p>
					<ul class="ml-4 list-disc">
						{#each issues as i}
							<li>{i.message}</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}

		<!-- global album / artist / art -->
		<div class="grid gap-3 rounded-box bg-base-200 p-3 sm:grid-cols-2">
			<label class="form-control">
				<span class="label-text mb-1 text-xs">Global album</span>
				<div class="join">
					<input
						class="input join-item input-sm"
						value={draft.globalAlbum}
						oninput={(e) => onaction({ type: "setGlobalAlbum", album: e.currentTarget.value })}
					/>
					<button
						class="btn join-item btn-sm"
						onclick={() => onaction({ type: "applyGlobalAlbum", album: draft.globalAlbum })}
						>Apply</button
					>
				</div>
			</label>

			<label class="form-control">
				<span class="label-text mb-1 text-xs">Global artist</span>
				<div class="join">
					<input
						class="input join-item input-sm"
						value={draft.globalArtist}
						oninput={(e) => onaction({ type: "setGlobalArtist", artist: e.currentTarget.value })}
					/>
					<button
						class="btn join-item btn-sm"
						onclick={() => onaction({ type: "applyGlobalArtist", artist: draft.globalArtist })}
						>Apply</button
					>
				</div>
			</label>

			<label class="form-control sm:col-span-2">
				<span class="label-text mb-1 text-xs">Global album art</span>
				<div class="flex flex-wrap items-center gap-2">
					<select
						class="select select-sm"
						value={draft.globalAlbumArt.kind}
						onchange={(e) =>
							onaction({
								type: "setGlobalAlbumArt",
								albumArt: kindToRef(
									e.currentTarget.value as AlbumArtRef["kind"],
									draft.globalAlbumArt,
								),
							})}
					>
						<option value="video-thumbnail">Thumbnail</option>
						<option value="url">URL</option>
						<option value="uploaded">Uploaded</option>
					</select>
					{#if draft.globalAlbumArt.kind === "url"}
						<input
							class="input input-sm flex-1"
							value={draft.globalAlbumArt.url}
							oninput={(e) =>
								onaction({ type: "setGlobalAlbumArt", albumArt: { kind: "url", url: e.currentTarget.value } })}
							placeholder="image URL"
						/>
					{:else if draft.globalAlbumArt.kind === "uploaded"}
						<input
							class="input input-sm flex-1"
							value={draft.globalAlbumArt.uploadId}
							oninput={(e) =>
								onaction({
									type: "setGlobalAlbumArt",
									albumArt: { kind: "uploaded", uploadId: e.currentTarget.value },
								})}
							placeholder="upload id (manual)"
						/>
					{/if}
					<button
						class="btn btn-sm"
						onclick={() =>
							onaction({ type: "applyGlobalAlbumArt", albumArt: draft.globalAlbumArt })}
						>Apply</button
					>
					<button class="btn btn-ghost btn-sm" onclick={() => onaction({ type: "applyAllGlobals" })}>
						Apply album + artist + art to all
					</button>
				</div>
			</label>
		</div>

		<!-- segment list + metadata sidebar -->
		<div class="grid gap-4 lg:grid-cols-[1fr_20rem]">
			<div class="space-y-3">
		<!-- segment list -->
		{#each draft.segments as s, i (s.id)}
			<div
				class="rounded-box border p-3 {selectedSegmentId === s.id
					? 'border-primary'
					: 'border-base-300'}"
			>
				<!-- segment header -->
				<div class="flex flex-wrap items-center gap-2">
					<span class="badge badge-lg badge-primary tabular-nums">{s.trackNumber}</span>
					<input
						class="input input-sm flex-1 min-w-[8rem]"
						value={s.title}
						oninput={(e) =>
							onaction({ type: "editSegmentTitle", segmentId: s.id, title: e.currentTarget.value })}
						placeholder="Title"
					/>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onaction({ type: "moveSegment", segmentId: s.id, direction: "up" })}
						disabled={i === 0}>↑</button
					>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onaction({ type: "moveSegment", segmentId: s.id, direction: "down" })}
						disabled={i === draft.segments.length - 1}>↓</button
					>
					<button
						class="btn btn-ghost btn-xs {selectedSegmentId === s.id ? 'text-primary' : ''}"
						onclick={() => (selectedSegmentId = selectedSegmentId === s.id ? null : s.id)}
						aria-pressed={selectedSegmentId === s.id}
						>Lookup</button
					>
					<button
						class="btn btn-ghost btn-xs text-error"
						onclick={() => onaction({ type: "removeSegment", segmentId: s.id })}>Remove</button
					>
				</div>

				<!-- segment fields -->
				<div class="mt-2 grid gap-2 sm:grid-cols-3">
					<label class="form-control">
						<span class="label-text text-xs">Artist</span>
						<input
							class="input input-sm"
							value={s.artist}
							oninput={(e) =>
								onaction({ type: "editSegmentArtist", segmentId: s.id, artist: e.currentTarget.value })}
						/>
					</label>
					<label class="form-control">
						<span class="label-text text-xs">Album</span>
						<input
							class="input input-sm"
							value={s.album}
							oninput={(e) =>
								onaction({ type: "editSegmentAlbum", segmentId: s.id, album: e.currentTarget.value })}
						/>
					</label>
					<label class="form-control">
						<span class="label-text text-xs">Track #</span>
						<input
							class="input input-sm"
							type="number"
							value={s.trackNumber}
							onchange={(e) =>
								onaction({
									type: "editSegmentTrackNumber",
									segmentId: s.id,
									trackNumber: Number(e.currentTarget.value),
								})}
						/>
					</label>
				</div>

				<!-- album art -->
				<label class="form-control mt-2">
					<span class="label-text text-xs">Album art</span>
					<div class="flex flex-wrap items-center gap-2">
						<select
							class="select select-sm"
							value={s.albumArt.kind}
							onchange={(e) =>
								onaction({
									type: "editSegmentAlbumArt",
									segmentId: s.id,
									albumArt: kindToRef(e.currentTarget.value as AlbumArtRef["kind"], s.albumArt),
								})}
						>
							<option value="video-thumbnail">Thumbnail</option>
							<option value="url">URL</option>
							<option value="uploaded">Uploaded</option>
						</select>
						{#if s.albumArt.kind === "url"}
							<input
								class="input input-sm flex-1"
								value={s.albumArt.url}
								oninput={(e) =>
									onaction({
										type: "editSegmentAlbumArt",
										segmentId: s.id,
										albumArt: { kind: "url", url: e.currentTarget.value },
									})}
								placeholder="image URL"
							/>
						{:else if s.albumArt.kind === "uploaded"}
							<input
								class="input input-sm flex-1"
								value={s.albumArt.uploadId}
								oninput={(e) =>
									onaction({
										type: "editSegmentAlbumArt",
										segmentId: s.id,
										albumArt: { kind: "uploaded", uploadId: e.currentTarget.value },
									})}
								placeholder="upload id (manual)"
							/>
						{:else}
							<span class="text-xs text-base-content/50">{kindLabel(s.albumArt.kind)}</span>
						{/if}
					</div>
				</label>

				<!-- time range + trim -->
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<span class="badge badge-ghost tabular-nums">{formatRange(s)}</span>
					<span class="text-xs text-base-content/60">plays {durationLabel(s)}</span>
					<label class="flex items-center gap-1 text-xs">
						start
						<input
							class="input input-xs w-20"
							type="number"
							value={s.start}
							onchange={(e) =>
								onaction({
									type: "trimSegment",
									segmentId: s.id,
									start: Number(e.currentTarget.value),
									end: s.end,
								})}
						/>
					</label>
					<label class="flex items-center gap-1 text-xs">
						end
						<input
							class="input input-xs w-20"
							type="number"
							value={s.end}
							onchange={(e) =>
								onaction({
									type: "trimSegment",
									segmentId: s.id,
									start: s.start,
									end: Number(e.currentTarget.value),
								})}
						/>
					</label>
					<!-- split -->
					<form
						class="flex items-center gap-1"
						onsubmit={(e) => {
							e.preventDefault();
							const at = formNum(e, "at");
							if (at !== null && Number.isFinite(at)) {
								onaction({ type: "splitSegment", segmentId: s.id, at, newSegmentId: genId() });
							}
							const f = e.currentTarget;
							if (f instanceof HTMLFormElement) f.reset();
						}}
					>
						<input class="input input-xs w-24" type="number" name="at" placeholder="split at (s)" />
						<button class="btn btn-ghost btn-xs">Split</button>
					</form>
					<!-- merge with next -->
					<button
						class="btn btn-ghost btn-xs"
						disabled={i === draft.segments.length - 1}
						onclick={() =>
							onaction({ type: "mergeSegments", firstId: s.id, secondId: draft.segments[i + 1]?.id ?? "" })}
						>Merge next</button
					>
				</div>

				<!-- removed (skip) segments — SponsorBlock + manual -->
				<div class="mt-2">
					<p class="text-xs text-base-content/60">
						Skips
						{#if s.removedSegments.length > 0}
							({s.removedSegments.length} · {formatDuration(removedDuration(s))} cut)
						{/if}
					</p>

					{#if s.removedSegments.length > 0}
						<!-- timeline bar: positioned skip regions within this song -->
						<div
							class="relative mt-1 h-5 w-full overflow-hidden rounded bg-base-300/60"
							role="group"
							aria-label="Skip segments on the timeline"
						>
							{#each removedRegions(s) as reg (reg.uuid)}
								<button
									type="button"
									class="absolute inset-y-0 flex items-center justify-center overflow-hidden border-x border-base-100/40 px-0.5 transition-opacity hover:opacity-90 {reg.enabled
										? 'bg-error/70'
										: 'bg-base-content/20 opacity-50'}"
									style="left:{reg.leftPct}%; width:{reg.widthPct}%;"
									title="{categoryLabel(reg.category)} · {reg.label} · {skipRange(s, reg.uuid)} — {reg.enabled
										? 'will cut'
										: 'kept'}"
									aria-pressed={reg.enabled}
									onclick={() =>
										onaction({ type: "toggleRemovedSegment", segmentId: s.id, removedUuid: reg.uuid })}
								>
									<span class="truncate text-[9px] font-medium text-error-content">
										{categoryLabel(reg.category)}
									</span>
								</button>
							{/each}
						</div>

						<ul class="mt-1 space-y-1">
							{#each s.removedSegments as r (r.uuid)}
								<li class="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										class="checkbox checkbox-xs"
										checked={r.enabled}
										onchange={() =>
											onaction({ type: "toggleRemovedSegment", segmentId: s.id, removedUuid: r.uuid })}
									/>
									<span
										class="badge badge-sm {categoryTone(r.category)} {r.enabled
											? ''
											: 'badge-outline opacity-60'}">{categoryLabel(r.category)}</span
									>
									<span class={r.enabled ? "text-error" : "line-through opacity-60"}>{r.label}</span>
									<span class="text-xs text-base-content/50 tabular-nums">
										{formatDuration(r.start)}–{formatDuration(r.end)}
									</span>
									{#if r.enabled}<span class="text-xs text-error/70">will cut</span>{/if}
									<button
										class="btn btn-ghost btn-xs text-error"
										onclick={() =>
											onaction({ type: "removeRemovedSegment", segmentId: s.id, removedUuid: r.uuid })}
										>✕</button
									>
								</li>
							{/each}
						</ul>
					{/if}
					<!-- add skip -->
					<form
						class="mt-1 flex flex-wrap items-center gap-1"
						onsubmit={(e) => {
							e.preventDefault();
							const f = e.currentTarget;
							if (!(f instanceof HTMLFormElement)) return;
							const fd = new FormData(f);
							const start = Number(fd.get("s"));
							const end = Number(fd.get("e"));
							const lbl = String(fd.get("label") ?? "Skip") || "Skip";
							if (Number.isFinite(start) && Number.isFinite(end)) {
								onaction({
									type: "addRemovedSegment",
									segmentId: s.id,
									removed: newRemovedSegment(genId(), start, end, lbl),
								});
							}
							f.reset();
						}}
					>
						<input class="input input-xs w-16" type="number" name="s" placeholder="start" />
						<input class="input input-xs w-16" type="number" name="e" placeholder="end" />
						<input class="input input-xs w-24" name="label" placeholder="label" />
						<button class="btn btn-ghost btn-xs">Add skip</button>
					</form>
				</div>
			</div>
		{/each}

		<button class="btn btn-dashed btn-sm" onclick={appendSegment}>+ Add segment</button>
			</div>

			<!-- metadata sidebar (right column) -->
			<div>
				{#if selectedSegment}
					{#key selectedSegment.id}
						<MetadataSidebar
							segment={selectedSegment}
							globalArtist={draft.globalArtist}
							api={metadataApi}
							onfill={applyActions}
							onclose={() => (selectedSegmentId = null)}
						/>
					{/key}
				{:else}
					<div class="rounded-box border border-dashed border-base-300 p-4 text-center text-sm text-base-content/50">
						Pick <span class="font-medium text-base-content/70">Lookup</span> on a segment to search
						MusicBrainz, or use <span class="font-medium text-base-content/70">Match album</span> to fill all at once.
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

{#if matchAlbumOpen}
	<MatchAlbumDialog
		draft={draft}
		api={metadataApi}
		onapply={applyActions}
		onclose={() => (matchAlbumOpen = false)}
	/>
{/if}
