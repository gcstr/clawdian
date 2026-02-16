import test from "node:test";
import assert from "node:assert/strict";
import { GatewayClient, selectGatewayAuthToken } from "../src/gateway-client.ts";

function createClient() {
	const settings = {
		gatewayUrl: "wss://example.test",
		authMode: "token" as const,
		gatewayToken: "token",
		gatewayPassword: "",
		deviceToken: "",
		deviceName: "Obsidian",
		deviceId: "device-id",
		maxReadBytes: 250_000,
		maxSearchResults: 20,
		maxResponseBytes: 500_000,
		maxFilesScannedPerSearch: 2_000,
		writesEnabled: true,
		autoConnect: true,
		chatSystemPrompt: "system prompt",
	};

	const keypair = {
		publicKey: "pub",
		privateKey: "priv",
		deviceId: "device-id",
		algorithm: "Ed25519" as const,
	};

	return new GatewayClient(() => settings, () => keypair, "node");
}

test("handleMessage ignores non-JSON frames", () => {
	const client = createClient() as unknown as { handleMessage: (data: unknown) => void };
	assert.doesNotThrow(() => {
		client.handleMessage("not-json");
	});
});

test("sendRequest promise resolves when matching response frame arrives", async () => {
	const client = createClient() as unknown as {
		ws: { readyState: number; send: (frame: string) => void };
		handleMessage: (data: unknown) => void;
		sendRequest: (method: string, params?: unknown) => Promise<{ ok: boolean; payload?: unknown }>;
	};

	const sentFrames: Array<{ id: string }> = [];
	client.ws = {
		readyState: WebSocket.OPEN,
		send(frame: string) {
			sentFrames.push(JSON.parse(frame) as { id: string });
		},
	};

	const pending = client.sendRequest("test.method", { value: 1 });
	assert.equal(sentFrames.length, 1);

	client.handleMessage(JSON.stringify({
		type: "res",
		id: sentFrames[0].id,
		ok: true,
		payload: { accepted: true },
	}));

	const response = await pending;
	assert.equal(response.ok, true);
	assert.deepEqual(response.payload, { accepted: true });
});

test("connect.challenge event stores nonce and triggers connect request", async () => {
	const client = createClient() as unknown as {
		waitingForChallenge: boolean;
		challengeNonce: string | null;
		sendConnectRequest: () => Promise<void>;
		handleMessage: (data: unknown) => void;
	};

	let connectCalls = 0;
	client.waitingForChallenge = true;
	client.sendConnectRequest = async () => {
		connectCalls++;
	};

	client.handleMessage(JSON.stringify({
		type: "event",
		event: "connect.challenge",
		payload: {
			nonce: "nonce-123",
			ts: Date.now(),
		},
	}));

	assert.equal(client.challengeNonce, "nonce-123");
	assert.equal(client.waitingForChallenge, false);
	assert.equal(connectCalls, 1);
});

test("selectGatewayAuthToken (chat) prefers gatewayToken when present", () => {
	const token = selectGatewayAuthToken({
		gatewayUrl: "wss://example.test",
		authMode: "token",
		gatewayToken: "gateway-token",
		gatewayPassword: "",
		deviceToken: "device-token",
		deviceName: "Obsidian",
		deviceId: "device-id",
		maxReadBytes: 250_000,
		maxSearchResults: 20,
		maxResponseBytes: 500_000,
		maxFilesScannedPerSearch: 2_000,
		writesEnabled: true,
		autoConnect: true,
		chatFontSize: 13,
		chatSystemPrompt: "system prompt",
	}, "chat");

	assert.equal(token, "gateway-token");
});

test("selectGatewayAuthToken (node) prefers deviceToken when present", () => {
	const token = selectGatewayAuthToken({
		gatewayUrl: "wss://example.test",
		authMode: "token",
		gatewayToken: "gateway-token",
		gatewayPassword: "",
		deviceToken: "device-token",
		deviceName: "Obsidian",
		deviceId: "device-id",
		maxReadBytes: 250_000,
		maxSearchResults: 20,
		maxResponseBytes: 500_000,
		maxFilesScannedPerSearch: 2_000,
		writesEnabled: true,
		autoConnect: true,
		chatFontSize: 13,
		chatSystemPrompt: "system prompt",
	}, "node");

	assert.equal(token, "device-token");
});

test("selectGatewayAuthToken trims and falls back based on mode", () => {
	const chatToken = selectGatewayAuthToken({
		gatewayUrl: "wss://example.test",
		authMode: "token",
		gatewayToken: "   ",
		gatewayPassword: "",
		deviceToken: "  device-token  ",
		deviceName: "Obsidian",
		deviceId: "device-id",
		maxReadBytes: 250_000,
		maxSearchResults: 20,
		maxResponseBytes: 500_000,
		maxFilesScannedPerSearch: 2_000,
		writesEnabled: true,
		autoConnect: true,
		chatFontSize: 13,
		chatSystemPrompt: "system prompt",
	}, "chat");

	// Chat must not fall back to deviceToken; it usually lacks operator.write.
	assert.equal(chatToken, "");

	const nodeToken = selectGatewayAuthToken({
		gatewayUrl: "wss://example.test",
		authMode: "token",
		gatewayToken: "   ",
		gatewayPassword: "",
		deviceToken: "  device-token  ",
		deviceName: "Obsidian",
		deviceId: "device-id",
		maxReadBytes: 250_000,
		maxSearchResults: 20,
		maxResponseBytes: 500_000,
		maxFilesScannedPerSearch: 2_000,
		writesEnabled: true,
		autoConnect: true,
		chatFontSize: 13,
		chatSystemPrompt: "system prompt",
	}, "node");

	assert.equal(nodeToken, "device-token");
});
