import { ItemView, WorkspaceLeaf } from "obsidian";

export const ACTIVITY_LOG_VIEW_TYPE = "clawdian-activity-log";

export interface LogEntry {
	timestamp: number;
	command: string;
	argsSummary: string;
	ok: boolean;
	error?: string;
	durationMs: number;
	responseBytes: number;
}

export class ActivityLogger {
	private entries: LogEntry[] = [];
	private maxEntries = 200;
	private callbacks: (() => void)[] = [];

	log(entry: LogEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}
		for (const cb of this.callbacks) {
			try {
				cb();
			} catch (err) {
				console.error("[Clawdian] Error in activity log callback:", err);
			}
		}
	}

	getEntries(): readonly LogEntry[] {
		return this.entries;
	}

	onUpdate(cb: () => void): void {
		this.callbacks.push(cb);
	}

	offUpdate(cb: () => void): void {
		const idx = this.callbacks.indexOf(cb);
		if (idx >= 0) this.callbacks.splice(idx, 1);
	}
}

export class ActivityLogView extends ItemView {
	private showErrorsOnly = false;

	constructor(leaf: WorkspaceLeaf, private logger: ActivityLogger) {
		super(leaf);
	}

	getViewType(): string {
		return ACTIVITY_LOG_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Clawdian Activity Log";
	}

	getIcon(): string {
		return "list";
	}

	async onOpen(): Promise<void> {
		this.logger.onUpdate(this.onLogUpdate);
		this.render();
	}

	async onClose(): Promise<void> {
		this.logger.offUpdate(this.onLogUpdate);
	}

	private onLogUpdate = (): void => {
		this.render();
	};

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("clawdian-activity-log");

		// Header
		container.createEl("h4", { text: "Activity Log" });

		// Filter buttons
		const filterRow = container.createDiv({ cls: "clawdian-log-filters" });
		const allBtn = filterRow.createEl("button", {
			text: "All",
			cls: this.showErrorsOnly ? "" : "mod-cta",
		});
		allBtn.addEventListener("click", () => {
			this.showErrorsOnly = false;
			this.render();
		});
		const errBtn = filterRow.createEl("button", {
			text: "Errors only",
			cls: this.showErrorsOnly ? "mod-cta" : "",
		});
		errBtn.addEventListener("click", () => {
			this.showErrorsOnly = true;
			this.render();
		});

		// Entries
		let entries = this.logger.getEntries();
		if (this.showErrorsOnly) {
			entries = entries.filter((e) => !e.ok);
		}

		if (entries.length === 0) {
			container.createEl("p", {
				text: "No activity yet.",
				cls: "clawdian-log-empty",
			});
			return;
		}

		const table = container.createEl("table", { cls: "clawdian-log-table" });
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		for (const header of ["Time", "Command", "Args", "Status", "Bytes", "Duration"]) {
			headerRow.createEl("th", { text: header });
		}

		const tbody = table.createEl("tbody");
		// Show most recent first
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			const row = tbody.createEl("tr", {
				cls: entry.ok ? "clawdian-log-ok" : "clawdian-log-error",
			});

			const time = new Date(entry.timestamp);
			row.createEl("td", {
				text: time.toLocaleTimeString(),
				cls: "clawdian-log-time",
			});
			row.createEl("td", {
				text: entry.command.replace("obsidian.", ""),
				cls: "clawdian-log-command",
			});
			row.createEl("td", {
				text: entry.argsSummary,
				cls: "clawdian-log-args",
			});
			row.createEl("td", {
				text: entry.ok ? "OK" : entry.error || "Error",
				cls: "clawdian-log-status",
			});
			row.createEl("td", {
				text: entry.responseBytes > 0 ? formatBytes(entry.responseBytes) : "-",
				cls: "clawdian-log-bytes",
			});
			row.createEl("td", {
				text: `${entry.durationMs}ms`,
				cls: "clawdian-log-duration",
			});
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
