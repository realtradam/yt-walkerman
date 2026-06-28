/**
 * src/adapters/ws.ts — injected browser effect: WebSocket client.
 *
 * Connects to `/ws` (same origin — the Vite proxy forwards to the backend).
 * Exposes a typed subscribe/unsubscribe API + an async iterable of server
 * messages. The pure download-status reducer consumes these; this holds no
 * business logic.
 */
import type { JobId, WsServerMessage } from "@yt-music/contract";

export interface WsClient {
	connect(): void;
	subscribe(jobId: JobId): void;
	unsubscribe(jobId: JobId): void;
	onMessage(cb: (msg: WsServerMessage) => void): () => void;
	close(): void;
}

export function createWsClient(wsUrl: string): WsClient {
	let ws: WebSocket | null = null;
	const listeners = new Set<(msg: WsServerMessage) => void>();

	return {
		connect() {
			ws = new WebSocket(wsUrl);
			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(ev.data as string) as WsServerMessage;
					for (const cb of listeners) cb(msg);
				} catch {
					// ignore malformed
				}
			};
		},
		subscribe(jobId) {
			ws?.send(JSON.stringify({ type: "subscribe", jobId }));
		},
		unsubscribe(jobId) {
			ws?.send(JSON.stringify({ type: "unsubscribe", jobId }));
		},
		onMessage(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		close() {
			ws?.close();
			ws = null;
		},
	};
}
