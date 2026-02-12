import type { App } from "obsidian";
import type { ClawdianSettings } from "../types";

export interface CommandError {
	code: string;
	message: string;
}

export type CommandResult =
	| { ok: true; result: unknown }
	| { ok: false; error: CommandError };

export type CommandHandler = (
	params: Record<string, unknown>
) => Promise<CommandResult>;

export interface CommandContext {
	app: App;
	settings: ClawdianSettings;
}

export const WRITE_COMMANDS = new Set<string>([
	"obsidian.note.replaceSelection",
	"obsidian.note.insertAtCursor",
	"obsidian.note.applyPatch",
	"obsidian.note.create",
]);
