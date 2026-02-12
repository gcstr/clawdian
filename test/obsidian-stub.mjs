export class MarkdownView {
	constructor() {
		this.editor = {
			getSelection() {
				return "";
			},
			replaceSelection() {},
			replaceRange() {},
			getCursor() {
				return { line: 0, ch: 0 };
			},
		};
	}
}

export class TFile {
	constructor(path = "") {
		this.path = path;
		this.name = path.split("/").pop() || path;
		const extIdx = this.name.lastIndexOf(".");
		this.basename = extIdx >= 0 ? this.name.slice(0, extIdx) : this.name;
		this.extension = extIdx >= 0 ? this.name.slice(extIdx + 1) : "";
		this.stat = { size: 0 };
	}
}

export class TFolder {
	constructor(path = "", children = []) {
		this.path = path;
		this.children = children;
	}
}
