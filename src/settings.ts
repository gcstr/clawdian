import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "./constants";
import type ClawdianPlugin from "./main";

export class ClawdianSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ClawdianPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Connection ---
		containerEl.createEl("h2", { text: "Connection" });

		new Setting(containerEl)
			.setName("Gateway URL")
			.setDesc("WebSocket URL of your OpenClaw Gateway")
			.addText((text) =>
				text
					.setPlaceholder("wss://...")
					.setValue(this.plugin.settings.gatewayUrl)
					.onChange(async (value) => {
						this.plugin.settings.gatewayUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auth mode")
			.setDesc("How to authenticate with the gateway")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("token", "Token")
					.addOption("password", "Password")
					.setValue(this.plugin.settings.authMode)
					.onChange(async (value) => {
						this.plugin.settings.authMode = value as "token" | "password";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.authMode === "token") {
			new Setting(containerEl)
				.setName("Gateway token")
				.setDesc("Token for gateway authentication")
				.addText((text) => {
					text.inputEl.type = "password";
					text
						.setPlaceholder("Enter token")
						.setValue(this.plugin.settings.gatewayToken)
						.onChange(async (value) => {
							this.plugin.settings.gatewayToken = value;
							await this.plugin.saveSettings();
						});
				});
		} else {
			new Setting(containerEl)
				.setName("Gateway password")
				.setDesc("Password for gateway authentication")
				.addText((text) => {
					text.inputEl.type = "password";
					text
						.setPlaceholder("Enter password")
						.setValue(this.plugin.settings.gatewayPassword)
						.onChange(async (value) => {
							this.plugin.settings.gatewayPassword = value;
							await this.plugin.saveSettings();
						});
				});
		}

		if (this.plugin.settings.deviceToken) {
			new Setting(containerEl)
				.setName("Device token")
				.setDesc("Issued by the gateway after pairing (auto-managed)")
				.addText((text) => {
					text.inputEl.type = "password";
					text.setValue(this.plugin.settings.deviceToken);
					text.setDisabled(true);
				});
		}

		new Setting(containerEl)
			.setName("Auto-connect")
			.setDesc("Automatically connect to the gateway when Obsidian starts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoConnect)
					.onChange(async (value) => {
						this.plugin.settings.autoConnect = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Chat ---
		containerEl.createEl("h2", { text: "Chat" });

		new Setting(containerEl)
			.setName("Chat font size")
			.setDesc("Font size in px for chat messages and input (10-24)")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "10";
				text.inputEl.max = "24";
				text.inputEl.step = "1";
				text
					.setValue(String(this.plugin.settings.chatFontSize))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (isNaN(num)) return;
						this.plugin.settings.chatFontSize = num;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Chat system prompt")
			.setDesc("Prepended to the first user message in each new chat conversation.")
			.addTextArea((text) => {
				text.inputEl.rows = 12;
				text.inputEl.cols = 60;
				text
					.setValue(this.plugin.settings.chatSystemPrompt || DEFAULT_CHAT_SYSTEM_PROMPT)
					.onChange(async (value) => {
						this.plugin.settings.chatSystemPrompt = value;
						await this.plugin.saveSettings();
					});
			});

		// --- Connect / Disconnect button ---
		const isConnected = this.plugin.gateway.connectionState !== "disconnected";
		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText(isConnected ? "Disconnect" : "Connect")
				.setCta()
				.onClick(() => {
					if (isConnected) {
						this.plugin.gateway.disconnect();
					} else {
						this.plugin.gateway.connect();
					}
					// Re-render after a brief delay for state to update
					setTimeout(() => this.display(), 300);
				})
		);

		// --- Identity ---
		containerEl.createEl("h2", { text: "Identity" });

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Display name for this node in the gateway")
			.addText((text) =>
				text
					.setPlaceholder("Obsidian")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value;
						await this.plugin.saveSettings();
						// Force the chat to use the new device-scoped session key on next send.
						this.plugin.chatModel.clear();
						this.plugin.chatModel.sessionKey = "";
					})
			);

		new Setting(containerEl)
			.setName("Device ID")
			.setDesc("Stable identifier for this device (auto-generated)")
			.addText((text) => {
				text.setValue(this.plugin.settings.deviceId);
				text.setDisabled(true);
			});

		// --- Safety Limits ---
		containerEl.createEl("h2", { text: "Safety Limits" });

		new Setting(containerEl)
			.setName("Max read bytes")
			.setDesc("Maximum bytes to read per note")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxReadBytes))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxReadBytes = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Max search results")
			.setDesc("Maximum number of search results to return")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxSearchResults))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxSearchResults = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Max response bytes")
			.setDesc("Maximum bytes per tool result")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxResponseBytes))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxResponseBytes = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Max files scanned per search")
			.setDesc("Maximum files to scan during a search query")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxFilesScannedPerSearch))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxFilesScannedPerSearch = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// --- Debug ---
		containerEl.createEl("h2", { text: "Debug" });

		new Setting(containerEl)
			.setName("Log gateway frames")
			.setDesc("Log raw Gateway WS frames to the developer console and Activity Log (useful for debugging).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLogGatewayFrames)
					.onChange(async (value) => {
						this.plugin.settings.debugLogGatewayFrames = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Writes ---
		containerEl.createEl("h2", { text: "Writes" });

		new Setting(containerEl)
			.setName("Enable writes")
			.setDesc("Allow the agent to create and modify notes")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.writesEnabled)
					.onChange(async (value) => {
						this.plugin.settings.writesEnabled = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
