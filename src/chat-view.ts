import { ItemView, MarkdownRenderer, MarkdownView, WorkspaceLeaf, setIcon } from "obsidian";
import type ClawdianPlugin from "./main";
import type { ChatEventPayload, ChatMessage, ConnectionState, ErrorShape } from "./types";

export const CHAT_VIEW_TYPE = "clawdian-chat";

export class ChatView extends ItemView {
	private activeModelTextEl: HTMLElement | null = null;
	private activeModelRef: string | null = null;
	private activeThinkingLevel: string | null = null;
	private isLoadingActiveModel = false;
	private activeModelRefreshId = 0;
	private messagesContainer: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private streamingEl: HTMLElement | null = null;
	private renderGeneration = 0;
	private lastChatError: string | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ClawdianPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Clawdian Chat";
	}

	getIcon(): string {
		return "message-circle";
	}

	async onOpen(): Promise<void> {
		this.plugin.chatModel.onUpdate(this.onModelUpdate);
		this.plugin.chatGateway.on("stateChange", this.onStateChange);
		this.plugin.chatGateway.on("chatEvent", this.onChatEvent);
		this.plugin.chatGateway.on("error", this.onGatewayError);
		this.buildUI();
		this.renderMessages();
		void this.refreshActiveModelRef();
	}

	async onClose(): Promise<void> {
		this.plugin.chatModel.offUpdate(this.onModelUpdate);
		this.plugin.chatGateway.off("stateChange", this.onStateChange);
		this.plugin.chatGateway.off("chatEvent", this.onChatEvent);
		this.plugin.chatGateway.off("error", this.onGatewayError);
	}

	private onModelUpdate = (): void => {
		this.renderMessages();
	};

	private onStateChange = (_state: ConnectionState): void => {
		if (_state === "paired") {
			this.lastChatError = null;
			void this.refreshActiveModelRef();
		} else {
			this.activeModelRef = null;
			this.activeThinkingLevel = null;
			this.isLoadingActiveModel = false;
			this.renderActiveModelLine();
		}
		this.updateConnectionStatus();
	};

	private onChatEvent = (payload: ChatEventPayload): void => {
		if (payload.state === "final") {
			void this.refreshActiveModelRef();
		}
	};

	private onGatewayError = (error: ErrorShape | Error): void => {
		this.lastChatError = "message" in error ? error.message : String(error);
		this.updateConnectionStatus();
	};

	// --- UI Construction ---

	private buildUI(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("clawdian-chat-view");

		// Header
		const header = container.createDiv({ cls: "clawdian-chat-header" });
		header.createEl("h4", { text: "Clawdian" });

		const headerActions = header.createDiv({ cls: "clawdian-chat-header-actions" });
		const newBtn = headerActions.createEl("button", {
			cls: "clawdian-chat-new-btn",
		});
		newBtn.ariaLabel = "New chat";
		newBtn.title = "New";
		setIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => {
			void this.newConversation();
		});

		this.activeModelTextEl = container.createDiv({ cls: "clawdian-chat-model-line" });
		this.renderActiveModelLine();

		// Connection status
		container.createDiv({ cls: "clawdian-chat-status" });
		this.updateConnectionStatus();

		// Messages area
		this.messagesContainer = container.createDiv({ cls: "clawdian-chat-messages" });

		// Input area
		const inputRow = container.createDiv({ cls: "clawdian-chat-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "clawdian-chat-input",
			attr: { placeholder: "Type a message...", rows: "3" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});


		// Hint line
		container.createDiv({
			cls: "clawdian-chat-input-hint",
			text: "Press Enter to send • Shift+Enter for a new line",
		});

	}

	private updateConnectionStatus(): void {
		const statusEl = this.contentEl.querySelector(".clawdian-chat-status");
		if (!statusEl) return;
		statusEl.empty();

		const state = this.plugin.chatGateway.connectionState;
		if (state !== "paired") {
			const el = statusEl as HTMLElement;
			el.createEl("span", {
				text: state === "disconnected"
					? "Chat not connected."
					: "Connecting...",
				cls: "clawdian-chat-status-text",
			});
			if (state === "disconnected") {
				const btn = el.createEl("button", {
					text: "Connect",
					cls: "clawdian-chat-connect-btn",
				});
				btn.addEventListener("click", () => {
					this.plugin.chatGateway.connect();
				});
			}
			if (this.lastChatError) {
				el.createDiv({
					text: `Last chat error: ${this.lastChatError}`,
					cls: "clawdian-chat-status-error",
				});
			}
		}
	}

	// --- Message Rendering ---

	private async renderMessages(): Promise<void> {
		if (!this.messagesContainer) return;

		const gen = ++this.renderGeneration;
		this.messagesContainer.empty();

		const messages = this.plugin.chatModel.getMessages();

		const isWaiting = this.plugin.chatModel.isWaiting();
		const isStreaming = this.plugin.chatModel.isStreaming();

		if (messages.length === 0 && !isStreaming && !isWaiting) {
			this.messagesContainer.createEl("p", {
				text: "Start a conversation with the OpenClaw agent.",
				cls: "clawdian-chat-empty",
			});
			return;
		}

		for (const msg of messages) {
			if (gen !== this.renderGeneration) return;
			await this.renderMessage(msg);
		}

		if (gen !== this.renderGeneration) return;

		// Render waiting/streaming indicators
		if (isWaiting && !isStreaming) {
			const waitingEl = this.messagesContainer.createDiv({
				cls: "clawdian-chat-message clawdian-chat-assistant",
			});
			waitingEl.createDiv({ cls: "clawdian-chat-role", text: "Agent" });
			waitingEl.createDiv({
				cls: "clawdian-chat-body clawdian-chat-thinking",
			}).createSpan({ cls: "clawdian-spinner" });
		} else if (isStreaming) {
			const streamingContent = this.plugin.chatModel.getStreamingContent();
			if (streamingContent) {
				this.streamingEl = this.messagesContainer.createDiv({
					cls: "clawdian-chat-message clawdian-chat-assistant",
				});
				this.streamingEl.createDiv({ cls: "clawdian-chat-role", text: "Agent" });
				const bodyEl = this.streamingEl.createDiv({ cls: "clawdian-chat-body" });
				MarkdownRenderer.render(
					this.app,
					streamingContent,
					bodyEl,
					"",
					this
				);
				// Add streaming cursor
				this.streamingEl.createSpan({ cls: "clawdian-streaming-cursor" });
			} else {
				const thinkingEl = this.messagesContainer.createDiv({
					cls: "clawdian-chat-message clawdian-chat-assistant",
				});
				thinkingEl.createDiv({ cls: "clawdian-chat-role", text: "Agent" });
				thinkingEl.createDiv({
					cls: "clawdian-chat-body clawdian-chat-thinking",
				}).createSpan({ cls: "clawdian-spinner" });
			}
		}

		// Auto-scroll to bottom
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	private async renderMessage(msg: ChatMessage): Promise<void> {
		if (!this.messagesContainer) return;

		const isUser = msg.role === "user";
		const msgEl = this.messagesContainer.createDiv({
			cls: `clawdian-chat-message ${isUser ? "clawdian-chat-user" : "clawdian-chat-assistant"}`,
		});

		msgEl.createDiv({
			cls: "clawdian-chat-role",
			text: isUser ? "You" : "Agent",
		});

		const bodyEl = msgEl.createDiv({ cls: "clawdian-chat-body" });

		// Render both user and assistant messages as Markdown so formatting is preserved.
		// (User messages are rendered without extra code-block actions.)
		await MarkdownRenderer.render(
			this.app,
			msg.content,
			bodyEl,
			"",
			this
		);

		if (!isUser) {
			this.addCodeBlockActions(bodyEl);
		}
	}

	private addCodeBlockActions(bodyEl: HTMLElement): void {
		const codeBlocks = bodyEl.querySelectorAll("pre > code");
		for (const code of Array.from(codeBlocks)) {
			const pre = code.parentElement;
			if (!pre) continue;

			// Make pre position relative for absolute button positioning
			pre.addClass("clawdian-code-block");

			const actions = pre.createDiv({ cls: "clawdian-code-actions" });
			const copyBtn = actions.createEl("button", {
				cls: "clawdian-code-action-btn",
			});
			copyBtn.ariaLabel = "Copy code";
			copyBtn.title = "Copy";
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", () => {
				navigator.clipboard.writeText(code.textContent || "");
				setIcon(copyBtn, "check");
				copyBtn.title = "Copied";
				setTimeout(() => {
					setIcon(copyBtn, "copy");
					copyBtn.title = "Copy";
				}, 1200);
			});

			if (!this.plugin.settings.writesEnabled) continue;

			const insertBtn = actions.createEl("button", {
				cls: "clawdian-code-action-btn",
			});
			insertBtn.ariaLabel = "Insert into editor";
			insertBtn.title = "Insert";
			setIcon(insertBtn, "arrow-down-to-line");
			insertBtn.addEventListener("click", () => {
				const view = this.getBestMarkdownView();
				if (!view) {
					setIcon(insertBtn, "x");
					insertBtn.title = "No editor";
					setTimeout(() => {
						setIcon(insertBtn, "arrow-down-to-line");
						insertBtn.title = "Insert";
					}, 1200);
					return;
				}
				const cursor = view.editor.getCursor();
				view.editor.replaceRange(code.textContent || "", cursor);
				setIcon(insertBtn, "check");
				insertBtn.title = "Inserted";
				setTimeout(() => {
					setIcon(insertBtn, "arrow-down-to-line");
					insertBtn.title = "Insert";
				}, 1200);
			});
		}
	}

	// --- Actions ---

	private async sendMessage(): Promise<void> {
		if (!this.inputEl) return;

		const text = this.inputEl.value.trim();
		if (!text) return;

		if (this.plugin.chatGateway.connectionState !== "paired") {
			return;
		}

		// Send the user message *as-is* (no mode line, no system prompt injection, no extra context).
		// This is useful for debugging and for users who want full control over prompting.
		const fullMessage = text;

		// Ensure we have a session key
		if (!this.plugin.chatModel.sessionKey) {
			this.plugin.chatModel.sessionKey = this.createSessionKey();
		}

		// Add user message to model
		this.plugin.chatModel.addUserMessage(text);
		this.inputEl.value = "";

		// Send to gateway
		this.plugin.chatModel.setWaiting(true);
		try {
			await this.plugin.chatGateway.sendChat(
				this.plugin.chatModel.sessionKey,
				fullMessage
			);
			void this.refreshActiveModelRef();
		} catch (err) {
			// Show error in chat
			this.plugin.chatModel.handleChatEvent({
				runId: "local-error",
				sessionKey: this.plugin.chatModel.sessionKey,
				seq: 0,
				state: "error",
				errorMessage: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
			});
		}

	}

	private async newConversation(): Promise<void> {
		// In OpenClaw, "/new" resets the session transcript while keeping the same session key.
		// Clearing the session key here would create a *new* session on the next send.
		const sessionKey = this.plugin.chatModel.sessionKey || this.createSessionKey();
		const canResetRemotely = Boolean(sessionKey) && this.plugin.chatGateway.connectionState === "paired";

		if (canResetRemotely) {
			try {
				// Treat this as a control action; don’t add it to the local transcript.
				await this.plugin.chatGateway.sendChat(sessionKey, "/new");
			} catch (err) {
				this.lastChatError = `Failed to reset session: ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		this.plugin.chatModel.clear();
		this.plugin.chatModel.sessionKey = sessionKey;
		this.activeModelRef = null;
		this.activeThinkingLevel = null;
		this.renderActiveModelLine();		this.renderMessages();
		this.updateConnectionStatus();
	}

	private createSessionKey(): string {
		// Stable per-device session key (so this node always chats in the same session).
		// Prefix to avoid collisions with reserved keys like "main".
		const raw = (this.plugin.settings.deviceName || "obsidian").trim().toLowerCase();
		const slug = raw
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "");
		return `obsidian:${slug || "obsidian"}`;
	}

	private getBestMarkdownView(): MarkdownView | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			return activeView;
		}

		const recentLeaf = this.app.workspace.getMostRecentLeaf();
		if (recentLeaf?.view instanceof MarkdownView) {
			return recentLeaf.view;
		}

		let fallback: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!fallback && leaf.view instanceof MarkdownView) {
				fallback = leaf.view;
			}
		});
		return fallback;
	}

	private getSystemPrompt(): string {
		const customPrompt = this.plugin.settings.chatSystemPrompt?.trim();
		return customPrompt || DEFAULT_CHAT_SYSTEM_PROMPT;
	}

	private renderActiveModelLine(): void {
		if (!this.activeModelTextEl) return;
		if (this.plugin.chatGateway.connectionState !== "paired") {
			this.activeModelTextEl.setText("Model: (not connected)");
			return;
		}
		if (this.isLoadingActiveModel) {
			this.activeModelTextEl.setText("Model: (loading...)");
			return;
		}
		this.activeModelTextEl.setText(
			`Model: ${this.activeModelRef ?? "(unknown)"} • Thinking: ${this.activeThinkingLevel ?? "default"}`
		);
	}

	private async refreshActiveModelRef(): Promise<void> {
		if (this.plugin.chatGateway.connectionState !== "paired") {
			this.activeModelRef = null;
			this.isLoadingActiveModel = false;
			this.renderActiveModelLine();
			return;
		}

		const refreshId = ++this.activeModelRefreshId;
		this.isLoadingActiveModel = true;
		this.renderActiveModelLine();

		try {
			const details = await this.fetchActiveSessionDetails(this.plugin.chatModel.sessionKey);
			if (refreshId !== this.activeModelRefreshId) return;
			this.activeModelRef = details.modelRef;
			this.activeThinkingLevel = details.thinkingLevel;
		} catch {
			if (refreshId !== this.activeModelRefreshId) return;
			this.activeModelRef = null;
			this.activeThinkingLevel = null;
		} finally {
			if (refreshId !== this.activeModelRefreshId) return;
			this.isLoadingActiveModel = false;
			this.renderActiveModelLine();
		}
	}

	private async fetchActiveSessionDetails(
		localSessionKey: string
	): Promise<{ modelRef: string | null; thinkingLevel: string | null }> {
		const res = await this.plugin.chatGateway.sendRequest("sessions.list", {
			search: localSessionKey,
			limit: 50,
			includeUnknown: true,
		});
		if (!res.ok) {
			return { modelRef: null, thinkingLevel: null };
		}

		const payload = (res.payload ?? {}) as Record<string, unknown>;
		const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
		const defaults = (
			payload.defaults && typeof payload.defaults === "object"
		) ? payload.defaults as Record<string, unknown> : {};

		const suffix = `:${localSessionKey}`;
		const entry = sessions.find((session) =>
			session &&
			typeof session === "object" &&
			typeof (session as Record<string, unknown>).key === "string" &&
			((session as Record<string, unknown>).key as string).endsWith(suffix)
		) ?? sessions.find((session) =>
			session &&
			typeof session === "object" &&
			(session as Record<string, unknown>).key === localSessionKey
		);

		const entryObj = entry && typeof entry === "object"
			? entry as Record<string, unknown>
			: {};

		const provider = (
			typeof entryObj.modelProvider === "string" && entryObj.modelProvider
		) ? entryObj.modelProvider :
			(typeof defaults.modelProvider === "string" ? defaults.modelProvider : "");
		const model = (
			typeof entryObj.model === "string" && entryObj.model
		) ? entryObj.model :
			(typeof defaults.model === "string" ? defaults.model : "");
		const thinkingLevel = (
			typeof entryObj.thinkingLevel === "string" && entryObj.thinkingLevel.trim()
		) ? entryObj.thinkingLevel.trim() :
			(typeof defaults.thinkingLevel === "string" && defaults.thinkingLevel.trim()
				? defaults.thinkingLevel.trim()
				: null);

		return {
			modelRef: provider && model ? `${provider}/${model}` : null,
			thinkingLevel,
		};
	}
}
