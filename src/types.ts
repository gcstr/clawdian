// --- Protocol Frame Types ---

export interface RequestFrame {
	type: "req";
	id: string;
	method: string;
	params?: unknown;
}

export interface ResponseFrame {
	type: "res";
	id: string;
	ok: boolean;
	payload?: unknown;
	error?: ErrorShape;
}

export interface EventFrame {
	type: "event";
	event: string;
	payload?: unknown;
	seq?: number;
	stateVersion?: unknown;
}

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

export interface ErrorShape {
	code: string;
	message: string;
	details?: unknown;
	retryable?: boolean;
	retryAfterMs?: number;
}

// --- Connect Handshake ---

export interface ClientInfo {
	id: string;
	version: string;
	platform: string;
	mode: string;
	displayName?: string;
}

export interface DeviceInfo {
	id: string;
	publicKey: string;
	signature: string;
	signedAt: number;
	nonce?: string;
}

export interface ChallengePayload {
	nonce: string;
	ts: number;
}

export interface ConnectParams {
	minProtocol: number;
	maxProtocol: number;
	client: ClientInfo;
	role: "node";
	scopes: string[];
	caps: string[];
	commands: string[];
	permissions: Record<string, boolean>;
	auth: { token?: string; password?: string };
	locale?: string;
	userAgent?: string;
	device: DeviceInfo;
}

export interface HelloOkPayload {
	type: "hello-ok";
	protocol: number;
	policy: { tickIntervalMs: number };
	auth?: {
		deviceToken: string;
		role: string;
		scopes: string[];
	};
}

// --- Node Invoke (stubs for M2) ---

export interface NodeInvokeRequest {
	id: string;
	nodeId: string;
	command: string;
	paramsJSON?: string;
	idempotencyKey?: string;
	timeoutMs?: number;
}

export interface NodeInvokeResult {
	id: string;
	nodeId: string;
	ok: boolean;
	payloadJSON?: string;
	error?: { code: string; message: string };
}

// --- Plugin Settings ---

export interface ClawdianSettings {
	gatewayUrl: string;
	authMode: "token" | "password";
	gatewayToken: string;
	gatewayPassword: string;
	deviceToken: string;
	deviceName: string;
	deviceId: string;
	maxReadBytes: number;
	maxSearchResults: number;
	maxResponseBytes: number;
	maxFilesScannedPerSearch: number;
	writesEnabled: boolean;
	autoConnect: boolean;
	chatFontSize: number;
	chatSystemPrompt: string;
}

// --- Chat ---

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface ChatDeltaPayload {
	runId: string;
	sessionKey: string;
	seq: number;
	state: "delta";
	message: {
		role: "assistant";
		content: Array<{ type: string; text: string }>;
		timestamp: number;
	};
}

export interface ChatFinalPayload {
	runId: string;
	sessionKey: string;
	seq: number;
	state: "final";
	message?: {
		role: "assistant";
		content: Array<{ type: string; text: string }>;
		timestamp: number;
	};
}

export interface ChatErrorPayload {
	runId: string;
	sessionKey: string;
	seq: number;
	state: "error";
	errorMessage?: string;
}

export type ChatEventPayload = ChatDeltaPayload | ChatFinalPayload | ChatErrorPayload;

// --- Gateway Client State ---

export type ConnectionState = "disconnected" | "connecting" | "connected" | "paired";

export interface GatewayClientEvents {
	stateChange: (state: ConnectionState) => void;
	error: (error: ErrorShape | Error) => void;
	deviceToken: (token: string) => void;
	invoke: (request: NodeInvokeRequest) => void;
}
