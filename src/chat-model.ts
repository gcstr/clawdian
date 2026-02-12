import type { ChatMessage, ChatEventPayload } from "./types";

export class ChatModel {
	private static readonly WAITING_TIMEOUT_MS = 60_000;

	private messages: ChatMessage[] = [];
	private streamingContent = "";
	private streamingRunId: string | null = null;
	private _waiting = false;
	private _waitingTimer: ReturnType<typeof setTimeout> | null = null;
	private _sessionKey = "";
	private callbacks: (() => void)[] = [];

	get sessionKey(): string {
		return this._sessionKey;
	}

	set sessionKey(key: string) {
		this._sessionKey = key;
	}

	getMessages(): readonly ChatMessage[] {
		return this.messages;
	}

	addUserMessage(text: string): ChatMessage {
		const msg: ChatMessage = {
			id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			role: "user",
			content: text,
			timestamp: Date.now(),
		};
		this.messages.push(msg);
		this.notify();
		return msg;
	}

	isWaiting(): boolean {
		return this._waiting;
	}

	setWaiting(waiting: boolean): void {
		this._waiting = waiting;
		this.clearWaitingTimer();
		if (waiting) {
			this._waitingTimer = setTimeout(() => {
				this._waitingTimer = null;
				this._waiting = false;
				this.messages.push({
					id: `timeout-${Date.now()}`,
					role: "assistant",
					content: "**Error:** Agent did not respond (timed out after 60s).",
					timestamp: Date.now(),
				});
				this.notify();
			}, ChatModel.WAITING_TIMEOUT_MS);
		}
		this.notify();
	}

	private clearWaitingTimer(): void {
		if (this._waitingTimer) {
			clearTimeout(this._waitingTimer);
			this._waitingTimer = null;
		}
	}

	isStreaming(): boolean {
		return this.streamingRunId !== null;
	}

	getStreamingContent(): string {
		return this.streamingContent;
	}

	handleChatEvent(payload: ChatEventPayload): void {
		// Only process events for our session
		if (this._sessionKey && payload.sessionKey !== this._sessionKey) {
			return;
		}

		this._waiting = false;
		this.clearWaitingTimer();

		switch (payload.state) {
			case "delta": {
				this.streamingRunId = payload.runId;
				// Extract text from content blocks
				const texts = payload.message.content
					.filter((c) => c.type === "text")
					.map((c) => c.text);
				this.streamingContent = texts.join("");
				this.notify();
				break;
			}
			case "final": {
				// Prefer the complete message from the final event over the
				// last streamed delta (which may be missing trailing tokens
				// due to throttling)
				let finalContent = this.streamingContent;
				if (payload.message?.content) {
					const texts = payload.message.content
						.filter((c) => c.type === "text")
						.map((c) => c.text);
					if (texts.length > 0) {
						finalContent = texts.join("");
					}
				}
				if (finalContent) {
					this.messages.push({
						id: `assistant-${payload.runId}`,
						role: "assistant",
						content: finalContent,
						timestamp: Date.now(),
					});
				}
				this.streamingContent = "";
				this.streamingRunId = null;
				this.notify();
				break;
			}
			case "error": {
				const errorText = payload.errorMessage || "An error occurred";
				this.messages.push({
					id: `error-${payload.runId}`,
					role: "assistant",
					content: `**Error:** ${errorText}`,
					timestamp: Date.now(),
				});
				this.streamingContent = "";
				this.streamingRunId = null;
				this.notify();
				break;
			}
		}
	}

	clear(): void {
		this.messages = [];
		this.streamingContent = "";
		this.streamingRunId = null;
		this._waiting = false;
		this.clearWaitingTimer();
		this.notify();
	}

	private static readonly MAX_PERSISTED_MESSAGES = 200;

	serialize(): { sessionKey: string; messages: ChatMessage[] } {
		const messages = this.messages.length > ChatModel.MAX_PERSISTED_MESSAGES
			? this.messages.slice(-ChatModel.MAX_PERSISTED_MESSAGES)
			: [...this.messages];
		return {
			sessionKey: this._sessionKey,
			messages,
		};
	}

	loadFrom(data: { sessionKey?: string; messages?: ChatMessage[] }): void {
		if (data.sessionKey) {
			this._sessionKey = data.sessionKey;
		}
		if (data.messages) {
			this.messages = [...data.messages];
		}
		this.notify();
	}

	onUpdate(cb: () => void): void {
		this.callbacks.push(cb);
	}

	offUpdate(cb: () => void): void {
		const idx = this.callbacks.indexOf(cb);
		if (idx >= 0) this.callbacks.splice(idx, 1);
	}

	private notify(): void {
		for (const cb of this.callbacks) {
			try {
				cb();
			} catch {}
		}
	}
}
