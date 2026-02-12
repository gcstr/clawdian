export function summarizeArgs(params: Record<string, unknown>): string {
	const keys = Object.keys(params);
	if (keys.length === 0) return "{}";

	const parts: string[] = [];
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string") {
			parts.push(`${key}="${value.length > 30 ? value.slice(0, 30) + "..." : value}"`);
		} else {
			parts.push(`${key}=${JSON.stringify(value)}`);
		}
	}

	const summary = parts.join(", ");
	return summary.length > 80 ? summary.slice(0, 77) + "..." : summary;
}
