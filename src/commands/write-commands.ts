import { MarkdownView, TFile } from "obsidian";
import type { CommandContext, CommandHandler, CommandResult } from "./types";

export function registerWriteCommands(
	handlers: Map<string, CommandHandler>,
	context: CommandContext
): void {
	handlers.set("obsidian.note.replaceSelection", (params) =>
		handleReplaceSelection(context, params)
	);
	handlers.set("obsidian.note.insertAtCursor", (params) =>
		handleInsertAtCursor(context, params)
	);
	handlers.set("obsidian.note.applyPatch", (params) =>
		handleApplyPatch(context, params)
	);
	handlers.set("obsidian.note.create", (params) =>
		handleNoteCreate(context, params)
	);
}

async function handleReplaceSelection(
	context: CommandContext,
	params: Record<string, unknown>
): Promise<CommandResult> {
	const newText = params.newText as string | undefined;
	if (newText == null) {
		return {
			ok: false,
			error: { code: "E_MISSING_PARAM", message: "Missing required param: newText" },
		};
	}

	const view = context.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		return {
			ok: false,
			error: { code: "E_NO_EDITOR", message: "No active markdown editor" },
		};
	}

	view.editor.replaceSelection(newText);
	return { ok: true, result: { applied: true } };
}

async function handleInsertAtCursor(
	context: CommandContext,
	params: Record<string, unknown>
): Promise<CommandResult> {
	const text = params.text as string | undefined;
	if (text == null) {
		return {
			ok: false,
			error: { code: "E_MISSING_PARAM", message: "Missing required param: text" },
		};
	}

	const view = context.app.workspace.getActiveViewOfType(MarkdownView);
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

async function handleApplyPatch(
	context: CommandContext,
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

	const writeBytes = new TextEncoder().encode(newText).byteLength;
	if (writeBytes > context.settings.maxResponseBytes) {
		return {
			ok: false,
			error: {
				code: "E_TOO_LARGE",
				message: `Write payload ${writeBytes} bytes exceeds limit of ${context.settings.maxResponseBytes}`,
			},
		};
	}

	const abstract = context.app.vault.getAbstractFileByPath(path);
	if (!abstract || !(abstract instanceof TFile)) {
		return {
			ok: false,
			error: { code: "E_NOT_FOUND", message: `File not found: ${path}` },
		};
	}

	switch (mode) {
		case "replaceWhole": {
			await context.app.vault.modify(abstract, newText);
			break;
		}
		case "append": {
			const existing = await context.app.vault.read(abstract);
			await context.app.vault.modify(abstract, existing + newText);
			break;
		}
		case "prepend": {
			const existing = await context.app.vault.read(abstract);
			await context.app.vault.modify(abstract, newText + existing);
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

			const content = await context.app.vault.read(abstract);
			const lines = content.split("\n");

			const fromValidation = validatePosition(lines, from, "from");
			if (fromValidation) {
				return {
					ok: false,
					error: { code: "E_INVALID_PARAM", message: fromValidation },
				};
			}

			const toValidation = validatePosition(lines, to, "to");
			if (toValidation) {
				return {
					ok: false,
					error: { code: "E_INVALID_PARAM", message: toValidation },
				};
			}

			const startOffset = lineChToOffset(lines, from);
			const endOffset = lineChToOffset(lines, to);
			if (startOffset > endOffset) {
				return {
					ok: false,
					error: {
						code: "E_INVALID_PARAM",
						message: "Invalid range: 'from' must be before or equal to 'to'",
					},
				};
			}

			const result = content.slice(0, startOffset) + newText + content.slice(endOffset);
			await context.app.vault.modify(abstract, result);
			break;
		}
	}

	return { ok: true, result: { applied: true } };
}

function validatePosition(
	lines: string[],
	position: { line: number; ch: number },
	label: string
): string | null {
	if (!Number.isInteger(position.line) || !Number.isInteger(position.ch)) {
		return `${label} position must use integer {line, ch}`;
	}

	if (position.line < 0 || position.line >= lines.length) {
		return `${label}.line out of range (file has ${lines.length} lines)`;
	}

	const lineLength = lines[position.line].length;
	if (position.ch < 0 || position.ch > lineLength) {
		return `${label}.ch out of range for line ${position.line} (0-${lineLength})`;
	}

	return null;
}

function lineChToOffset(lines: string[], position: { line: number; ch: number }): number {
	let offset = 0;
	for (let i = 0; i < position.line; i++) {
		offset += lines[i].length + 1;
	}
	return offset + position.ch;
}

async function handleNoteCreate(
	context: CommandContext,
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

	const writeBytes = new TextEncoder().encode(content).byteLength;
	if (writeBytes > context.settings.maxResponseBytes) {
		return {
			ok: false,
			error: {
				code: "E_TOO_LARGE",
				message: `Content ${writeBytes} bytes exceeds limit of ${context.settings.maxResponseBytes}`,
			},
		};
	}

	const existing = context.app.vault.getAbstractFileByPath(path);
	if (existing) {
		return {
			ok: false,
			error: {
				code: "E_ALREADY_EXISTS",
				message: `File already exists: ${path}`,
			},
		};
	}

	const parentPath = path.substring(0, path.lastIndexOf("/"));
	if (parentPath) {
		const parentExists = context.app.vault.getAbstractFileByPath(parentPath);
		if (!parentExists) {
			try {
				await context.app.vault.createFolder(parentPath);
			} catch {
				// Parent folder may have been created concurrently.
			}
		}
	}

	await context.app.vault.create(path, content);
	return { ok: true, result: { created: true, path } };
}
