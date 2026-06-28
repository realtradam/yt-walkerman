<script lang="ts">
	// Thin composition: wires feature modules + injected effects. No business
	// logic here — download folds events via logic.ts; library renders via
	// LibraryView over its own pure logic.ts; the segment editor is a thin
	// component over its pure edit reducers (segment-editor/logic.ts).
	import type {
		AudioFormat,
		ConfirmDraftRequest,
		JobEvent,
		JobMode,
		WsServerMessage,
	} from "@yt-music/contract";
	import { createLibraryApi } from "./adapters/libraryApi.js";
	import { createMetadataApi } from "./adapters/metadataApi.js";
	import { createSettingsApi } from "./adapters/settings.js";
	import { createWsClient } from "./adapters/ws.js";
	import { INITIAL, reduce, statusLabel } from "./features/download/logic.js";
	import type { DownloadState } from "./features/download/logic.js";
	import LibraryView from "./features/library/LibraryView.svelte";
	import SegmentEditor from "./features/segment-editor/SegmentEditor.svelte";
	import { reduce as reduceDraft, type EditAction } from "./features/segment-editor/logic.js";
	import SettingsView from "./features/settings/SettingsView.svelte";

	let url = $state("");
	let mode = $state<JobMode>("single");
	let format = $state<AudioFormat>("mp3");
	let dl = $state(INITIAL) as DownloadState;
	let jobId = $state(null as string | null);
	let confirming = $state(false);

	const ws = createWsClient(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
	const libraryApi = createLibraryApi();
	const metadataApi = createMetadataApi();
	const settingsApi = createSettingsApi();

	type View = "download" | "library" | "settings";
	let view = $state<View>("download");

	// Editing is active once the backend delivers a draft and before it is
	// confirmed (status then advances to cutting/done via WS events).
	let editing = $derived(dl.status === "editing" && dl.draft !== null);

	// Set up WS in $effect (runs after mount — avoids circular type inference).
	$effect(() => {
		ws.connect();
		return ws.onMessage((msg: WsServerMessage) => {
			if (msg.type === "event" && msg.jobId === jobId) {
				dl = reduce(dl, msg.event as JobEvent);
			}
		});
	});

	async function startDownload() {
		if (!url.trim()) return;
		dl = { ...INITIAL };
		confirming = false;
		const res = await fetch("/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: url.trim(), mode, format }),
		});
		if (!res.ok) {
			dl = { ...INITIAL, status: "failed", error: `create job failed: ${res.status}` };
			return;
		}
		const data = (await res.json()) as { jobId: string };
		jobId = data.jobId;
		ws.subscribe(data.jobId);
	}

	// Apply one pure edit reducer over the draft (composition root owns state).
	function editDraft(action: EditAction) {
		if (dl.draft) {
			dl.draft = reduceDraft(dl.draft, action);
		}
	}

	// Confirm the user-edited CutDraft → backend derives the CutPlan and cuts.
	async function confirmDraft() {
		if (!dl.draft || !jobId || confirming) return;
		confirming = true;
		try {
			const res = await fetch(`/api/jobs/${jobId}/confirm`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ draft: dl.draft } satisfies ConfirmDraftRequest),
			});
			if (!res.ok) {
				dl = { ...dl, status: "failed", error: `confirm failed: ${res.status}` };
			}
			// success → status advances to cutting via WS events
		} catch (err) {
			dl = { ...dl, status: "failed", error: err instanceof Error ? err.message : String(err) };
		} finally {
			confirming = false;
		}
	}

	function cancelEdit() {
		dl = { ...INITIAL };
		jobId = null;
		confirming = false;
	}
</script>

<main class="min-h-screen bg-base-200 p-8">
	<div class="mx-auto max-w-2xl space-y-6">
		<header>
			<h1 class="text-3xl font-bold text-base-content">yt-music-dl</h1>
			<p class="text-base-content/60">Download YouTube audio for your Walkman</p>
		</header>

		<!-- View switcher -->
		<div role="tablist" class="tabs tabs-boxed">
			<button
				role="tab"
				class="tab"
				class:tab-active={view === "download"}
				onclick={() => (view = "download")}>Download</button
			>
			<button
				role="tab"
				class="tab"
				class:tab-active={view === "library"}
				onclick={() => (view = "library")}>Library</button
			>
			<button
				role="tab"
				class="tab"
				class:tab-active={view === "settings"}
				onclick={() => (view = "settings")}>Settings</button
			>
		</div>

		{#if view === "download"}
			<!-- Download form -->
			<div class="card bg-base-100 shadow">
				<div class="card-body gap-3">
					<div class="join w-full">
						<input
							class="input join-item flex-1"
							placeholder="Paste a YouTube URL…"
							value={url}
							oninput={(e) => (url = e.currentTarget.value)}
							onkeydown={(e) => e.key === "Enter" && startDownload()}
						/>
						<button class="btn btn-primary join-item" onclick={startDownload}>
							Download
						</button>
					</div>

					<div class="flex gap-3">
						<label class="form-control flex-1">
							<span class="label-text mb-1 text-xs">Mode</span>
							<select
								class="select select-sm"
								value={mode}
								onchange={(e) => (mode = e.currentTarget.value as JobMode)}
							>
								<option value="single">Single track</option>
								<option value="split-by-chapters">Split by chapters</option>
							</select>
						</label>
						<label class="form-control flex-1">
							<span class="label-text mb-1 text-xs">Format</span>
							<select
								class="select select-sm"
								value={format}
								onchange={(e) => (format = e.currentTarget.value as AudioFormat)}
							>
								<option value="mp3">MP3</option>
								<option value="flac">FLAC</option>
							</select>
						</label>
					</div>
				</div>
			</div>

			<!-- Segment editor (split-by-chapters editing phase) -->
			{#if editing && dl.draft}
				<SegmentEditor
					draft={dl.draft}
					metadataApi={metadataApi}
					onaction={editDraft}
					onconfirm={confirmDraft}
					oncancel={cancelEdit}
					submitting={confirming}
				/>
			{/if}

			<!-- Live progress -->
			{#if jobId && !editing}
				<div class="card bg-base-100 shadow">
					<div class="card-body gap-3">
						<div class="flex items-center justify-between">
							<h2 class="card-title text-lg">{dl.title || "Fetching…"}</h2>
							<span class="badge badge-lg" data-status={dl.status}>
								{statusLabel(dl.status)}
							</span>
						</div>

						{#if dl.status === "downloading" || dl.status === "cutting"}
							<progress
								class="progress progress-primary w-full"
								value={dl.pct}
								max="100"
							></progress>
							<div class="flex justify-between text-sm text-base-content/60">
								<span>{dl.pct.toFixed(1)}%</span>
								<span>{dl.speed}</span>
								<span>ETA: {dl.eta}</span>
							</div>
						{/if}

						{#if dl.status === "done"}
							<div class="alert alert-success">
								<span>Downloaded {dl.files.length} file(s)</span>
							</div>
							<ul class="text-sm text-base-content/70">
								{#each dl.files as f}
									<li class="font-mono">{f}</li>
								{/each}
							</ul>
						{/if}

						{#if dl.status === "failed"}
							<div class="alert alert-error">
								<span>{dl.error}</span>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		{:else if view === "library"}
			<LibraryView api={libraryApi} metadataApi={metadataApi} />
		{:else if view === "settings"}
			<SettingsView api={settingsApi} />
		{/if}
	</div>
</main>
