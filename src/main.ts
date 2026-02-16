import { Plugin, Platform, setIcon } from "obsidian";
import { GatewayClient } from "./gateway-client";
import { ClawdianSettingTab } from "./settings";
import { StatusView, STATUS_VIEW_TYPE } from "./status-view";
import { ActivityLogger, ActivityLogView, ACTIVITY_LOG_VIEW_TYPE } from "./activity-log";
import { CommandDispatcher } from "./commands";
import { ChatModel } from "./chat-model";
import { ChatView, CHAT_VIEW_TYPE } from "./chat-view";
import { DEFAULT_SETTINGS } from "./constants";
import { generateKeypair } from "./crypto";
import type { StoredKeypair } from "./crypto";
import type { ClawdianSettings, ChatMessage } from "./types";

interface PersistedData extends ClawdianSettings {
	keypair?: StoredKeypair;
	chatData?: { sessionKey: string; messages: ChatMessage[] };
}

export default class ClawdianPlugin extends Plugin {
	private logGatewayFrame(mode: "node" | "chat", frame: unknown): void {
		if (!this.settings.debugLogGatewayFrames) return;

		let label = "frame";
		if (frame && typeof frame === "object") {
			const f = frame as Record<string, unknown>;
			if (f.type === "event" && typeof f.event === "string") {
				label = `event:${f.event}`;
			} else if (f.type === "req" && typeof f.method === "string") {
				label = `req:${f.method}`;
			} else if (f.type === "res") {
				label = "res";
			}
		}

		let json = "";
		try {
			json = JSON.stringify(frame);
		} catch {
			json = String(frame);
		}

		// Console is the most reliable place to capture raw protocol frames.
		console.debug(`[clawdian:${mode}] <- ${label}`, frame);

		// Also push a compact entry into the activity log for quick visibility.
		this.activityLogger.log({
			timestamp: Date.now(),
			command: `gateway.${mode}.${label}`,
			argsSummary: json.slice(0, 160),
			details: json,
			ok: true,
			durationMs: 0,
			responseBytes: new TextEncoder().encode(json).byteLength,
		});
	}

	private getDeviceChatSessionKey(): string {
		// Prefix to avoid collisions with reserved keys like "main".
		const raw = (this.settings.deviceName || "obsidian").trim().toLowerCase();
		const slug = raw
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		return `obsidian:${slug || "obsidian"}`;
	}

	private static readonly MIN_CHAT_FONT_SIZE = 10;
	private static readonly MAX_CHAT_FONT_SIZE = 24;

	settings: ClawdianSettings = { ...DEFAULT_SETTINGS };
	keypair: StoredKeypair | null = null;
	gateway: GatewayClient = new GatewayClient(
		() => this.settings,
		() => this.keypair,
		"node"
	);
	chatGateway: GatewayClient = new GatewayClient(
		() => this.settings,
		() => this.keypair,
		"chat"
	);
	activityLogger = new ActivityLogger();
	chatModel = new ChatModel();
	dispatcher: CommandDispatcher | null = null;
	private ribbonIconEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.ensureKeypair();
		this.loadChatData();
		// Force a stable, device-scoped chat session key (derived from device name).
		this.chatModel.sessionKey = this.getDeviceChatSessionKey();
		this.applyChatFontSize();

		if (Platform.isMobile && this.settings.maxFilesScannedPerSearch > 500) {
			this.settings.maxFilesScannedPerSearch = 500;
		}

		// Wire gateway events
		this.gateway.on("deviceToken", async (token) => {
			this.settings.deviceToken = token;
			await this.saveSettings();
		});

		this.gateway.on("debugFrame", (frame) => {
			this.logGatewayFrame("node", frame);
		});

		this.gateway.on("stateChange", (state) => {
			// Auto-connect chat gateway when node gateway pairs
			if (state === "paired" && this.chatGateway.connectionState === "disconnected") {
				this.chatGateway.connect();
			}
			this.updateRibbonIcon();
		});

		this.dispatcher = new CommandDispatcher(this.app, this.settings, this.activityLogger);
		this.gateway.on("invoke", async (request) => {
			const result = await this.dispatcher!.dispatch(request);
			this.gateway.sendInvokeResult(
				request.id,
				request.nodeId,
				result.ok,
				result.payloadJSON,
				result.error
			);
		});

		// Wire chat gateway events
		this.chatGateway.on("chatEvent", (payload) => {
			this.chatModel.handleChatEvent(payload);
		});

		this.chatGateway.on("debugFrame", (frame) => {
			this.logGatewayFrame("chat", frame);
		});

		// Save chat data whenever the model updates (new message, stream complete, etc.)
		this.chatModel.onUpdate(() => {
			if (!this.chatModel.isStreaming()) {
				this.saveChatData();
			}
		});

		this.chatGateway.on("stateChange", (state) => {
			if (state === "paired") {
			} else if (state === "disconnected") {
				// Clear waiting/streaming state if the connection drops
				if (this.chatModel.isWaiting() || this.chatModel.isStreaming()) {
					this.chatModel.handleChatEvent({
						runId: "disconnect",
						sessionKey: this.chatModel.sessionKey,
						seq: 0,
						state: "error",
						errorMessage: "Connection lost",
					});
				}
			}
		});

		// Register views
		this.registerView(
			STATUS_VIEW_TYPE,
			(leaf) => new StatusView(leaf, this)
		);
		this.registerView(
			ACTIVITY_LOG_VIEW_TYPE,
			(leaf) => new ActivityLogView(leaf, this.activityLogger)
		);
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(leaf, this)
		);

		// Register settings tab
		this.addSettingTab(new ClawdianSettingTab(this.app, this));

		// Register commands
		this.addCommand({
			id: "show-status",
			name: "Show status",
			callback: () => this.activateStatusView(),
		});

		this.addCommand({
			id: "show-activity-log",
			name: "Show activity log",
			callback: () => this.activateActivityLogView(),
		});

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => this.activateChatView(),
		});

		this.addCommand({
			id: "connect",
			name: "Connect to gateway",
			callback: () => {
				this.gateway.connect();
				this.chatGateway.connect();
			},
		});

		this.addCommand({
			id: "disconnect",
			name: "Disconnect from gateway",
			callback: () => {
				this.gateway.disconnect();
				this.chatGateway.disconnect();
			},
		});

		// Ribbon icon
		this.ribbonIconEl = this.addRibbonIcon("bot-off", "Clawdian", () => {
			this.activateStatusView();
		});
		this.updateRibbonIcon();

		// Auto-connect
		if (this.settings.autoConnect && this.hasCredentials()) {
			setTimeout(() => {
				this.gateway.connect();
				this.chatGateway.connect();
			}, 1000);
		}
	}

	async onunload(): Promise<void> {
		await this.saveChatData();
		this.gateway.disconnect();
		this.chatGateway.disconnect();
		document.body.style.removeProperty("--clawdian-chat-font-size");
	}

	async loadSettings(): Promise<void> {
		const data: PersistedData | null = await this.loadData();
		if (data) {
			const { keypair, ...settings } = data;
			this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
			this.keypair = keypair || null;
		}
		this.settings.chatFontSize = this.normalizeChatFontSize(this.settings.chatFontSize);
	}

	async saveSettings(): Promise<void> {
		this.settings.chatFontSize = this.normalizeChatFontSize(this.settings.chatFontSize);
		// Preserve existing persisted fields (keypair, chatData) when saving settings
		const existing: PersistedData | null = await this.loadData();
		const data: PersistedData = { ...this.settings };
		if (this.keypair) {
			data.keypair = this.keypair;
		}
		if (existing?.chatData) {
			data.chatData = existing.chatData;
		}
		await this.saveData(data);
		this.applyChatFontSize();
	}

	private normalizeChatFontSize(value: unknown): number {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return DEFAULT_SETTINGS.chatFontSize;
		}
		const rounded = Math.round(value);
		return Math.min(
			ClawdianPlugin.MAX_CHAT_FONT_SIZE,
			Math.max(ClawdianPlugin.MIN_CHAT_FONT_SIZE, rounded)
		);
	}

	private applyChatFontSize(): void {
		document.body.style.setProperty(
			"--clawdian-chat-font-size",
			`${this.settings.chatFontSize}px`
		);
	}

	private updateRibbonIcon(): void {
		if (!this.ribbonIconEl) return;

		const isConnected = this.gateway.connectionState !== "disconnected";
		const icon = isConnected ? "bot-message-square" : "bot-off";
		const label = isConnected ? "Clawdian (connected)" : "Clawdian (disconnected)";

		setIcon(this.ribbonIconEl, icon);
		this.ribbonIconEl.setAttribute("aria-label", label);
		this.ribbonIconEl.title = label;
	}

	private async ensureKeypair(): Promise<void> {
		if (this.keypair && this.keypair.algorithm === "Ed25519") {
			// Valid Ed25519 keypair exists — sync device ID
			this.settings.deviceId = this.keypair.deviceId;
			return;
		}

		this.keypair = await generateKeypair();
		this.settings.deviceId = this.keypair.deviceId;
		await this.saveSettings();
	}

	private loadChatData(): void {
		const data = this.settings as unknown as PersistedData;
		if (!data.chatData) return;

		const persistedMessages = data.chatData.messages ?? [];
		const messages = persistedMessages.filter((message) => !message.id.startsWith("history-"));
		const persistedSessionKey = typeof data.chatData.sessionKey === "string"
			? data.chatData.sessionKey.trim()
			: "";
		const hadOnlyLegacyHistory =
			persistedMessages.length > 0 && messages.length === 0;
		const sessionKey = hadOnlyLegacyHistory ? "" : persistedSessionKey;

		// Restore chat continuity across restarts, except for legacy history-only payloads.
		this.chatModel.loadFrom({ sessionKey, messages });

		// One-time cleanup for transcripts that were backfilled from server history.
		if (
			messages.length !== persistedMessages.length ||
			sessionKey !== (data.chatData.sessionKey ?? "")
		) {
			void this.saveChatData();
		}
	}

	private async saveChatData(): Promise<void> {
		const serialized = this.chatModel.serialize();
		const data: PersistedData = await this.loadData() || { ...this.settings };
		data.chatData = serialized;
		await this.saveData(data);
	}

	private hasCredentials(): boolean {
		const s = this.settings;
		if (!s.gatewayUrl) return false;
		if (s.deviceToken) return true;
		if (s.authMode === "token" && s.gatewayToken) return true;
		if (s.authMode === "password" && s.gatewayPassword) return true;
		return false;
	}

	private async activateChatView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
			this.app.workspace.revealLeaf(leaf);
		}
	}

	private async activateActivityLogView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(ACTIVITY_LOG_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: ACTIVITY_LOG_VIEW_TYPE,
				active: true,
			});
			this.app.workspace.revealLeaf(leaf);
		}
	}

	private async activateStatusView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(STATUS_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: STATUS_VIEW_TYPE,
				active: true,
			});
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
