import { App, TFile, TFolder, MarkdownView } from "obsidian";
import type { ClawdianSettings, NodeInvokeRequest } from "./types";
import type { ActivityLogger } from "./activity-log";

type CommandResult =
	| { ok: true; result: unknown }
	| { ok: false; error: { code: string; message: string } };

type CommandHandler = (
	params: Record<string, unknown>
) => Promise<CommandResult>;

export class CommandDispatcher {
	private handlers = new Map<string, CommandHandler>();

	constructor(
		private app: App,
		private settings: ClawdianSettings,
		private logger: ActivityLogger
	) {
		this.registerReadCommands();
		if (this.settings.writesEnabled) {
			this.registerWriteCommands();
		}
	}

	async dispatch(request: NodeInvokeRequest): Promise<{
		ok: boolean;
		payloadJSON?: string;
		error?: { code: string; message: string };
	}> {
		const handler = this.handlers.get(request.command);
		if (!handler) {
			const error = {
				code: "E_NOT_IMPLEMENTED",
				message: `Command ${request.command} not implemented`,
			};
			this.logger.log({
				timestamp: Date.now(),
				command: request.command,
				argsSummary: "",
				ok: false,
				error: error.message,
				durationMs: 0,
				responseBytes: 0,
			});
			return { ok: false, error };
		}

		let params: Record<string, unknown> = {};
		if (request.paramsJSON) {
			try {
				params = JSON.parse(request.paramsJSON);
			} catch {
				const error = {
					code: "E_INVALID_PARAMS",
					message: "Failed to parse paramsJSON",
				};
				this.logger.log({
					timestamp: Date.now(),
					command: request.command,
					argsSummary: request.paramsJSON.slice(0, 80),
					ok: false,
					error: error.message,
					durationMs: 0,
					responseBytes: 0,
				});
				return { ok: false, error };
			}
		}

		const argsSummary = summarizeArgs(params);
		const start = Date.now();

		let result: CommandResult;
		try {
			result = await handler(params);
		} catch (err) {
			const error = {
				code: "E_INTERNAL",
				message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
			};
			this.logger.log({
				timestamp: Date.now(),
				command: request.command,
				argsSummary,
				ok: false,
				error: error.message,
				durationMs: Date.now() - start,
				responseBytes: 0,
			});
			return { ok: false, error };
		}

		const durationMs = Date.now() - start;

		if (result.ok) {
			let payloadJSON = JSON.stringify(result.result);
			const responseBytes = new TextEncoder().encode(payloadJSON).byteLength;

			// Enforce maxResponseBytes
			if (responseBytes > this.settings.maxResponseBytes) {
				const error = {
					code: "E_RESPONSE_TOO_LARGE",
					message: `Response ${responseBytes} bytes exceeds limit of ${this.settings.maxResponseBytes}`,
				};
				this.logger.log({
					timestamp: Date.now(),
					command: request.command,
					argsSummary,
					ok: false,
					error: error.message,
					durationMs,
					responseBytes,
				});
				return { ok: false, error };
			}

			this.logger.log({
				timestamp: Date.now(),
				command: request.command,
				argsSummary,
				ok: true,
				durationMs,
				responseBytes,
			});

			return { ok: true, payloadJSON };
		} else {
			this.logger.log({
				timestamp: Date.now(),
				command: request.command,
				argsSummary,
				ok: false,
				error: result.error.message,
				durationMs,
				responseBytes: 0,
			});
			return { ok: false, error: result.error };
		}
	}

	private registerReadCommands(): void {
		this.handlers.set("obsidian.activeFile.get", (params) =>
			this.handleActiveFileGet(params)
		);
		this.handlers.set("obsidian.selection.get", (params) =>
			this.handleSelectionGet(params)
		);
		this.handlers.set("obsidian.note.read", (params) =>
			this.handleNoteRead(params)
		);
		this.handlers.set("obsidian.vault.list", (params) =>
			this.handleVaultList(params)
		);
		this.handlers.set("obsidian.vault.search", (params) =>
			this.handleVaultSearch(params)
		);
		this.handlers.set("obsidian.metadata.get", (params) =>
			this.handleMetadataGet(params)
		);
		this.handlers.set("obsidian.metadata.backlinks", (params) =>
			this.handleMetadataBacklinks(params)
		);
		this.handlers.set("obsidian.tasks.search", (params) =>
			this.handleTasksSearch(params)
		);
	}

	private registerWriteCommands(): void {
		this.handlers.set("obsidian.note.replaceSelection", (params) =>
			this.handleReplaceSelection(params)
		);
		this.handlers.set("obsidian.note.insertAtCursor", (params) =>
			this.handleInsertAtCursor(params)
		);
		this.handlers.set("obsidian.note.applyPatch", (params) =>
			this.handleApplyPatch(params)
		);
		this.handlers.set("obsidian.note.create", (params) =>
			this.handleNoteCreate(params)
		);
	}

	// --- Command Handlers ---

	private async handleActiveFileGet(
		_params: Record<string, unknown>
	): Promise<CommandResult> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			return {
				ok: false,
				error: {
					code: "E_NO_ACTIVE_FILE",
					message: "No file is currently active",
				},
			};
		}
		return {
			ok: true,
			result: {
				path: file.path,
				name: file.name,
				basename: file.basename,
				extension: file.extension,
			},
		};
	}

	private async handleSelectionGet(
		_params: Record<string, unknown>
	): Promise<CommandResult> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			return {
				ok: true,
				result: { text: "", hasSelection: false },
			};
		}
		const selection = view.editor.getSelection();
		return {
			ok: true,
			result: {
				text: selection,
				hasSelection: selection.length > 0,
			},
		};
	}

	private async handleNoteRead(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const path = params.path as string | undefined;
		if (!path) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
			};
		}

		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (!abstract) {
			return {
				ok: false,
				error: { code: "E_NOT_FOUND", message: `File not found: ${path}` },
			};
		}
		if (!(abstract instanceof TFile)) {
			return {
				ok: false,
				error: { code: "E_NOT_FILE", message: `Path is not a file: ${path}` },
			};
		}

		const content = await this.app.vault.read(abstract);
		const maxBytes = Math.min(
			typeof params.maxBytes === "number" ? params.maxBytes : Infinity,
			this.settings.maxReadBytes
		);

		const encoder = new TextEncoder();
		const encoded = encoder.encode(content);
		const truncated = encoded.byteLength > maxBytes;
		const finalContent = truncated
			? new TextDecoder().decode(encoded.slice(0, maxBytes))
			: content;

		return {
			ok: true,
			result: {
				path,
				content: finalContent,
				truncated,
				bytes: encoded.byteLength,
			},
		};
	}

	private async handleVaultList(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const pathPrefix = (params.pathPrefix as string) ?? "";
		const recursive = (params.recursive as boolean) ?? false;
		const limit = (params.limit as number) ?? 200;
		const cursor = (params.cursor as string) ?? null;

		// Decode cursor (base64-encoded last path)
		let cursorPath: string | null = null;
		if (cursor) {
			try {
				cursorPath = atob(cursor);
			} catch {
				return {
					ok: false,
					error: { code: "E_INVALID_CURSOR", message: "Invalid cursor" },
				};
			}
		}

		interface ListItem {
			path: string;
			type: "file" | "folder";
			size?: number;
			childCount?: number;
		}

		let items: ListItem[] = [];

		if (recursive) {
			// Recursive: get all files under prefix
			const files = this.app.vault.getFiles();
			for (const file of files) {
				if (pathPrefix === "" || file.path.startsWith(pathPrefix)) {
					items.push({
						path: file.path,
						type: "file",
						size: file.stat.size,
					});
				}
			}
		} else {
			// Shallow: get children of the prefix folder
			if (pathPrefix === "" || pathPrefix === "/") {
				// Root folder
				const root = this.app.vault.getRoot();
				for (const child of root.children) {
					if (child instanceof TFile) {
						items.push({
							path: child.path,
							type: "file",
							size: child.stat.size,
						});
					} else if (child instanceof TFolder) {
						items.push({
							path: child.path + "/",
							type: "folder",
							childCount: child.children.length,
						});
					}
				}
			} else {
				const folder = this.app.vault.getAbstractFileByPath(
					pathPrefix.replace(/\/$/, "")
				);
				if (!folder || !(folder instanceof TFolder)) {
					return {
						ok: false,
						error: {
							code: "E_NOT_FOUND",
							message: `Folder not found: ${pathPrefix}`,
						},
					};
				}
				for (const child of folder.children) {
					if (child instanceof TFile) {
						items.push({
							path: child.path,
							type: "file",
							size: child.stat.size,
						});
					} else if (child instanceof TFolder) {
						items.push({
							path: child.path + "/",
							type: "folder",
							childCount: child.children.length,
						});
					}
				}
			}
		}

		// Sort by path for stable pagination
		items.sort((a, b) => a.path.localeCompare(b.path));

		// Apply cursor
		if (cursorPath) {
			const idx = items.findIndex((item) => item.path > cursorPath!);
			if (idx < 0) {
				items = [];
			} else {
				items = items.slice(idx);
			}
		}

		// Apply limit
		const hasMore = items.length > limit;
		const page = items.slice(0, limit);
		const newCursor = hasMore ? btoa(page[page.length - 1].path) : null;

		return {
			ok: true,
			result: {
				items: page,
				hasMore,
				...(newCursor ? { cursor: newCursor } : {}),
			},
		};
	}

	private async handleVaultSearch(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const query = params.query as string | undefined;
		if (!query) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: query" },
			};
		}

		const pathPrefixes = (params.pathPrefixes as string[]) ?? [""];
		const limit = Math.min(
			(params.limit as number) ?? this.settings.maxSearchResults,
			this.settings.maxSearchResults
		);
		const contextChars = (params.contextChars as number) ?? 120;
		const maxFilesScanned = Math.min(
			(params.maxFilesScanned as number) ?? this.settings.maxFilesScannedPerSearch,
			this.settings.maxFilesScannedPerSearch
		);

		const queryLower = query.toLowerCase();
		const files = this.app.vault.getMarkdownFiles();

		interface SearchMatch {
			path: string;
			line: number;
			snippet: string;
		}

		const matches: SearchMatch[] = [];
		let filesScanned = 0;

		for (const file of files) {
			if (filesScanned >= maxFilesScanned) break;
			if (matches.length >= limit) break;

			// Filter by path prefixes
			const matchesPrefix = pathPrefixes.some(
				(prefix) => prefix === "" || file.path.startsWith(prefix)
			);
			if (!matchesPrefix) continue;

			filesScanned++;

			let content: string;
			try {
				content = await this.app.vault.cachedRead(file);
			} catch {
				continue;
			}

			const contentLower = content.toLowerCase();
			let searchFrom = 0;

			while (searchFrom < contentLower.length && matches.length < limit) {
				const idx = contentLower.indexOf(queryLower, searchFrom);
				if (idx < 0) break;

				// Calculate line number
				let line = 1;
				for (let i = 0; i < idx; i++) {
					if (content[i] === "\n") line++;
				}

				// Extract snippet
				const snippetStart = Math.max(0, idx - Math.floor(contextChars / 2));
				const snippetEnd = Math.min(
					content.length,
					idx + query.length + Math.floor(contextChars / 2)
				);
				let snippet = content.slice(snippetStart, snippetEnd);
				if (snippetStart > 0) snippet = "..." + snippet;
				if (snippetEnd < content.length) snippet = snippet + "...";

				matches.push({ path: file.path, line, snippet });

				// Move past this match to find next
				searchFrom = idx + query.length;
			}
		}

		return {
			ok: true,
			result: { matches },
		};
	}

	private async handleMetadataGet(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const path = params.path as string | undefined;
		if (!path) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
			};
		}

		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (!abstract || !(abstract instanceof TFile)) {
			return {
				ok: false,
				error: { code: "E_NOT_FOUND", message: `File not found: ${path}` },
			};
		}

		const cache = this.app.metadataCache.getFileCache(abstract);
		if (!cache) {
			return {
				ok: true,
				result: {
					frontmatter: null,
					headings: [],
					links: [],
					tags: [],
				},
			};
		}

		// Strip the position field from frontmatter
		let frontmatter: Record<string, unknown> | null = null;
		if (cache.frontmatter) {
			const { position: _, ...rest } = cache.frontmatter;
			frontmatter = rest;
		}

		return {
			ok: true,
			result: {
				frontmatter,
				headings:
					cache.headings?.map((h) => ({
						heading: h.heading,
						level: h.level,
					})) ?? [],
				links: cache.links?.map((l) => ({ link: l.link })) ?? [],
				tags: cache.tags?.map((t) => t.tag) ?? [],
			},
		};
	}

	private async handleTasksSearch(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const pathPrefixes = (params.pathPrefixes as string[]) ?? [""];
		const completed = params.completed as boolean | undefined ?? undefined;
		const limit = Math.min(
			(params.limit as number) ?? 100,
			500
		);
		const query = (params.query as string | undefined) ?? null;
		const queryLower = query?.toLowerCase() ?? null;

		interface TaskItem {
			path: string;
			line: number;
			status: string;
			text: string;
		}

		const tasks: TaskItem[] = [];
		const files = this.app.vault.getMarkdownFiles();

		for (const file of files) {
			if (tasks.length >= limit) break;

			// Filter by path prefixes
			const matchesPrefix = pathPrefixes.some(
				(prefix) => prefix === "" || file.path.startsWith(prefix)
			);
			if (!matchesPrefix) continue;

			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.listItems) continue;

			// Check if any list items are tasks
			const taskItems = cache.listItems.filter((item) => item.task != null);
			if (taskItems.length === 0) continue;

			// Filter by completion status
			const filtered = completed === undefined
				? taskItems
				: taskItems.filter((item) => {
					const isDone = item.task === "x" || item.task === "X";
					return completed ? isDone : !isDone;
				});

			if (filtered.length === 0) continue;

			// Read file content to extract task text
			let content: string;
			try {
				content = await this.app.vault.cachedRead(file);
			} catch {
				continue;
			}

			const lines = content.split("\n");

			for (const item of filtered) {
				if (tasks.length >= limit) break;

				const lineIdx = item.position.start.line;
				if (lineIdx >= lines.length) continue;

				// Extract task text: strip the leading "- [ ] " or similar
				const raw = lines[lineIdx];
				const text = raw.replace(/^[\s>]*-\s*\[.\]\s*/, "");

				// Apply text query filter
				if (queryLower && !text.toLowerCase().includes(queryLower)) continue;

				tasks.push({
					path: file.path,
					line: lineIdx + 1,
					status: item.task ?? " ",
					text,
				});
			}
		}

		return {
			ok: true,
			result: { tasks },
		};
	}

	// --- Write Command Handlers ---

	private async handleReplaceSelection(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const newText = params.newText as string | undefined;
		if (newText == null) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: newText" },
			};
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			return {
				ok: false,
				error: { code: "E_NO_EDITOR", message: "No active markdown editor" },
			};
		}

		view.editor.replaceSelection(newText);
		return { ok: true, result: { applied: true } };
	}

	private async handleInsertAtCursor(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const text = params.text as string | undefined;
		if (text == null) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: text" },
			};
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			return {
				ok: false,
				error: { code: "E_NO_EDITOR", message: "No active markdown editor" },
			};
		}

		const cursor = view.editor.getCursor();
		view.editor.replaceRange(text, cursor);
		return { ok: true, result: { applied: true } };
	}

	private async handleApplyPatch(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const path = params.path as string | undefined;
		const mode = params.mode as string | undefined;
		const newText = params.newText as string | undefined;

		if (!path) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
			};
		}
		if (!mode) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: mode" },
			};
		}
		if (newText == null) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: newText" },
			};
		}

		const validModes = ["replaceWhole", "append", "prepend", "replaceRange"];
		if (!validModes.includes(mode)) {
			return {
				ok: false,
				error: {
					code: "E_INVALID_PARAM",
					message: `Invalid mode: ${mode}. Must be one of: ${validModes.join(", ")}`,
				},
			};
		}

		// Enforce max write size
		const writeBytes = new TextEncoder().encode(newText).byteLength;
		if (writeBytes > this.settings.maxResponseBytes) {
			return {
				ok: false,
				error: {
					code: "E_TOO_LARGE",
					message: `Write payload ${writeBytes} bytes exceeds limit of ${this.settings.maxResponseBytes}`,
				},
			};
		}

		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (!abstract || !(abstract instanceof TFile)) {
			return {
				ok: false,
				error: { code: "E_NOT_FOUND", message: `File not found: ${path}` },
			};
		}

		switch (mode) {
			case "replaceWhole": {
				await this.app.vault.modify(abstract, newText);
				break;
			}
			case "append": {
				const existing = await this.app.vault.read(abstract);
				await this.app.vault.modify(abstract, existing + newText);
				break;
			}
			case "prepend": {
				const existing = await this.app.vault.read(abstract);
				await this.app.vault.modify(abstract, newText + existing);
				break;
			}
			case "replaceRange": {
				const from = params.from as { line: number; ch: number } | undefined;
				const to = params.to as { line: number; ch: number } | undefined;
				if (!from || !to) {
					return {
						ok: false,
						error: {
							code: "E_MISSING_PARAM",
							message: "replaceRange mode requires 'from' and 'to' params with {line, ch}",
						},
					};
				}

				const content = await this.app.vault.read(abstract);
				const lines = content.split("\n");

				// Validate positions
				if (from.line < 0 || from.line >= lines.length || to.line < 0 || to.line >= lines.length) {
					return {
						ok: false,
						error: {
							code: "E_INVALID_PARAM",
							message: `Line position out of range (file has ${lines.length} lines)`,
						},
					};
				}

				// Convert line/ch to string offset
				let startOffset = 0;
				for (let i = 0; i < from.line; i++) {
					startOffset += lines[i].length + 1; // +1 for \n
				}
				startOffset += from.ch;

				let endOffset = 0;
				for (let i = 0; i < to.line; i++) {
					endOffset += lines[i].length + 1;
				}
				endOffset += to.ch;

				const result = content.slice(0, startOffset) + newText + content.slice(endOffset);
				await this.app.vault.modify(abstract, result);
				break;
			}
		}

		return { ok: true, result: { applied: true } };
	}

	private async handleNoteCreate(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const path = params.path as string | undefined;
		const content = params.content as string | undefined;

		if (!path) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
			};
		}
		if (content == null) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: content" },
			};
		}

		// Enforce max write size
		const writeBytes = new TextEncoder().encode(content).byteLength;
		if (writeBytes > this.settings.maxResponseBytes) {
			return {
				ok: false,
				error: {
					code: "E_TOO_LARGE",
					message: `Content ${writeBytes} bytes exceeds limit of ${this.settings.maxResponseBytes}`,
				},
			};
		}

		// Check if file already exists
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) {
			return {
				ok: false,
				error: {
					code: "E_ALREADY_EXISTS",
					message: `File already exists: ${path}`,
				},
			};
		}

		// Create parent folders if needed
		const parentPath = path.substring(0, path.lastIndexOf("/"));
		if (parentPath) {
			const parentExists = this.app.vault.getAbstractFileByPath(parentPath);
			if (!parentExists) {
				try {
					await this.app.vault.createFolder(parentPath);
				} catch {
					// Folder may already exist (race or nested creation)
				}
			}
		}

		await this.app.vault.create(path, content);
		return { ok: true, result: { created: true, path } };
	}

	// --- Read Command Handlers ---

	private async handleMetadataBacklinks(
		params: Record<string, unknown>
	): Promise<CommandResult> {
		const path = params.path as string | undefined;
		if (!path) {
			return {
				ok: false,
				error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
			};
		}

		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const backlinks: { path: string; count: number }[] = [];

		for (const sourcePath in resolvedLinks) {
			const targets = resolvedLinks[sourcePath];
			if (targets && targets[path] && targets[path] > 0) {
				backlinks.push({ path: sourcePath, count: targets[path] });
			}
		}

		// Sort by count descending
		backlinks.sort((a, b) => b.count - a.count);

		return {
			ok: true,
			result: { backlinks },
		};
	}
}

function summarizeArgs(params: Record<string, unknown>): string {
	const keys = Object.keys(params);
	if (keys.length === 0) return "{}";
	const parts: string[] = [];
	for (const key of keys) {
		const val = params[key];
		if (typeof val === "string") {
			parts.push(`${key}="${val.length > 30 ? val.slice(0, 30) + "..." : val}"`);
		} else {
			parts.push(`${key}=${JSON.stringify(val)}`);
		}
	}
	const summary = parts.join(", ");
	return summary.length > 80 ? summary.slice(0, 77) + "..." : summary;
}
