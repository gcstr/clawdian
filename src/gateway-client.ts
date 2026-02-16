import {
	PROTOCOL_VERSION,
	PLUGIN_VERSION,
	NODE_CAPS,
	NODE_COMMANDS,
	NODE_PERMISSIONS,
	RECONNECT_BASE_MS,
	RECONNECT_MAX_MS,
	REQUEST_TIMEOUT_MS,
} from "./constants";
import { signPayload, buildAuthPayload } from "./crypto";
import type { StoredKeypair } from "./crypto";
import type {
	RequestFrame,
	ResponseFrame,
	EventFrame,
	GatewayFrame,
	ConnectParams,
	HelloOkPayload,
	ChallengePayload,
	NodeInvokeRequest,
	ConnectionState,
	ErrorShape,
	ClawdianSettings,
	ChatEventPayload,
} from "./types";

type Listener<T extends unknown[]> = (...args: T) => void;

interface PendingRequest {
	resolve: (frame: ResponseFrame) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const CHALLENGE_TIMEOUT_MS = 5000;

export function selectGatewayAuthToken(
	settings: ClawdianSettings,
	mode: "node" | "chat"
): string {
	if (settings.authMode !== "token") return "";

	const gatewayToken = settings.gatewayToken.trim();
	const deviceToken = settings.deviceToken.trim();

	if (mode === "node") {
		// Node connections can use the deviceToken (issued after pairing) for convenience.
		return deviceToken || gatewayToken;
	}

	// Chat connections represent an operator UI and typically require operator scopes.
	// In practice the deviceToken issued for the node does not include operator.write,
	// so falling back to deviceToken causes chat.send to fail with missing scope.
	return gatewayToken;
}

export class GatewayClient {
	private getSettings: () => ClawdianSettings;
	private getKeypair: () => StoredKeypair | null;
	private mode: "node" | "chat";
	private ws: WebSocket | null = null;
	private state: ConnectionState = "disconnected";
	private pendingRequests = new Map<string, PendingRequest>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private intentionalClose = false;
	private requestCounter = 0;
	private connectRequestId: string | null = null;
	private challengeNonce: string | null = null;
	private challengeTimer: ReturnType<typeof setTimeout> | null = null;
	private waitingForChallenge = false;

	private listeners = {
		stateChange: [] as Listener<[ConnectionState]>[],
		error: [] as Listener<[ErrorShape | Error]>[],
		deviceToken: [] as Listener<[string]>[],
		invoke: [] as Listener<[NodeInvokeRequest]>[],
		chatEvent: [] as Listener<[ChatEventPayload]>[],
		debugFrame: [] as Listener<[GatewayFrame]>[],
	};

	constructor(
		getSettings: () => ClawdianSettings,
		getKeypair: () => StoredKeypair | null,
		mode: "node" | "chat" = "node"
	) {
		this.getSettings = getSettings;
		this.getKeypair = getKeypair;
		this.mode = mode;
	}

	// --- Public API ---

	get connectionState(): ConnectionState {
		return this.state;
	}

	on<K extends keyof typeof this.listeners>(
		event: K,
		listener: (typeof this.listeners)[K][number]
	): void {
		this.listeners[event].push(listener as never);
	}

	off<K extends keyof typeof this.listeners>(
		event: K,
		listener: (typeof this.listeners)[K][number]
	): void {
		const arr = this.listeners[event];
		const idx = arr.indexOf(listener as never);
		if (idx >= 0) arr.splice(idx, 1);
	}

	connect(): void {
		if (this.ws && this.state !== "disconnected") {
			return;
		}
		this.intentionalClose = false;
		this.doConnect();
	}

	disconnect(): void {
		this.intentionalClose = true;
		this.clearReconnectTimer();
		this.clearChallengeTimer();
		this.cleanup();
		this.setState("disconnected");
	}

	sendInvokeResult(
		id: string,
		nodeId: string,
		ok: boolean,
		payloadJSON?: string,
		error?: { code: string; message: string }
	): void {
		this.sendRequest("node.invoke.result", {
			id,
			nodeId,
			ok,
			...(payloadJSON != null ? { payloadJSON } : {}),
			...(error != null ? { error } : {}),
		}).catch(() => {});
	}

	// --- Chat API ---

	async sendChat(
		sessionKey: string,
		message: string
	): Promise<{ runId: string }> {
		const idempotencyKey = this.nextId();
		const res = await this.sendRequest("chat.send", {
			sessionKey,
			message,
			idempotencyKey,
		});
		if (!res.ok) {
			const errMsg = res.error?.message || "chat.send rejected";
			throw new Error(errMsg);
		}
		const payload = res.payload as { runId?: string } | undefined;
		return { runId: payload?.runId || idempotencyKey };
	}

	async loadHistory(
		sessionKey: string,
		limit?: number
	): Promise<ResponseFrame> {
		return this.sendRequest("chat.history", {
			sessionKey,
			limit: limit ?? 50,
		});
	}

	async listSessions(): Promise<ResponseFrame> {
		return this.sendRequest("sessions.list", {});
	}

	async abortChat(runId: string): Promise<void> {
		await this.sendRequest("chat.abort", { runId });
	}

	// --- Connection Logic ---

	private doConnect(): void {
		const settings = this.getSettings();
		const url = settings.gatewayUrl;

		if (!url) {
			this.emit("error", new Error("Gateway URL not configured"));
			return;
		}

		const keypair = this.getKeypair();
		if (!keypair) {
			this.emit("error", new Error("Device keypair not initialized"));
			return;
		}

		this.setState("connecting");
		this.challengeNonce = null;
		this.waitingForChallenge = true;

		try {
			this.ws = new WebSocket(url);
		} catch (err) {
			this.emit("error", err as Error);
			this.scheduleReconnect();
			return;
		}

		this.ws.onopen = () => {
			// Wait for connect.challenge event before sending connect request.
			// If no challenge arrives within timeout, send connect anyway.
			this.challengeTimer = setTimeout(() => {
				this.challengeTimer = null;
				if (this.waitingForChallenge) {
					this.waitingForChallenge = false;
					this.sendConnectRequest();
				}
			}, CHALLENGE_TIMEOUT_MS);
		};

		this.ws.onmessage = (event) => {
			this.handleMessage(event.data);
		};

		this.ws.onclose = () => {
			this.cleanup();
			if (!this.intentionalClose) {
				this.scheduleReconnect();
			} else {
				this.setState("disconnected");
			}
		};

		this.ws.onerror = () => {
			// onclose will fire after onerror, so reconnect is handled there
		};
	}

	private async sendConnectRequest(): Promise<void> {
		const settings = this.getSettings();
		const keypair = this.getKeypair();
		if (!keypair) return;

		const auth: ConnectParams["auth"] = {};
		const token = selectGatewayAuthToken(settings, this.mode);
		if (settings.authMode === "token" && token) {
			auth.token = token;
		} else if (settings.authMode === "password" && settings.gatewayPassword) {
			auth.password = settings.gatewayPassword;
		}

		// Determine client identity based on connection mode
		const isChat = this.mode === "chat";
		const clientId = isChat ? "webchat" : "node-host";
		const clientMode = isChat ? "ui" : "node";
		const role = isChat ? "operator" : "node";
		const clientDisplayName = settings.deviceName.trim() || "Obsidian";

		// Operator UI (chat) needs read scopes to receive streamed events, and write to send messages.
		const scopes = isChat ? ["operator.read", "operator.write"] : [];

		// Build the auth payload string that the gateway expects
		const signedAt = Date.now();
		const authPayload = buildAuthPayload({
			deviceId: keypair.deviceId,
			clientId,
			clientMode,
			role,
			scopes,
			signedAtMs: signedAt,
			token: auth.token || null,
			nonce: this.challengeNonce || null,
		});

		let signature: string;
		try {
			signature = await signPayload(keypair.privateKey, authPayload);
		} catch (err) {
			this.emit("error", new Error(`Signing failed: ${err}`));
			return;
		}

		const params: Record<string, unknown> = {
			minProtocol: PROTOCOL_VERSION,
			maxProtocol: PROTOCOL_VERSION,
			client: {
				id: clientId,
				version: PLUGIN_VERSION,
				platform: "obsidian",
				mode: clientMode,
				displayName: clientDisplayName,
			},
			role,
			scopes,
			auth,
			device: {
				id: keypair.deviceId,
				publicKey: keypair.publicKey,
				signature,
				signedAt,
				...(this.challengeNonce ? { nonce: this.challengeNonce } : {}),
			},
		};

		// Node-specific fields
		if (!isChat) {
			params.caps = NODE_CAPS;
			params.commands = NODE_COMMANDS;
			params.permissions = NODE_PERMISSIONS;
		}

		this.connectRequestId = this.nextId();
		const frame = {
			type: "req" as const,
			id: this.connectRequestId,
			method: "connect",
			params,
		};
		this.send(frame);
	}

	// --- Message Handling ---

	private handleMessage(data: unknown): void {
		if (typeof data !== "string") return;

		let frame: GatewayFrame;
		try {
			frame = JSON.parse(data);
		} catch {
			return;
		}

		if (!frame || typeof frame !== "object" || !("type" in frame)) {
			return;
		}

		// Optional debug: surface all frames to help diagnose routing/session issues.
		if (this.getSettings().debugLogGatewayFrames) {
			this.emit("debugFrame", frame);
		}

		switch (frame.type) {
			case "res":
				this.handleResponse(frame as ResponseFrame);
				break;
			case "event":
				this.handleEvent(frame as EventFrame);
				break;
			case "req":
				this.handleServerRequest(frame as RequestFrame);
				break;
		}
	}

	private handleResponse(frame: ResponseFrame): void {
		if (frame.id === this.connectRequestId) {
			this.connectRequestId = null;
			if (frame.ok) {
				const payload = frame.payload as HelloOkPayload;
				this.setState("paired");
				this.reconnectAttempt = 0;
				if (payload?.auth?.deviceToken) {
					this.emit("deviceToken", payload.auth.deviceToken);
				}
			} else {
				const err = frame.error || {
					code: "E_CONNECT_FAILED",
					message: "Connection rejected by gateway",
				};
				this.emit("error", err);
				this.intentionalClose = true;
				this.ws?.close();
			}
			return;
		}

		const pending = this.pendingRequests.get(frame.id);
		if (pending) {
			clearTimeout(pending.timer);
			this.pendingRequests.delete(frame.id);
			pending.resolve(frame);
		}
	}

	private handleEvent(frame: EventFrame): void {
		switch (frame.event) {
			case "connect.challenge": {
				const payload = frame.payload as ChallengePayload | undefined;
				if (payload?.nonce) {
					this.challengeNonce = payload.nonce;
				}
				if (this.waitingForChallenge) {
					this.waitingForChallenge = false;
					this.clearChallengeTimer();
					this.sendConnectRequest();
				}
				break;
			}
			case "node.invoke.request":
				if (frame.payload) {
					this.emit("invoke", frame.payload as NodeInvokeRequest);
				}
				break;
			case "chat":
				if (frame.payload) {
					this.emit("chatEvent", frame.payload as ChatEventPayload);
				}
				break;
			default:
				break;
		}
	}

	private handleServerRequest(frame: RequestFrame): void {
		if (frame.method === "node.invoke") {
			const params = frame.params as NodeInvokeRequest | undefined;
			if (params) {
				this.emit("invoke", params);
			}
		}
	}

	// --- Transport ---

	private send(frame: RequestFrame | ResponseFrame): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(frame));
		}
	}

	sendRequest(method: string, params?: unknown): Promise<ResponseFrame> {
		return new Promise((resolve, reject) => {
			const id = this.nextId();
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request ${method} timed out`));
			}, REQUEST_TIMEOUT_MS);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.send({ type: "req", id, method, params });
		});
	}

	// --- Reconnect ---

	private scheduleReconnect(): void {
		if (this.intentionalClose) return;

		this.setState("disconnected");
		const delay = Math.min(
			RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
			RECONNECT_MAX_MS
		);
		this.reconnectAttempt++;

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.doConnect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private clearChallengeTimer(): void {
		if (this.challengeTimer) {
			clearTimeout(this.challengeTimer);
			this.challengeTimer = null;
		}
	}

	// --- Helpers ---

	private cleanup(): void {
		this.clearChallengeTimer();
		this.waitingForChallenge = false;

		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onclose = null;
			this.ws.onerror = null;
			if (
				this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING
			) {
				this.ws.close();
			}
			this.ws = null;
		}

		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Connection closed"));
			this.pendingRequests.delete(id);
		}

		this.connectRequestId = null;
	}

	private setState(newState: ConnectionState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.emit("stateChange", newState);
		}
	}

	private emit<K extends keyof typeof this.listeners>(
		event: K,
		...args: Parameters<(typeof this.listeners)[K][number]>
	): void {
		for (const listener of this.listeners[event]) {
			try {
				(listener as (...a: unknown[]) => void)(...args);
			} catch {}
		}
	}

	private nextId(): string {
		return `clawdian-${++this.requestCounter}-${Date.now()}`;
	}
}
