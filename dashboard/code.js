"use strict";
// The CODE page's server side (api/code): a CODE set's files to read and edit, a syntax check, and where a save goes,
// by what the set is:
//   place:   your own folder or file (a set of your sets file, dir:<path>, file:<path>, the library's folder of this
//            machine): written in place (no commit: yours to commit);
//   version: the library's pasted or uploaded CODE (a repo ChronAL keeps): each save a new commit, pinned; the set at
//            an older version is <name>@<commit>;
//   copy:    CODE that isn't yours to change (ChronAL's example bot, a pull of your account, a link's commit, a set at a
//            git revision): a save makes your copy, in the library (a version kept there).
// A save trusts its new version when the one it came from was (CODE of yours, or a trusted version of others').
// The runs that used a set: their setup files' source names it (a set chosen for the run) or its folder.
const fs = require("node:fs"),
	path = require("node:path");
const acorn = require("acorn");
const C = require("../lib/code_sets");
const LIB = require("../lib/library");
const GIT = require("../lib/git_tree");

const TEXT = /\.(m?js|cjs|tsx?|json|md|txt)$/i,
	MAX_FILE = 2 << 20,
	MAX_FILES = 500;

// what a save does to a set: { mode, why } (none: read-only here)
function modeOf(s) {
	if (s.code.build) return { mode: "none", why: "built by its build step: edit its sources where they are" };
	if (s.builtin) return { mode: "copy", why: "ChronAL's example bot: a save makes your copy (in the library)" };
	if (s.pull) return { mode: "copy", why: "a pull of your account (as on live then): a save makes your copy (in the library)" };
	if (s.lib) {
		const k = s.lib.kind;
		if (k === "path") return { mode: "place", why: "a folder or file of this machine: written in place" };
		if (s.name.includes("@")) return { mode: "copy", why: "an older version: a save makes a copy" };
		if (k === "paste" || k === "upload") return { mode: "version", why: "kept by ChronAL: each save a new version (a commit), " + s.name + "@<commit> the older ones" };
		return { mode: "copy", why: "others' CODE pinned to a commit of its link: a save makes your copy (in the library)" };
	}
	if (s.code.git) return { mode: "copy", why: "a git revision: a save makes a copy (in the library)" };
	return { mode: "place", why: "your folder: written in place (commit it yourself if it's a repo)" };
}

// a set's root on disk (a git set: its commit's tree, extracted) and whether it is one file
function rootOf(s) {
	const code = s.code.git ? GIT.inTree(s.code) : s.code;
	return code.file ? { file: code.file, dir: path.dirname(code.file) } : { dir: code.dir, file: null };
}

// its text files (JS, TS, JSON, text; not node_modules or .git), relative to its root
function filesOf(s) {
	const r = rootOf(s);
	if (r.file) return fs.existsSync(r.file) ? [{ path: path.basename(r.file), size: fs.statSync(r.file).size }] : [];
	const out = [];
	const walk = (d, rel) => {
		let es = [];
		try {
			es = fs.readdirSync(d, { withFileTypes: true });
		} catch (e) {
			return;
		}
		for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
			if (out.length >= MAX_FILES) return;
			if (e.isDirectory()) {
				if (!e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(d, e.name), rel ? rel + "/" + e.name : e.name);
			} else if (e.isFile() && TEXT.test(e.name)) out.push({ path: rel ? rel + "/" + e.name : e.name, size: fs.statSync(path.join(d, e.name)).size });
		}
	};
	if (r.dir && fs.existsSync(r.dir)) walk(r.dir, "");
	return out;
}

// a file of the set by its path (never outside its root)
function fileAt(s, rel) {
	const r = rootOf(s);
	if (r.file) return rel === path.basename(r.file) ? r.file : null;
	const f = path.resolve(r.dir, String(rel));
	return f.startsWith(path.resolve(r.dir) + path.sep) && TEXT.test(f) ? f : null;
}

const setOf = (name) => {
	try {
		return C.codeSet(name);
	} catch (e) {
		return null;
	}
};

/** GET api/code: the sets (the picker's groups), each with what a save does */
function list() {
	const cs = C.loadCodeSets();
	return [200, { sets: cs.sets.map((s) => ({ name: s.name, group: s.builtin ? "builtin" : s.lib ? "others" : s.name.startsWith("pull:") ? "pulls" : "yours", kind: s.lib ? s.lib.kind : s.kind, note: s.note || null, ...modeOf(s) })), problems: cs.problems }];
}

/** GET api/code/files?set=: its files, what a save does, where it is */
function files(q) {
	const s = setOf(q.get("set") || "");
	if (!s) return [404, { reason: `no CODE set ${q.get("set")}` }];
	const r = rootOf(s);
	return [200, { set: s.name, ...modeOf(s), copy_of: (s.lib && s.lib.copy_of) || null, where: r.file || r.dir, commit: s.git ? s.git.commit : null, trusted: s.lib && s.git ? LIB.trusted(s.git.commit) : null, files: filesOf(s) }];
}

/** GET api/code/file?set=&path=: { text } */
function read(q) {
	const s = setOf(q.get("set") || ""),
		f = s && fileAt(s, q.get("path") || "");
	if (!f || !fs.existsSync(f)) return [404, { reason: `no file ${q.get("path")} in ${q.get("set")}` }];
	return [200, { text: fs.readFileSync(f, "utf8") }];
}

/** A file's syntax: [{ line, column, message }] (JS: as a script, else as a module; JSON) */
function syntax(file, text) {
	if (/\.json$/i.test(file)) {
		try {
			JSON.parse(text);
			return [];
		} catch (e) {
			const at = /position (\d+)/.exec(e.message), pos = at ? Number(at[1]) : 0, before = text.slice(0, pos).split("\n");
			return [{ line: before.length, column: before[before.length - 1].length, message: e.message.replace(/^JSON\.parse: /, "") }];
		}
	}
	if (!/\.(m?js|cjs)$/i.test(file)) return [];
	const opts = { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true };
	try {
		acorn.parse(text, { ...opts, sourceType: "script" });
		return [];
	} catch (e) {
		if (/\b(import|export)\b/.test(text))
			try {
				acorn.parse(text, { ...opts, sourceType: "module" });
				return [];
			} catch (e2) {}
		return [{ line: e.loc ? e.loc.line : 1, column: e.loc ? e.loc.column : 0, message: e.message.replace(/ \(\d+:\d+\)$/, "") }];
	}
}

/**
 * POST api/code/file { set, path, text, action: "check" | "save", name?: a copy's name }: check: its syntax; save: as
 * the set's mode says (a file with a syntax problem is saved only with force: true). -> { problems, saved: { mode, set,
 * commit?, trusted? } }
 */
async function write(b) {
	const s = b && typeof b.set === "string" ? setOf(b.set) : null;
	if (!s) return [404, { reason: `no CODE set ${b && b.set}` }];
	if (typeof b.path !== "string" || typeof b.text !== "string") return [400, { reason: "path and text" }];
	if (Buffer.byteLength(b.text) > MAX_FILE) return [400, { reason: `over ${MAX_FILE >> 20} MB` }];
	const f = fileAt(s, b.path);
	if (!f) return [400, { reason: `path: a JS, TS, JSON or text file inside ${b.set}` }];
	const problems = syntax(b.path, b.text);
	if (b.action === "check") return [200, { problems }];
	if (b.action !== "save") return [400, { reason: "action: check or save" }];
	if (problems.length && b.force !== true) return [422, { reason: "a syntax problem: save it anyway with force", problems }];
	const { mode, why } = modeOf(s);
	if (mode === "none") return [409, { reason: why }];
	if (mode === "place") {
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, b.text);
		return [200, { problems, saved: { mode, set: s.name } }];
	}
	// a version: every file of the set, this one changed (a library entry's new commit, or a new entry: the copy)
	const r = rootOf(s),
		all = filesOf(s).map((x) => ({ path: x.path, text: x.path === b.path ? b.text : fs.readFileSync(r.file || path.join(r.dir, x.path), "utf8") }));
	if (!all.some((x) => x.path === b.path)) all.push({ path: b.path, text: b.text });
	const was = s.lib && s.git ? s.git.commit : null,
		trustedBase = s.lib ? !!(was && LIB.trusted(was)) : true; // (ChronAL's, a pull's, your folders' at a revision: yours)
	let name, res;
	try {
		if (mode === "version") {
			name = s.name;
			res = s.lib.kind === "paste" && all.length === 1 ? await LIB.add({ paste: { file: all[0].path, text: all[0].text }, name }) : await LIB.add({ files: all, name });
		} else {
			name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
			if (!name || !LIB.NAME.test(name)) return [400, { reason: "name: your copy's name (1-40 letters, digits, _ . -; a letter or digit first)" }];
			const taken = C.loadCodeSets().sets.map((x) => x.name);
			if (taken.some((x) => x.toLowerCase() === name.toLowerCase())) return [409, { reason: `a CODE set named ${name} exists: another name, or open ${name} and save there` }];
			// (the copy keeps who runs which slot: the set's entries and classes)
			res = await LIB.add({ files: all, name, taken, copyOf: s.lib && s.lib.copy_of ? s.lib.copy_of : s.name.replace(/@.*$/, ""), entries: s.entries, classes: s.classes });
		}
	} catch (e) {
		return [400, { reason: e.message }];
	}
	if (res.commit && trustedBase) LIB.trust(res.commit, { name, source: "the CODE page: " + (mode === "version" ? "a new version of " : "a copy of ") + s.name + (was ? "@" + was.slice(0, 7) : ""), by: "the dashboard's CODE editor" });
	return [200, { problems, saved: { mode, set: name, commit: res.commit, trusted: res.commit ? LIB.trusted(res.commit) : null, ...(mode === "copy" ? { from: s.name } : {}) } }];
}

/** GET api/code/runs?set=: the runs (of the live dir's setup files, its folders' too) that ran this set: its name chosen, or its folder */
function runs(q, dir) {
	const s = setOf(q.get("set") || "");
	if (!s) return [404, { reason: `no CODE set ${q.get("set")}` }];
	const base = s.name.replace(/@.*$/, ""),
		roots = [s.code.dir, s.code.file, s.code.git && s.code.git.repo].filter(Boolean).map((p) => path.resolve(p)),
		under = (p) => p && roots.some((r) => path.resolve(p) === r || path.resolve(p).startsWith(r + path.sep));
	const out = [];
	const fsx = [];
	for (const { sub, dir: d } of require("../lib/runs").liveDirs(dir))
		try {
			fsx.push(...fs.readdirSync(d).filter((f) => f.endsWith(".setup.json")).map((f) => (sub ? sub + "/" : "") + f));
		} catch (e) {}
	for (const f of fsx) {
		let x;
		try {
			x = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		} catch (e) {
			continue;
		}
		const src = (x && x.source) || {},
			named = src.code_set && String(src.code_set.name || "").replace(/@.*$/, "") === base,
			chars = Object.values(src.characters || {});
		if (named || chars.some((c) => c && (under(c.code_dir) || under(c.file) || (c.git && under(c.git.repo))))) out.push(f.replace(/\.setup\.json$/, ""));
	}
	return [200, { set: s.name, runs: out }];
}

module.exports = { list, files, read, write, runs, syntax, modeOf };
