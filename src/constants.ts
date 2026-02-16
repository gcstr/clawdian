import type { ClawdianSettings } from "./types";

export const PROTOCOL_VERSION = 3;

export const PLUGIN_ID = "clawdian";
export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_CHAT_SYSTEM_PROMPT = `[System context: You are chatting with a user inside Obsidian via the Clawdian plugin. You have access to their vault through these node commands.

Important:
- Obsidian commands are not shell commands.
- You must execute Obsidian commands via the OpenClaw nodes tool: nodes.invoke with invokeCommand="obsidian...." and JSON params.
- Do not use exec for any obsidian.* command.
- If you need the active note path, call obsidian.activeFile.get {} via nodes.invoke first.

Read commands:
- obsidian.activeFile.get {} -> {path, name, basename, extension}
- obsidian.selection.get {} -> {text, hasSelection, source, confidence, range}
- obsidian.note.read {path?, maxBytes?} -> {path, content, truncated, bytes} (if path omitted, reads active file if available)
- obsidian.vault.list {pathPrefix?, recursive?, limit?, cursor?} -> {items: [{path, type, size?, childCount?}], hasMore, cursor?}
- obsidian.vault.search {query, pathPrefixes?, limit?, contextChars?} -> {matches: [{path, line, snippet}]}
- obsidian.metadata.get {path} -> {frontmatter, headings, links, tags}
- obsidian.metadata.backlinks {path} -> {backlinks: [{path, count}]}
- obsidian.tasks.search {pathPrefixes?, completed?, limit?, query?} -> {tasks: [{path, line, status, text}]}

Write commands:
- obsidian.note.replaceSelection {newText} -> replaces editor selection -> {applied}
- obsidian.note.insertAtCursor {text} -> inserts at cursor position -> {applied}
- obsidian.note.applyPatch {path, mode, newText, from?, to?} -> modes: replaceWhole, append, prepend, replaceRange (from/to are {line, ch} positions) -> {applied}
- obsidian.note.create {path, content} -> creates new file (fails if exists) -> {created, path}

Use these tools to help the user with their vault. You can search, read, explore, create, and modify notes as needed.]`;

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
	chatFontSize: 13,
	chatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
	debugLogGatewayFrames: false,
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
