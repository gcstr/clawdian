import { registerReadCommands } from "./read-commands";
import { registerWriteCommands } from "./write-commands";
import { summarizeArgs } from "./utils";
import { WRITE_COMMANDS } from "./types";
import type { App } from "obsidian";
import type { ClawdianSettings, NodeInvokeRequest } from "../types";
import type { ActivityLogger } from "../activity-log";
import type { CommandHandler, CommandResult } from "./types";

export class CommandDispatcher {
	private handlers = new Map<string, CommandHandler>();
	private app: App;
	private settings: ClawdianSettings;
	private logger: ActivityLogger;

	constructor(
		app: App,
		settings: ClawdianSettings,
		logger: ActivityLogger
	) {
		this.app = app;
		this.settings = settings;
		this.logger = logger;

		registerReadCommands(this.handlers, {
			app: this.app,
			settings: this.settings,
		});
		registerWriteCommands(this.handlers, {
			app: this.app,
			settings: this.settings,
		});
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

		if (WRITE_COMMANDS.has(request.command) && !this.settings.writesEnabled) {
			const error = {
				code: "E_WRITES_DISABLED",
				message: "Write commands are disabled in plugin settings",
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

		if (!result.ok) {
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

		const payloadJSON = JSON.stringify(result.result);
		const responseBytes = new TextEncoder().encode(payloadJSON).byteLength;
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
	}
}
