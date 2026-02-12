import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(path.join(baseDir, "obsidian-stub.mjs")).href;

export async function resolve(specifier, context, defaultResolve) {
	if (specifier === "obsidian") {
		return {
			url: stubUrl,
			shortCircuit: true,
		};
	}

	try {
		return await defaultResolve(specifier, context, defaultResolve);
	} catch (err) {
		if (
			err?.code === "ERR_MODULE_NOT_FOUND" &&
			(specifier.startsWith("./") || specifier.startsWith("../")) &&
			!path.extname(specifier)
		) {
			return defaultResolve(`${specifier}.ts`, context, defaultResolve);
		}
		throw err;
	}
}
