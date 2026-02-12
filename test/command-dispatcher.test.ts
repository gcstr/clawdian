import test from "node:test";
import assert from "node:assert/strict";
import { TFile } from "obsidian";
import { CommandDispatcher } from "../src/commands/dispatcher.ts";

interface TestSettings {
	gatewayUrl: string;
	authMode: "token" | "password";
	gatewayToken: string;
	gatewayPassword: string;
	deviceToken: string;
	deviceName: string;
	deviceId: string;
	maxReadBytes: number;
	maxSearchResults: number;
	maxResponseBytes: number;
	maxFilesScannedPerSearch: number;
	writesEnabled: boolean;
	autoConnect: boolean;
}

function createSettings(overrides: Partial<TestSettings> = {}): TestSettings {
	return {
		gatewayUrl: "wss://example.test",
		authMode: "token",
		gatewayToken: "",
		gatewayPassword: "",
		deviceToken: "",
		deviceName: "Obsidian",
		deviceId: "",
		maxReadBytes: 250_000,
		maxSearchResults: 20,
		maxResponseBytes: 500_000,
		maxFilesScannedPerSearch: 2_000,
		writesEnabled: true,
		autoConnect: true,
		...overrides,
	};
}

function createBaseApp() {
	return {
		workspace: {
			getActiveViewOfType() {
				return null;
			},
		},
		vault: {
			getAbstractFileByPath() {
				return null;
			},
			read: async () => "",
			modify: async () => {},
			cachedRead: async () => "",
			getFiles: () => [],
			getMarkdownFiles: () => [],
			getRoot: () => ({ children: [] }),
			createFolder: async () => {},
			create: async () => {},
		},
		metadataCache: {
			getFileCache: () => null,
			resolvedLinks: {},
		},
	};
}

function createLogger() {
	const entries: unknown[] = [];
	return {
		entries,
		logger: {
			log(entry: unknown) {
				entries.push(entry);
			},
		},
	};
}

test("write commands are blocked immediately when writesEnabled is toggled off", async () => {
	const settings = createSettings({ writesEnabled: true });
	const app = createBaseApp();
	const { logger } = createLogger();

	const dispatcher = new CommandDispatcher(app as never, settings as never, logger as never);
	settings.writesEnabled = false;

	const result = await dispatcher.dispatch({
		id: "req-1",
		nodeId: "node-1",
		command: "obsidian.note.insertAtCursor",
		paramsJSON: JSON.stringify({ text: "Hello" }),
	});

	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "E_WRITES_DISABLED");
});

test("replaceRange validates ch bounds", async () => {
	const settings = createSettings({ writesEnabled: true });
	const file = new TFile("notes/test.md");
	let modifiedContent: string | null = null;

	const app = createBaseApp();
	app.vault.getAbstractFileByPath = () => file;
	app.vault.read = async () => "line one\nline two";
	app.vault.modify = async (_file: unknown, content: string) => {
		modifiedContent = content;
	};

	const { logger } = createLogger();
	const dispatcher = new CommandDispatcher(app as never, settings as never, logger as never);

	const result = await dispatcher.dispatch({
		id: "req-2",
		nodeId: "node-1",
		command: "obsidian.note.applyPatch",
		paramsJSON: JSON.stringify({
			path: "notes/test.md",
			mode: "replaceRange",
			newText: "X",
			from: { line: 0, ch: 999 },
			to: { line: 0, ch: 1 },
		}),
	});

	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "E_INVALID_PARAM");
	assert.match(result.error?.message ?? "", /from\.ch out of range/);
	assert.equal(modifiedContent, null);
});

test("replaceRange rejects inverted ranges", async () => {
	const settings = createSettings({ writesEnabled: true });
	const file = new TFile("notes/test.md");
	let modifiedContent: string | null = null;

	const app = createBaseApp();
	app.vault.getAbstractFileByPath = () => file;
	app.vault.read = async () => "line one\nline two";
	app.vault.modify = async (_file: unknown, content: string) => {
		modifiedContent = content;
	};

	const { logger } = createLogger();
	const dispatcher = new CommandDispatcher(app as never, settings as never, logger as never);

	const result = await dispatcher.dispatch({
		id: "req-3",
		nodeId: "node-1",
		command: "obsidian.note.applyPatch",
		paramsJSON: JSON.stringify({
			path: "notes/test.md",
			mode: "replaceRange",
			newText: "X",
			from: { line: 1, ch: 3 },
			to: { line: 0, ch: 0 },
		}),
	});

	assert.equal(result.ok, false);
	assert.equal(result.error?.code, "E_INVALID_PARAM");
	assert.match(result.error?.message ?? "", /from'.*before or equal to 'to'/);
	assert.equal(modifiedContent, null);
});
