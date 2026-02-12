import { ItemView, MarkdownRenderer, MarkdownView, WorkspaceLeaf } from "obsidian";
import type ClawdianPlugin from "./main";
import type { ChatMessage, ConnectionState } from "./types";

export const CHAT_VIEW_TYPE = "clawdian-chat";

const OBSIDIAN_NODE_CONTEXT = `[System context: You are chatting with a user inside Obsidian via the Clawdian plugin. You have access to their vault through these node commands:

**Read commands:**
- obsidian.activeFile.get {} → {path, name, basename, extension}
- obsidian.selection.get {} → {text, hasSelection}
- obsidian.note.read {path, maxBytes?} → {path, content, truncated, bytes}
- obsidian.vault.list {pathPrefix?, recursive?, limit?, cursor?} → {items: [{path, type, size?, childCount?}], hasMore, cursor?}
- obsidian.vault.search {query, pathPrefixes?, limit?, contextChars?} → {matches: [{path, line, snippet}]}
- obsidian.metadata.get {path} → {frontmatter, headings, links, tags}
- obsidian.metadata.backlinks {path} → {backlinks: [{path, count}]}
- obsidian.tasks.search {pathPrefixes?, completed?, limit?, query?} → {tasks: [{path, line, status, text}]} — searches vault tasks via metadata cache. status is the checkbox character (" "=open, "x"=done)

**Write commands:**
- obsidian.note.replaceSelection {newText} → replaces editor selection → {applied}
- obsidian.note.insertAtCursor {text} → inserts at cursor position → {applied}
- obsidian.note.applyPatch {path, mode, newText, from?, to?} → modes: replaceWhole, append, prepend, replaceRange (from/to are {line, ch} positions) → {applied}
- obsidian.note.create {path, content} → creates new file (fails if exists) → {created, path}

Use these tools to help the user with their vault. You can search, read, explore, create, and modify notes as needed.]

`;

export class ChatView extends ItemView {
	private messagesContainer: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private includeActiveFile = false;
	private includeSelection = false;
	private activeFileBtn: HTMLElement | null = null;
	private selectionBtn: HTMLElement | null = null;
	private streamingEl: HTMLElement | null = null;
	private renderGeneration = 0;

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
		this.buildUI();
		this.renderMessages();
		this.tryLoadSessions();
	}

	async onClose(): Promise<void> {
		this.plugin.chatModel.offUpdate(this.onModelUpdate);
		this.plugin.chatGateway.off("stateChange", this.onStateChange);
	}

	private onModelUpdate = (): void => {
		this.renderMessages();
	};

	private onStateChange = (_state: ConnectionState): void => {
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

		// Context toggles
		const contextRow = container.createDiv({ cls: "clawdian-chat-context" });
		this.activeFileBtn = contextRow.createEl("button", {
			text: "Active file",
			cls: "clawdian-context-btn",
		});
		this.activeFileBtn.addEventListener("click", () => {
			this.includeActiveFile = !this.includeActiveFile;
			this.activeFileBtn?.toggleClass("is-active", this.includeActiveFile);
		});
		this.selectionBtn = contextRow.createEl("button", {
			text: "Selection",
			cls: "clawdian-context-btn",
		});
		this.selectionBtn.addEventListener("click", () => {
			this.includeSelection = !this.includeSelection;
			this.selectionBtn?.toggleClass("is-active", this.includeSelection);
		});

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
			console.warn("[Clawdian] Cannot send chat: not connected");
			return;
		}

		// Build message with context
		let fullMessage = text;

		// Prepend system context on the first message of each conversation
		const isFirstMessage = this.plugin.chatModel.getMessages().length === 0;
		if (isFirstMessage) {
			fullMessage = OBSIDIAN_NODE_CONTEXT + fullMessage;
		}

		if (this.includeActiveFile) {
			const file = this.app.workspace.getActiveFile();
			if (file) {
				fullMessage = `[Active file: ${file.path}]\n\n${fullMessage}`;
			}
		}
		if (this.includeSelection) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
				const selection = view.editor.getSelection();
				if (selection) {
					fullMessage = `[Selection:\n${selection}\n]\n\n${fullMessage}`;
				}
			}
		}

		// Add user message to model
		this.plugin.chatModel.addUserMessage(text);
		this.inputEl.value = "";

		// Ensure we have a session key
		if (!this.plugin.chatModel.sessionKey) {
			await this.tryLoadSessions();
			if (!this.plugin.chatModel.sessionKey) {
				// Use a default session key
				this.plugin.chatModel.sessionKey = "obsidian-chat";
			}
		}

		// Send to gateway
		this.plugin.chatModel.setWaiting(true);
		try {
			const result = await this.plugin.chatGateway.sendChat(
				this.plugin.chatModel.sessionKey,
				fullMessage
			);
			console.log("[Clawdian] Chat sent, runId:", result.runId);
		} catch (err) {
			console.error("[Clawdian] Failed to send chat:", err);
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

	private async tryLoadSessions(): Promise<void> {
		if (this.plugin.chatGateway.connectionState !== "paired") return;

		try {
			const res = await this.plugin.chatGateway.listSessions();
			if (res.ok && res.payload) {
				const payload = res.payload as {
					sessions?: Array<{ key: string; label?: string }>;
				};
				if (payload.sessions && payload.sessions.length > 0) {
					// Use the first session
					this.plugin.chatModel.sessionKey = payload.sessions[0].key;
					console.log(
						"[Clawdian] Using session:",
						payload.sessions[0].key
					);
				}
			}
		} catch (err) {
			console.log("[Clawdian] Could not list sessions:", err);
		}
	}

	private newConversation(): void {
		this.plugin.chatModel.clear();
		this.plugin.chatModel.sessionKey = "";
		this.renderMessages();
	}
}
