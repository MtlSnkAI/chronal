"use strict";
// CODE sets: named CODE a run can take instead of its setup's (chronal run --code-set NAME). A set is a setup's `code` block
// (dir, recursive, entry, file, prelude, append, build, fit) plus `entries` (a character's entry slot when it isn't the
// slot named after it), `classes` ({ <class> | "*": <slot> }: the entry slot by class, for a character entries don't name)
// and a `note`. A character's entry: entries[name], else classes[its class], else classes["*"], else entry, else the slot
// named after it. Where they come from:
//   - built in: example, ChronAL's example bot (codes/example: priest, merchant, fighter for the rest)
//   - the file config code_sets (format chronal-code-sets/1): { "format": "chronal-code-sets/1", "sets": { "<name>": <set> } };
//     paths relative to that file. A set's "pull": "latest" | "<account>" | "<account>/<time>" takes that pull's CODE
//     slots (chronal pull) as its dir: every character runs its own live slot (a slot number its CODE writes in a
//     load_code or require_code loads that slot: fit.calls from the pull's slots.json).
//     A set's "git": "<rev>" (or { repo, rev }) reads its paths inside that git repo from that commit, branch or tag
//     (git_tree.js; repo default: the repo of its build cwd, dir or file).
//   - every pull, without a file: pull:latest, pull:<account> (its latest), pull:<account>/<time>
//   - the CODE library's (library.js: others' CODE from a link, a paste or an upload, at its pinned commit; a folder of
//     this machine as it is), by its name; a set of the file's of that name wins
//   - any folder or file: dir:<path>, file:<path> (relative to the cwd)
//   - any of those but a pull at a git revision: <set>@<rev>, e.g. local@HEAD~1, local@main, dir:../x@v1.2
//   A revision is pinned to its commit when the set is read (a branch moves; a run keeps the commit it ran).
//   chronal code-sets [--names A[:class],B]    list them (with --names: the entry each set runs for those characters)
const fs = require("node:fs"),
	path = require("node:path");
const { config } = require("./config");
const { listPulls, latestPull } = require("./pull");
const GIT = require("./git_tree");
const LIB = require("./library");
const F = require("./fit");

const ROOT = path.join(__dirname, "..");
const FORMAT = "chronal-code-sets/1",
	SET_KEYS = ["note", "pull", "dir", "recursive", "entry", "entries", "classes", "file", "prelude", "append", "build", "git", "fit"];
// the built-in set: ChronAL's example bot
const EXAMPLE = { note: "ChronAL's example bot: a fighter for any class, a priest, a merchant", dir: path.join(__dirname, "..", "codes", "example"), classes: { priest: "priest", merchant: "merchant", "*": "fighter" } };
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// "latest" | "<account>" | "<account>/<time>" -> that pull, or null
function findPull(ref, pullsDir) {
	if (ref === "latest") return latestPull(pullsDir);
	const [account, time] = String(ref).split("/");
	if (!time) return latestPull(pullsDir, account);
	return listPulls(pullsDir, account).find((p) => path.basename(p.dir) === time) || null;
}

/** A set from its definition (paths relative to base) -> { name, kind, note, code, entries, pull } ; problems pushed */
function setOf(name, def, base, pullsDir, problems) {
	const w = `code set ${name}: `;
	if (!isObj(def)) return problems.push(`${w}an object`), null;
	const unknown = Object.keys(def).filter((k) => !SET_KEYS.includes(k));
	if (unknown.length) return problems.push(`${w}${unknown.join(", ")}: unknown key (known: ${SET_KEYS.join(", ")})`), null;
	const abs = (p) => path.resolve(base, String(p)),
		kinds = ["pull", "dir", "file"].filter((k) => def[k] != null);
	if (def.pull != null && kinds.length > 1) return problems.push(`${w}pull and ${kinds.filter((k) => k !== "pull").join(", ")}: a pull's CODE is its own dir`), null;
	if (!kinds.length) return problems.push(`${w}no CODE: pull, dir or file`), null;
	if (def.entries != null && !(isObj(def.entries) && Object.values(def.entries).every((v) => typeof v === "string"))) return problems.push(`${w}entries: { <character>: <slot> }`), null;
	if (def.classes != null && !(isObj(def.classes) && Object.values(def.classes).every((v) => typeof v === "string" && v))) return problems.push(`${w}classes: { <class> | "*": <slot> }`), null;
	if (def.fit != null && F.fitProblems(def.fit).length) return problems.push(...F.fitProblems(def.fit).map((x) => `${w}fit: ${x}`)), null;
	let pull = null,
		dir = def.dir == null ? null : abs(def.dir);
	if (def.pull != null) {
		pull = findPull(def.pull, pullsDir);
		if (!pull) return problems.push(`${w}pull ${JSON.stringify(def.pull)}: no such pull in ${pullsDir} (chronal pull)`), null;
		if (!pull.meta.code) return problems.push(`${w}pull ${path.relative(pullsDir, pull.dir)} has no CODE (pulled with --no-code)`), null;
		dir = path.join(pull.dir, "code");
	}
	const code = {
		...(dir ? { dir } : {}), ...(def.recursive ? { recursive: true } : {}), ...(def.entry != null ? { entry: String(def.entry) } : {}), ...(def.file != null ? { file: abs(def.file) } : {}),
		...(def.prelude != null ? { prelude: String(def.prelude) } : {}), append: [].concat(def.append == null ? [] : def.append).map(abs),
		...(isObj(def.build) ? { build: { cmd: def.build.cmd, cwd: abs(def.build.cwd == null ? "." : def.build.cwd) } } : {}),
		...(def.fit != null ? { fit: structuredClone(def.fit) } : pull ? pullFit(pull) : {}),
	};
	let git = null;
	if (def.git != null) {
		const g = typeof def.git === "string" ? { rev: def.git } : def.git;
		if (pull) return problems.push(`${w}git: a pull's CODE has no revisions`), null;
		if (!isObj(g) || typeof g.rev !== "string" || !g.rev || Object.keys(g).some((k) => !["repo", "rev"].includes(k))) return problems.push(`${w}git: a revision (a commit, branch or tag) or { repo, rev }`), null;
		try {
			git = revOf(g.repo != null ? abs(g.repo) : repoPath(code), g.rev);
		} catch (e) {
			return problems.push(`${w}git: ${e.message}`), null;
		}
		code.git = { repo: git.repo, rev: git.commit };
	}
	return {
		name, kind: pull ? "pull" : code.file ? "file" : "dir", note: def.note == null ? null : String(def.note), code, entries: def.entries ? { ...def.entries } : {}, classes: def.classes ? { ...def.classes } : {},
		pull: pull ? { dir: pull.dir, account: pull.account, pulled_at: pull.meta.pulled_at, characters: pull.meta.code.characters } : null,
		git: git && { rev: git.rev, commit: git.commit },
	};
}

// a pull's slot numbers its CODE writes (load_code(3)): { fit: { calls: { 3: "<the slot>" } } }, or none
function pullFit(pull) {
	const dir = path.join(pull.dir, "code");
	let list;
	try {
		list = JSON.parse(fs.readFileSync(path.join(dir, "slots.json"), "utf8"));
	} catch (e) {
		return {};
	}
	const written = new Set();
	for (const { file } of F.slotFiles(dir)) for (const c of F.facts(fs.readFileSync(file, "utf8")).calls) if (c.key != null && /^\d+$/.test(c.key)) written.add(String(Number(c.key)));
	const calls = Object.fromEntries(list.filter((x) => x.file && written.has(x.slot)).map((x) => [x.slot, F.toFilename(x.file.replace(/\.js$/, ""))]));
	return Object.keys(calls).length ? { fit: { calls } } : {};
}

// where a code block's repo is: its git repo's, else its build's cwd, dir or file
const repoPath = (code) => (code.git && code.git.repo) || (code.build && code.build.cwd) || code.dir || code.file;
function revOf(repo, rev) {
	return GIT.resolve({ repo, rev });
}

// a set at a git revision: its CODE from that commit (pinned now), named <set>@<rev>
function atRev(set, rev, name) {
	if (set.pull) throw new Error(`--code-set ${name}: a pull's CODE has no revisions`);
	const g = revOf(repoPath(set.code), rev);
	return { ...set, name, code: { ...set.code, git: { repo: g.repo, rev: g.commit } }, git: { rev, commit: g.commit } };
}

/**
 * Every CODE set: the file's (config code_sets), the library's (with lib: library.js info()), then one per pull.
 * @returns {{ sets: object[], problems: string[], file: string|null }}
 */
function loadCodeSets({ file = config().code_sets, pullsDir = config().pulls_dir } = {}) {
	const sets = [],
		problems = [];
	if (file) {
		let raw = null;
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (e) {
			problems.push(`${file}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
		}
		if (raw) {
			if (raw.format !== FORMAT || !isObj(raw.sets)) problems.push(`${file}: not a list of CODE sets ({ "format": "${FORMAT}", "sets": { <name>: <set> } })`);
			else
				for (const [name, def] of Object.entries(raw.sets)) {
					if (!/^[\w.-]+$/.test(name)) problems.push(`code set ${JSON.stringify(name)}: a name of letters, digits, _ . -`);
					else {
						const s = setOf(name, def, path.dirname(file), pullsDir, problems);
						if (s) sets.push(s);
					}
				}
		}
	}
	for (const e of LIB.list()) {
		if (sets.some((s) => s.name === e.name)) problems.push(`the library's ${e.name}: ${file} has a set of that name (that one is used)`);
		else if (e.broken) problems.push(`the library's ${e.name}: ${e.broken}`);
		else {
			const s = setOf(e.name, LIB.setDef(e), e.dir, pullsDir, problems);
			if (s) sets.push({ ...s, lib: LIB.info(e) });
		}
	}
	// (its CODE forms no party: chronal new has the sim's invites form it, party_form)
	if (!sets.some((s) => s.name === "example")) sets.push({ ...setOf("example", EXAMPLE, ROOT, pullsDir, problems), builtin: true, party_form: "harness" });
	const pulls = listPulls(pullsDir);
	if (pulls.length) {
		const add = (name, ref) => {
			const s = setOf(name, { pull: ref }, process.cwd(), pullsDir, []);
			if (s) sets.push(s);
		};
		add("pull:latest", "latest");
		for (const a of [...new Set(pulls.map((p) => p.account))]) add(`pull:${a}`, a);
		for (const p of pulls) add(`pull:${p.account}/${path.basename(p.dir)}`, `${p.account}/${path.basename(p.dir)}`);
	}
	return { sets, problems, file: file || null };
}

/** The set named `name` (a listed one, dir:<path> / file:<path>, any of them @<rev>); throws listing the names when there's none */
function codeSet(name, o = {}) {
	try {
		return plainSet(name, o);
	} catch (e) {
		const at = name.lastIndexOf("@");
		if (at <= 0 || at === name.length - 1) throw e;
		let base;
		try {
			base = plainSet(name.slice(0, at), o);
		} catch (x) {
			throw e;
		}
		try {
			const s = atRev(base, name.slice(at + 1), name);
			// the library's: fitted at that commit
			if (base.lib && s.code.dir) {
				const { fit, ...code } = s.code,
					f = LIB.fitDef(LIB.get(base.name), s.git.commit);
				s.code = { ...code, ...(f ? { fit: f } : {}) };
			}
			return s;
		} catch (x) {
			throw new Error(x.message.startsWith("--code-set") ? x.message : `--code-set ${name}: ${x.message}`);
		}
	}
}
function plainSet(name, o) {
	const m = /^(dir|file):(.+)$/.exec(name);
	if (m) {
		const p = path.resolve(m[2]);
		if (!fs.existsSync(p)) throw new Error(`--code-set ${name}: no such ${m[1] === "dir" ? "directory" : "file"} ${p}`);
		return { name, kind: m[1], note: null, code: { [m[1]]: p, append: [] }, entries: {}, classes: {}, pull: null };
	}
	const { sets, problems, file } = loadCodeSets(o),
		s = sets.find((x) => x.name === name);
	if (s) return s;
	throw new Error(`--code-set ${name}: no such set${problems.length ? " (" + problems.join("; ") + ")" : ""}. Known: ${sets.map((x) => x.name).join(", ") || "none"}${file ? "" : " (no config code_sets file)"}; or dir:<path>, file:<path>; any but a pull @<rev> (a commit, branch or tag)`);
}

/** A character's setup code block from a set: the set's entry for it (entries, else classes by its class, else entry,
 * else the slot named after it) */
function codeFor(set, name, cls) {
	const { entry, ...code } = set.code,
		byClass = set.classes || {};
	return code.file ? { ...code } : { ...code, entry: set.entries[name] || byClass[cls] || byClass["*"] || entry || name };
}

// a set's code block as it is on disk: a git set's in its commit's tree (extracted)
const onDisk = (set) => (set.code.git ? GIT.inTree(set.code) : set.code);

/** The slots a set's dir holds now (a build set: as last built; named as the game names them: fit.js slotFiles), null
 * for a file set or a dir not built yet */
function slotNames(set) {
	const code = onDisk(set);
	if (!code.dir || !fs.existsSync(code.dir)) return null;
	return F.slotFiles(code.dir, code.recursive).map((x) => x.slot).sort();
}

/**
 * The characters whose entry a set lacks: [{ name, entry, slots }] (slots: what the set's dir holds; its build run
 * first with build(spec)). A file set, or a dir not there (build off), lacks none that can be told. code_names: the
 * setup's (a slot it renames is there under its new name too).
 */
function missingEntries(set, names, { build = null, code_names = null, classOf = () => null } = {}) {
	if (set.code.file || !set.code.dir) return [];
	const code = onDisk(set);
	if (code.build && build) build(code.build);
	const slots = slotNames(set);
	if (slots == null) return [];
	const has = new Set([...slots, ...slots.map((s) => (code_names && Object.hasOwn(code_names, s) ? code_names[s] : s))].map((s) => s.toLowerCase()));
	return names.map((name) => ({ name, entry: codeFor(set, name, classOf(name)).entry, slots })).filter((m) => !has.has(F.toFilename(m.entry).toLowerCase()));
}

/**
 * --missing "A=idle,B=exclude,C=core,*=idle" -> { A: "idle", B: "exclude", C: "slot:core", "*": "idle" }; a slot named
 * idle or exclude: slot:<name>. Throws on a malformed one.
 */
function parseMissing(text) {
	const out = {};
	for (const part of String(text).split(",").map((x) => x.trim()).filter(Boolean)) {
		const m = /^([A-Za-z0-9]{1,12}|\*)=(.+)$/.exec(part);
		if (!m) throw new Error(`--missing ${part}: NAME=SLOT, NAME=idle or NAME=exclude (* for every character without one)`);
		out[m[1]] = m[2] === "idle" || m[2] === "exclude" || m[2].startsWith("slot:") ? m[2] : "slot:" + m[2];
	}
	return out;
}

/**
 * The choice for each character without an entry (lacking: [{ name, entry, slots }]): given's (--missing: its name,
 * else "*"), else asked on a terminal (a slot, idle or exclude); without either stop(problems, { missing }) is called.
 * Warns (warn) of each choice, and of an excluded one the others' extra CODE still names.
 * @param {object} o  { given, characters: [{ name, extra }] (all of the setup), check (no asking, no warnings),
 *   what(m): the line naming m's lack, where: the CODE's name, stop, warn, interactive (default: a terminal) }
 * @returns {Promise<object>} { <name>: "slot:<slot>" | "idle" | "exclude" }
 */
async function chooseMissing(lacking, { given = {}, characters = [], check = false, what, where, stop, warn = (s) => console.error("warning: " + s), interactive = !!(process.stdin.isTTY && process.stdout.isTTY) }) {
	const names = characters.map((c) => c.name),
		choices = {},
		problems = [];
	for (const n of Object.keys(given)) if (n !== "*" && !lacking.some((m) => m.name === n)) problems.push(`--missing ${n}: ${names.includes(n) ? "its CODE has its entry" : "no such character"}`);
	for (const m of lacking) {
		const c = given[m.name] ?? given["*"];
		if (c && c.startsWith("slot:") && !m.slots.includes(c.slice(5))) problems.push(`--missing ${m.name}: no slot ${c.slice(5)} in ${where}`);
		else if (c) choices[m.name] = c;
	}
	if (problems.length) return stop(problems);
	const open = lacking.filter((m) => !choices[m.name]);
	if (open.length && !check && interactive) {
		const rl = require("node:readline/promises").createInterface({ input: process.stdin, output: process.stdout });
		for (const m of open) {
			console.log(`${what(m)}.`);
			if (m.slots.length) console.log(`  run a slot of it instead: ${m.slots.join(", ")}`);
			console.log("  or: idle (in game, no CODE), exclude (not in the run)");
			for (;;) {
				const a = (await rl.question(`  ${m.name}: `)).trim();
				if (a === "idle" || a === "exclude") choices[m.name] = a;
				else if (a && m.slots.includes(a.replace(/^slot:/, ""))) choices[m.name] = "slot:" + a.replace(/^slot:/, "");
				else if (a) console.log(`  no slot ${a} in ${where}`);
				if (choices[m.name]) break;
			}
		}
		rl.close();
	} else if (open.length) return stop(open.map((m) => `${what(m)}: choose with --missing ${m.name}=<slot>|idle|exclude${m.slots.length ? ` (its slots: ${m.slots.join(", ")})` : ""}`), { missing: open });
	if (!check) {
		for (const m of lacking) warn(`${what(m)}: ${choices[m.name] === "idle" ? "idle, no CODE" : choices[m.name] === "exclude" ? "excluded from the run" : "runs slot " + choices[m.name].slice(5)}`);
		// the others' extras may still count on an excluded one (a party member list)
		for (const n of names.filter((n) => choices[n] === "exclude")) {
			const naming = characters.filter((c) => c.name !== n && choices[c.name] !== "exclude" && new RegExp(`\\b${n}\\b`).test([].concat(c.extra || []).join("\n"))).map((c) => c.name);
			if (naming.length) warn(`${n} is excluded, but the extra CODE of ${naming.join(", ")} still names it`);
		}
	}
	return choices;
}

function cli(argv) {
	// --names A[:class],B[:class]: which entry each set runs for them
	const names = argv.includes("--names") ? String(argv[argv.indexOf("--names") + 1] || "").split(",").filter(Boolean).map((x) => x.split(":")) : null;
	const { sets, problems, file } = loadCodeSets();
	console.log(`CODE sets (${file ? path.relative(process.cwd(), file) : "no config code_sets file"}; pulls: ${path.relative(process.cwd(), config().pulls_dir) || "."})`);
	const width = Math.max(0, ...sets.map((s) => s.name.length)) + 2;
	for (const s of sets) {
		const slots = slotNames(s),
			lib = s.lib && s.lib.kind !== "path" ? s.lib : null,
			where = s.pull ? `${s.pull.account}/${path.basename(s.pull.dir)}` : lib ? `${lib.web || { paste: "pasted", upload: "uploaded" }[lib.kind] || lib.kind}${lib.sub ? ` (${lib.sub})` : ""}` : path.relative(process.cwd(), s.code.file || s.code.dir);
		let line = `  ${s.name.padEnd(width)} ${s.kind.padEnd(4)} ${where}${s.git ? ` at ${s.git.rev === s.git.commit ? s.git.commit.slice(0, 7) : `${s.git.rev} (${s.git.commit.slice(0, 7)})`}` : ""}${lib && !lib.trusted ? ", not trusted" : ""}${s.code.build ? " (built)" : ""}${s.code.append.length ? " + " + s.code.append.map((p) => path.basename(p)).join(", ") : ""}`;
		if (names) line += "  " + names.map(([n, cls]) => (s.code.file ? `${n}: ${path.basename(s.code.file)}` : `${n}: ${slots == null ? "?" : slots.find((x) => x.toLowerCase() === codeFor(s, n, cls).entry.toLowerCase()) || "no slot " + codeFor(s, n, cls).entry}`)).join(", ");
		else if (s.pull) line += `  (own slots: ${s.pull.characters.join(", ") || "none"})`;
		console.log(line + (s.note && !(lib && s.note === lib.web) ? `\n  ${"".padEnd(width)} ${s.note}` : ""));
	}
	for (const p of problems) console.log(`problem: ${p}`);
	if (!sets.length) console.log("  none: pull the account (chronal pull), or set config code_sets");
	console.log("  any set but a pull at a git revision: <set>@<rev> (a commit, branch or tag), e.g. local@HEAD~1");
}

module.exports = { cli, FORMAT, IDLE: path.join(__dirname, "..", "codes", "idle.js"), loadCodeSets, codeSet, codeFor, slotNames, missingEntries, parseMissing, chooseMissing, findPull };
