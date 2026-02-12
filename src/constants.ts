import type { ClawdianSettings } from "./types";

export const PROTOCOL_VERSION = 3;

export const PLUGIN_ID = "clawdian";
export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_SETTINGS: ClawdianSettings = {
	gatewayUrl: "",
	authMode: "token",
	gatewayToken: "",
	gatewayPassword: "",
	deviceToken: "",
	deviceName: "Obsidian",
	deviceId: "",
	maxReadBytes: 250_000,
	maxSearchResults: 20,
	maxResponseBytes: 500_000,
	maxFilesScannedPerSearch: 2000,
	writesEnabled: true,
	autoConnect: true,
};

export const NODE_CAPS = [
	"obsidian.vault",
	"obsidian.metadata",
	"obsidian.editor",
	"obsidian.chat",
];

export const NODE_COMMANDS = [
	"obsidian.activeFile.get",
	"obsidian.selection.get",
	"obsidian.note.read",
	"obsidian.vault.list",
	"obsidian.vault.search",
	"obsidian.metadata.get",
	"obsidian.metadata.backlinks",
	"obsidian.note.replaceSelection",
	"obsidian.note.insertAtCursor",
	"obsidian.note.applyPatch",
	"obsidian.note.create",
	"obsidian.tasks.search",
];

export const NODE_PERMISSIONS: Record<string, boolean> = {
	"permissions.vault.read": true,
	"permissions.vault.search": true,
	"permissions.vault.write": true,
	"permissions.editor.readSelection": true,
	"permissions.editor.writeSelection": true,
};

// Reconnect backoff
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 15_000;
