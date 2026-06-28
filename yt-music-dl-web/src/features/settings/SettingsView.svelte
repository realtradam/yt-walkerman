<!--
	src/features/settings/SettingsView.svelte — thin component.

	Loads settings via the injected SettingsApi (GET /api/settings), routes every
	field edit through the pure `updateField` reducer, and saves via PUT
	/api/settings. A live `previewPath` shows where a file would land under the
	current template. Pure view-model (tokens, isDirty, previewPath) lives in
	logic.ts. No business logic here — only load/save/edit wiring.
-->
<script lang="ts">
	import type { Settings } from "@yt-music/contract";
	import type { SettingsApi } from "../../adapters/settings.js";
	import {
		DEFAULT_PATH_TEMPLATE,
		DEFAULT_PREVIEW_SAMPLE,
		EMPTY_SETTINGS,
		FORMAT_OPTIONS,
		PATH_TEMPLATE_TOKENS,
		isDirty,
		previewPath,
		updateField,
	} from "./logic.js";

	interface Props {
		api: SettingsApi;
	}
	let { api }: Props = $props();

	let original = $state<Settings | null>(null);
	let form = $state<Settings>({ ...EMPTY_SETTINGS });
	let loading = $state(true);
	let error = $state<string | undefined>(undefined);
	let saving = $state(false);
	let savedFlash = $state(false);

	let dirty = $derived(original !== null && isDirty(original, form));
	let canSave = $derived(dirty && !saving);
	let preview = $derived(previewPath(form.pathTemplate, DEFAULT_PREVIEW_SAMPLE));

	$effect(() => {
		const current = api;
		let cancelled = false;
		loading = true;
		error = undefined;
		current
			.fetchSettings()
			.then((s) => {
				if (cancelled) return;
				original = s;
				form = { ...s };
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

	// Clear the "Saved ✓" badge as soon as the user edits the form again.
	$effect(() => {
		if (dirty) savedFlash = false;
	});

	function set(field: "outputDir" | "pathTemplate", value: string) {
		form = updateField(form, field, value);
	}
	function setFormat(value: string) {
		form = updateField(form, "format", value);
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		savedFlash = false;
		try {
			const saved = await api.saveSettings(form);
			original = saved;
			form = { ...saved };
			savedFlash = true;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="card bg-base-100 shadow">
	<div class="card-body gap-3">
		<div class="flex items-center justify-between">
			<h2 class="card-title text-lg">Settings</h2>
			{#if savedFlash}
				<span class="badge badge-success badge-sm">Saved ✓</span>
			{/if}
		</div>

		{#if loading}
			<div class="flex items-center gap-2 text-base-content/60">
				<span class="loading loading-spinner loading-sm"></span>
				<span>Loading settings…</span>
			</div>
		{:else if error}
			<div class="alert alert-error">
				<span>{error}</span>
			</div>
		{:else}
			<label class="form-control">
				<span class="label-text mb-1 text-xs">Output directory</span>
				<input
					class="input input-bordered w-full"
					placeholder="/path/to/music"
					value={form.outputDir}
					oninput={(e) => set("outputDir", e.currentTarget.value)}
				/>
				<span class="label-text-alt mt-1 text-xs text-base-content/50">
					Where downloaded files are written. Takes effect on next backend restart.
				</span>
			</label>

			<label class="form-control">
				<span class="label-text mb-1 text-xs">Default format</span>
				<select
					class="select select-bordered w-full"
					value={form.format}
					onchange={(e) => setFormat(e.currentTarget.value)}
				>
					{#each FORMAT_OPTIONS as f (f)}
						<option value={f}>{f.toUpperCase()}</option>
					{/each}
				</select>
				<span class="label-text-alt mt-1 text-xs text-base-content/50">
					Used for new downloads. Takes effect on next backend restart.
				</span>
			</label>

			<label class="form-control">
				<span class="label-text mb-1 text-xs">Path template</span>
				<input
					class="input input-bordered w-full font-mono text-sm"
					placeholder={DEFAULT_PATH_TEMPLATE}
					value={form.pathTemplate}
					oninput={(e) => set("pathTemplate", e.currentTarget.value)}
				/>
				<span class="label-text-alt mt-1 text-xs text-base-content/50">
					Where files land in the output dir. Takes effect immediately for organize / rename / downloads.
				</span>
				<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-base-content/60">
					{#each PATH_TEMPLATE_TOKENS as tok (tok.token)}
						<span>
							<code class="text-primary">{tok.token}</code>
							<span class="text-base-content/40"> — {tok.description}</span>
						</span>
					{/each}
				</div>
			</label>

			<div class="rounded-box bg-base-200 px-3 py-2">
				<div class="text-xs text-base-content/50">Preview (sample track)</div>
				<code class="block break-all font-mono text-sm text-base-content/80">{preview}</code>
			</div>

			<div class="card-actions justify-end">
				<button class="btn btn-primary" disabled={!canSave} onclick={save}>
					{#if saving}<span class="loading loading-spinner loading-xs"></span>{/if}
					Save
				</button>
			</div>
		{/if}
	</div>
</div>
