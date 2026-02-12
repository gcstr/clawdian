import { ItemView, WorkspaceLeaf } from "obsidian";
import type ClawdianPlugin from "./main";
import type { ConnectionState, ErrorShape } from "./types";

export const STATUS_VIEW_TYPE = "clawdian-status";

export class StatusView extends ItemView {
	private lastError: string | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ClawdianPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return STATUS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Clawdian Status";
	}

	getIcon(): string {
		return "globe";
	}

	async onOpen(): Promise<void> {
		this.plugin.gateway.on("stateChange", this.onStateChange);
		this.plugin.gateway.on("error", this.onError);
		this.render();
	}

	async onClose(): Promise<void> {
		this.plugin.gateway.off("stateChange", this.onStateChange);
		this.plugin.gateway.off("error", this.onError);
	}

	private onStateChange = (_state: ConnectionState): void => {
		if (_state === "paired") {
			this.lastError = null;
		}
		this.render();
	};

	private onError = (error: ErrorShape | Error): void => {
		this.lastError =
			"message" in error ? error.message : String(error);
		this.render();
	};

	render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("clawdian-status-view");

		const state = this.plugin.gateway.connectionState;
		const settings = this.plugin.settings;

		// Header
		container.createEl("h4", { text: "Clawdian" });

		// Connection state
		const stateRow = container.createDiv({ cls: "clawdian-status-row" });
		const dot = stateRow.createSpan({ cls: "clawdian-status-dot" });
		dot.addClass(this.dotClass(state));
		stateRow.createSpan({ text: this.stateLabel(state) });

		// Info rows
		const info = container.createDiv({ cls: "clawdian-status-info" });

		this.addInfoRow(info, "Gateway", settings.gatewayUrl || "Not configured");
		this.addInfoRow(info, "Device ID", settings.deviceId || "Not generated");
		this.addInfoRow(info, "Device name", settings.deviceName || "-");

		if (this.lastError) {
			const errorRow = container.createDiv({ cls: "clawdian-status-error" });
			errorRow.createEl("strong", { text: "Last error: " });
			errorRow.createSpan({ text: this.lastError });
		}

		// Connect / Disconnect button
		const buttonRow = container.createDiv({ cls: "clawdian-status-actions" });
		const isConnected = state !== "disconnected";
		const btn = buttonRow.createEl("button", {
			text: isConnected ? "Disconnect" : "Connect",
			cls: "mod-cta",
		});
		btn.addEventListener("click", () => {
			if (isConnected) {
				this.plugin.gateway.disconnect();
			} else {
				this.plugin.gateway.connect();
			}
		});
	}

	private addInfoRow(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: "clawdian-info-row" });
		row.createEl("span", { text: label, cls: "clawdian-info-label" });
		row.createEl("span", { text: value, cls: "clawdian-info-value" });
	}

	private dotClass(state: ConnectionState): string {
		switch (state) {
			case "paired":
				return "clawdian-dot-connected";
			case "connected":
			case "connecting":
				return "clawdian-dot-connecting";
			case "disconnected":
				return "clawdian-dot-disconnected";
		}
	}

	private stateLabel(state: ConnectionState): string {
		switch (state) {
			case "paired":
				return "Connected & Paired";
			case "connected":
				return "Connected (pairing...)";
			case "connecting":
				return "Connecting...";
			case "disconnected":
				return "Disconnected";
		}
	}
}
