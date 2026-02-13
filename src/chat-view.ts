import { ItemView, MarkdownRenderer, MarkdownView, ToggleComponent, WorkspaceLeaf } from "obsidian";
import type ClawdianPlugin from "./main";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "./constants";
import type { ChatMessage, ConnectionState, ErrorShape } from "./types";

export const CHAT_VIEW_TYPE = "clawdian-chat";

export class ChatView extends ItemView {
	private messagesContainer: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private includeObsidianContext = false;
	private contextSnapshot: {
		filePath: string | null;
		cursor: { line: number; ch: number } | null;
		selection:
			| {
				from: { line: number; ch: number };
				to: { line: number; ch: number };
				hasSelection: boolean;
			}
			| null;
	} | null = null;
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
		this.plugin.chatGateway.on("error", this.onGatewayError);
		this.buildUI();
		this.renderMessages();
	}

	async onClose(): Promise<void> {
		this.plugin.chatModel.offUpdate(this.onModelUpdate);
		this.plugin.chatGateway.off("stateChange", this.onStateChange);
		this.plugin.chatGateway.off("error", this.onGatewayError);
	}

	private onModelUpdate = (): void => {
		this.renderMessages();
	};

	private onStateChange = (_state: ConnectionState): void => {
		if (_state === "paired") {
			this.lastChatError = null;
		}
		this.updateConnectionStatus();
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
		header.createEl("h4", { text: "Chat" });

		const headerActions = header.createDiv({ cls: "clawdian-chat-header-actions" });
		const newBtn = headerActions.createEl("button", {
			text: "New",
			cls: "clawdian-chat-new-btn",
		});
		newBtn.addEventListener("click", () => this.newConversation());

		// Connection status
		container.createDiv({ cls: "clawdian-chat-status" });
		this.updateConnectionStatus();

		// Messages area
		this.messagesContainer = container.createDiv({ cls: "clawdian-chat-messages" });

		// Input area
		const inputRow = container.createDiv({ cls: "clawdian-chat-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "clawdian-chat-input",
			attr: { placeholder: "Type a message...", rows: "2" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		this.sendBtn = inputRow.createEl("button", {
			text: "Send",
			cls: "clawdian-chat-send-btn mod-cta",
		});
		this.sendBtn.addEventListener("click", () => this.sendMessage());

		// Context toggle (below the input field)
		const contextToggleRow = container.createDiv({ cls: "clawdian-chat-context-toggle-row" });
		const toggleHost = contextToggleRow.createDiv({
			cls: "clawdian-chat-context-toggle-control",
		});
		const contextToggle = new ToggleComponent(toggleHost);
		contextToggle
			.setValue(this.includeObsidianContext)
			.onChange((value) => {
				this.includeObsidianContext = value;
				if (this.includeObsidianContext) {
					this.captureObsidianContextSnapshot();
				}
			});
		contextToggleRow.createSpan({
			text: "Obsidian context",
			cls: "clawdian-chat-context-toggle-text",
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

		if (isUser) {
			bodyEl.setText(msg.content);
		} else {
			await MarkdownRenderer.render(
				this.app,
				msg.content,
				bodyEl,
				"",
				this
			);
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

			// Copy button
			const copyBtn = actions.createEl("button", {
				text: "Copy",
				cls: "clawdian-code-action-btn",
			});
			copyBtn.addEventListener("click", () => {
				navigator.clipboard.writeText(code.textContent || "");
				copyBtn.setText("Copied!");
				setTimeout(() => copyBtn.setText("Copy"), 1500);
			});

			// Insert button (only if writes enabled)
			if (this.plugin.settings.writesEnabled) {
				const insertBtn = actions.createEl("button", {
					text: "Insert",
					cls: "clawdian-code-action-btn",
				});
				insertBtn.addEventListener("click", () => {
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (!view) {
						insertBtn.setText("No editor");
						setTimeout(() => insertBtn.setText("Insert"), 1500);
						return;
					}
					const cursor = view.editor.getCursor();
					view.editor.replaceRange(code.textContent || "", cursor);
					insertBtn.setText("Inserted!");
					setTimeout(() => insertBtn.setText("Insert"), 1500);
				});
			}
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

		// Build message with context
		let fullMessage = text;

		// Prepend system context on the first message of each conversation
		const isFirstMessage = this.plugin.chatModel.getMessages().length === 0;
		if (isFirstMessage) {
			fullMessage = `${this.getSystemPrompt()}\n\n${fullMessage}`;
		}

		if (this.includeObsidianContext) {
			this.captureObsidianContextSnapshot();
			fullMessage = `${this.buildObsidianContextBlock()}\n\n${fullMessage}`;
		}

		// Add user message to model
		this.plugin.chatModel.addUserMessage(text);
		this.inputEl.value = "";

		// Ensure we have a session key
		if (!this.plugin.chatModel.sessionKey) {
			this.plugin.chatModel.sessionKey = this.createSessionKey();
		}

		// Send to gateway
		this.plugin.chatModel.setWaiting(true);
		try {
			await this.plugin.chatGateway.sendChat(
				this.plugin.chatModel.sessionKey,
				fullMessage
			);
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

	private newConversation(): void {
		this.plugin.chatModel.clear();
		this.plugin.chatModel.sessionKey = "";
		this.contextSnapshot = null;
		this.renderMessages();
	}

	private createSessionKey(): string {
		return `obsidian-chat-${Date.now()}`;
	}

	private captureObsidianContextSnapshot(): void {
		const view = this.getBestMarkdownView();
		if (view) {
			this.contextSnapshot = {
				filePath: view.file?.path ?? this.app.workspace.getActiveFile()?.path ?? null,
				cursor: view.editor.getCursor(),
				selection: {
					from: view.editor.getCursor("from"),
					to: view.editor.getCursor("to"),
					hasSelection: view.editor.somethingSelected(),
				},
			};
			return;
		}

		this.contextSnapshot = {
			filePath: this.app.workspace.getActiveFile()?.path ?? null,
			cursor: null,
			selection: null,
		};
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

	private buildObsidianContextBlock(): string {
		const snapshot = this.contextSnapshot ?? {
			filePath: this.app.workspace.getActiveFile()?.path ?? null,
			cursor: null,
			selection: null,
		};

		const fileText = snapshot.filePath ?? "(none)";
		const cursorText = snapshot.cursor
			? `line ${snapshot.cursor.line + 1}, ch ${snapshot.cursor.ch}`
			: "(unknown)";
		const selectionText =
			snapshot.selection && snapshot.selection.hasSelection
				? `from line ${snapshot.selection.from.line + 1}, ch ${snapshot.selection.from.ch} to line ${snapshot.selection.to.line + 1}, ch ${snapshot.selection.to.ch}`
				: "(none)";

		return `[Obsidian context]\nActive file: ${fileText}\nCursor position: ${cursorText}\nSelection range: ${selectionText}`;
	}

	private getSystemPrompt(): string {
		const customPrompt = this.plugin.settings.chatSystemPrompt?.trim();
		return customPrompt || DEFAULT_CHAT_SYSTEM_PROMPT;
	}
}
