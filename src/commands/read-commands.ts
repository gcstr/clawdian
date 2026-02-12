import { MarkdownView, TFile, TFolder } from "obsidian";
import type { CommandContext, CommandHandler, CommandResult } from "./types";

export function registerReadCommands(
	handlers: Map<string, CommandHandler>,
	context: CommandContext
): void {
	handlers.set("obsidian.activeFile.get", (params) =>
		handleActiveFileGet(context, params)
	);
	handlers.set("obsidian.selection.get", (params) =>
		handleSelectionGet(context, params)
	);
	handlers.set("obsidian.note.read", (params) =>
		handleNoteRead(context, params)
	);
	handlers.set("obsidian.vault.list", (params) =>
		handleVaultList(context, params)
	);
	handlers.set("obsidian.vault.search", (params) =>
		handleVaultSearch(context, params)
	);
	handlers.set("obsidian.metadata.get", (params) =>
		handleMetadataGet(context, params)
	);
	handlers.set("obsidian.metadata.backlinks", (params) =>
		handleMetadataBacklinks(context, params)
	);
	handlers.set("obsidian.tasks.search", (params) =>
		handleTasksSearch(context, params)
	);
}

async function handleActiveFileGet(
	context: CommandContext,
	_params: Record<string, unknown>
): Promise<CommandResult> {
	const file = context.app.workspace.getActiveFile();
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

async function handleSelectionGet(
	context: CommandContext,
	_params: Record<string, unknown>
): Promise<CommandResult> {
	const view = context.app.workspace.getActiveViewOfType(MarkdownView);
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

async function handleNoteRead(
	context: CommandContext,
	params: Record<string, unknown>
): Promise<CommandResult> {
	const path = params.path as string | undefined;
	if (!path) {
		return {
			ok: false,
			error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
		};
	}

	const abstract = context.app.vault.getAbstractFileByPath(path);
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

	const content = await context.app.vault.read(abstract);
	const maxBytes = Math.min(
		typeof params.maxBytes === "number" ? params.maxBytes : Infinity,
		context.settings.maxReadBytes
	);

	const encoded = new TextEncoder().encode(content);
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

async function handleVaultList(
	context: CommandContext,
	params: Record<string, unknown>
): Promise<CommandResult> {
	const pathPrefix = (params.pathPrefix as string) ?? "";
	const recursive = (params.recursive as boolean) ?? false;
	const limit = (params.limit as number) ?? 200;
	const cursor = (params.cursor as string) ?? null;

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
		const files = context.app.vault.getFiles();
		for (const file of files) {
			if (pathPrefix === "" || file.path.startsWith(pathPrefix)) {
				items.push({
					path: file.path,
					type: "file",
					size: file.stat.size,
				});
			}
		}
	} else if (pathPrefix === "" || pathPrefix === "/") {
		const root = context.app.vault.getRoot();
		for (const child of root.children) {
			if (child instanceof TFile) {
				items.push({ path: child.path, type: "file", size: child.stat.size });
			} else if (child instanceof TFolder) {
				items.push({
					path: child.path + "/",
					type: "folder",
					childCount: child.children.length,
				});
			}
		}
	} else {
		const folder = context.app.vault.getAbstractFileByPath(pathPrefix.replace(/\/$/, ""));
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
				items.push({ path: child.path, type: "file", size: child.stat.size });
			} else if (child instanceof TFolder) {
				items.push({
					path: child.path + "/",
					type: "folder",
					childCount: child.children.length,
				});
			}
		}
	}

	items.sort((a, b) => a.path.localeCompare(b.path));

	if (cursorPath) {
		const idx = items.findIndex((item) => item.path > cursorPath);
		items = idx < 0 ? [] : items.slice(idx);
	}

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

async function handleVaultSearch(
	context: CommandContext,
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
		(params.limit as number) ?? context.settings.maxSearchResults,
		context.settings.maxSearchResults
	);
	const contextChars = (params.contextChars as number) ?? 120;
	const maxFilesScanned = Math.min(
		(params.maxFilesScanned as number) ?? context.settings.maxFilesScannedPerSearch,
		context.settings.maxFilesScannedPerSearch
	);

	const queryLower = query.toLowerCase();
	const files = context.app.vault.getMarkdownFiles();

	interface SearchMatch {
		path: string;
		line: number;
		snippet: string;
	}

	const matches: SearchMatch[] = [];
	let filesScanned = 0;

	for (const file of files) {
		if (filesScanned >= maxFilesScanned || matches.length >= limit) break;

		const matchesPrefix = pathPrefixes.some(
			(prefix) => prefix === "" || file.path.startsWith(prefix)
		);
		if (!matchesPrefix) continue;

		filesScanned++;

		let content: string;
		try {
			content = await context.app.vault.cachedRead(file);
		} catch {
			continue;
		}

		const contentLower = content.toLowerCase();
		let searchFrom = 0;
		let line = 1;
		let lineScanFrom = 0;

		while (searchFrom < contentLower.length && matches.length < limit) {
			const idx = contentLower.indexOf(queryLower, searchFrom);
			if (idx < 0) break;

			for (let i = lineScanFrom; i < idx; i++) {
				if (content[i] === "\n") {
					line++;
				}
			}
			lineScanFrom = idx;

			const snippetStart = Math.max(0, idx - Math.floor(contextChars / 2));
			const snippetEnd = Math.min(
				content.length,
				idx + query.length + Math.floor(contextChars / 2)
			);
			let snippet = content.slice(snippetStart, snippetEnd);
			if (snippetStart > 0) snippet = "..." + snippet;
			if (snippetEnd < content.length) snippet += "...";

			matches.push({ path: file.path, line, snippet });
			searchFrom = idx + query.length;
		}
	}

	return {
		ok: true,
		result: { matches },
	};
}

async function handleMetadataGet(
	context: CommandContext,
	params: Record<string, unknown>
): Promise<CommandResult> {
	const path = params.path as string | undefined;
	if (!path) {
		return {
			ok: false,
			error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
		};
	}

	const abstract = context.app.vault.getAbstractFileByPath(path);
	if (!abstract || !(abstract instanceof TFile)) {
		return {
			ok: false,
			error: { code: "E_NOT_FOUND", message: `File not found: ${path}` },
		};
	}

	const cache = context.app.metadataCache.getFileCache(abstract);
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

	let frontmatter: Record<string, unknown> | null = null;
	if (cache.frontmatter) {
		const { position: _position, ...rest } = cache.frontmatter;
		frontmatter = rest;
	}

	return {
		ok: true,
		result: {
			frontmatter,
			headings:
				cache.headings?.map((heading) => ({
					heading: heading.heading,
					level: heading.level,
				})) ?? [],
			links: cache.links?.map((link) => ({ link: link.link })) ?? [],
			tags: cache.tags?.map((tag) => tag.tag) ?? [],
		},
	};
}

async function handleTasksSearch(
	context: CommandContext,
	params: Record<string, unknown>
): Promise<CommandResult> {
	const pathPrefixes = (params.pathPrefixes as string[]) ?? [""];
	const completedValue = params.completed;
	const completed =
		typeof completedValue === "boolean" ? completedValue : undefined;
	const limit = Math.min((params.limit as number) ?? 100, 500);
	const query = (params.query as string | undefined) ?? null;
	const queryLower = query?.toLowerCase() ?? null;

	interface TaskItem {
		path: string;
		line: number;
		status: string;
		text: string;
	}

	const tasks: TaskItem[] = [];
	const files = context.app.vault.getMarkdownFiles();

	for (const file of files) {
		if (tasks.length >= limit) break;

		const matchesPrefix = pathPrefixes.some(
			(prefix) => prefix === "" || file.path.startsWith(prefix)
		);
		if (!matchesPrefix) continue;

		const cache = context.app.metadataCache.getFileCache(file);
		if (!cache?.listItems) continue;

		const taskItems = cache.listItems.filter((item) => item.task != null);
		if (taskItems.length === 0) continue;

		const filtered =
			completed === undefined
				? taskItems
				: taskItems.filter((item) => {
					const isDone = item.task === "x" || item.task === "X";
					return completed ? isDone : !isDone;
				});

		if (filtered.length === 0) continue;

		let content: string;
		try {
			content = await context.app.vault.cachedRead(file);
		} catch {
			continue;
		}

		const lines = content.split("\n");

		for (const item of filtered) {
			if (tasks.length >= limit) break;

			const lineIdx = item.position.start.line;
			if (lineIdx >= lines.length) continue;

			const raw = lines[lineIdx];
			const text = raw.replace(/^[\s>]*-\s*\[.\]\s*/, "");

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

async function handleMetadataBacklinks(
	context: CommandContext,
	params: Record<string, unknown>
): Promise<CommandResult> {
	const path = params.path as string | undefined;
	if (!path) {
		return {
			ok: false,
			error: { code: "E_MISSING_PARAM", message: "Missing required param: path" },
		};
	}

	const resolvedLinks = context.app.metadataCache.resolvedLinks;
	const backlinks: { path: string; count: number }[] = [];

	for (const sourcePath in resolvedLinks) {
		const targets = resolvedLinks[sourcePath];
		if (targets && targets[path] && targets[path] > 0) {
			backlinks.push({ path: sourcePath, count: targets[path] });
		}
	}

	backlinks.sort((a, b) => b.count - a.count);

	return {
		ok: true,
		result: { backlinks },
	};
}
