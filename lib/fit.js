"use strict";
// Fitting others' CODE (docs/reference/library.md). CODE published as files was written for its author's account
// and characters: slots they numbered (load_code(2)) or named in the game (require_code("actions") of a file
// actions.2.js), helpers kept in another slot and called without loading it, entries named after their characters, ES
// modules their own loader imports. Here:
//   - slotFiles(): a folder's slots as the game names them (letters, digits, _-.+ and spaces only; a second file of a
//     name, whatever its case, deeper in: "<its folder>-<name>")
//   - a code block's fit, applied to what a character's CODE reads (setup.js codeOf):
//       calls: { <slot number or name>: <slot> | null }  load_code(K) and require_code(K), K as the CODE writes it,
//         load that slot (the call's text says so), null: none (load_code does nothing, require_code gives {})
//       with: { <entry slot>: [<slot>, ...] }  slots run before that entry, in its text (helpers it calls)
//   - an entry that is an ES module (import, export) runs bundled (bundle(): esbuild; "/x" imports from the entry's
//     folder, a package's or a link's are not bundled)
//   - suggest(): a fit for a slot folder (calls by its files' names: 02_constants.js, actions.2.js; with: the slots that
//     define what an entry calls and doesn't define); entryGuess(): a character's entry by its name, then its class
const fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto"),
	{ execFileSync } = require("node:child_process");
const acorn = require("acorn");
const N = require("./names");
const { config } = require("./config");

// the game's slot names (adventure_functions.js to_filename) and its lookup key (find_code_slot ignores case)
const toFilename = (s) => String(s).replace(/[^0-9A-Za-z_\-.+ ]/g, "");
const low = (s) => toFilename(s).toLowerCase();
// a calls key: a slot number as a number's text, a name as the game looks it up
const keyOf = (k) => (/^\d+$/.test(String(k)) ? String(Number(k)) : low(k));

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
/** A fit's problems: [] when it is { calls: { <slot number or name>: <slot> | null }, with: { <slot>: [<slot>, ...] } } */
function fitProblems(fit) {
	if (!isObj(fit)) return ["an object { calls, with }"];
	const out = Object.keys(fit).filter((k) => k !== "calls" && k !== "with").map((k) => `${k}: unknown key (known: calls, with)`);
	if (fit.calls != null && !(isObj(fit.calls) && Object.values(fit.calls).every((v) => v === null || (typeof v === "string" && v)))) out.push("calls: { <slot number or name>: <slot> | null }");
	if (fit.with != null && !(isObj(fit.with) && Object.values(fit.with).every((v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x)))) out.push("with: { <entry slot>: [<slot>, ...] }");
	return out;
}

/** A folder's slots: every *.js in it (recursive: in its subfolders too, but .git, node_modules and hidden ones), the
 * shallowest first -> [{ slot, file }] */
function slotFiles(dir, recursive = false) {
	const found = [];
	const walk = (d, depth) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.isDirectory()) {
				if (recursive && !e.name.startsWith(".") && e.name !== "node_modules") walk(path.join(d, e.name), depth + 1);
			} else if (e.isFile() && e.name.endsWith(".js")) found.push({ file: path.join(d, e.name), depth });
		}
	};
	walk(dir, 0);
	found.sort((a, b) => a.depth - b.depth || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
	const out = [],
		taken = new Set();
	for (const { file } of found) {
		const base = toFilename(path.basename(file, ".js")).trim() || "slot",
			up = path.dirname(file) === dir ? "" : toFilename(path.basename(path.dirname(file))).trim();
		let slot = base;
		for (let i = 1; taken.has(slot.toLowerCase()); i++) slot = (up ? up + "-" : "") + base + (i > 1 ? "-" + i : "");
		taken.add(slot.toLowerCase());
		out.push({ slot, file });
	}
	return out;
}

/** What a file's name says of its slot in the game: "actions.2" -> { name: "actions", number: 2 }, "02_constants" ->
 * { name: "constants", number: 2 }, "RobertTables.6101872310222848" (a character's id) -> { name: "RobertTables" } */
function fileSays(slot) {
	let m = /^(.+?)\.(\d+)$/.exec(slot);
	if (m) return { name: m[1], number: Number(m[2]) >= 1 && Number(m[2]) <= 100 ? Number(m[2]) : null };
	m = /^0*(\d{1,3})[ _.-]+(.+)$/.exec(slot);
	if (m && Number(m[1]) >= 1 && Number(m[1]) <= 100) return { name: m[2], number: Number(m[1]) };
	return null;
}

const OPTS = { ecmaVersion: "latest", locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true };
const isNode = (v) => v != null && typeof v === "object" && typeof v.type === "string";
const LOADS = new Set(["load_code", "require_code"]);
// f(...), parent.f(...), window.f(...)
const calleeOf = (c) => (c.callee.type === "Identifier" ? c.callee.name : c.callee.type === "MemberExpression" && !c.callee.computed && c.callee.property.type === "Identifier" && c.callee.object.type === "Identifier" && ["parent", "window", "self"].includes(c.callee.object.name) ? c.callee.property.name : null);
const idsOf = (p, out) => {
	if (!p) return;
	if (p.type === "Identifier") out.add(p.name);
	else if (p.type === "ObjectPattern") for (const q of p.properties) idsOf(q.type === "RestElement" ? q.argument : q.value, out);
	else if (p.type === "ArrayPattern") for (const q of p.elements) idsOf(q, out);
	else if (p.type === "RestElement") idsOf(p.argument, out);
	else if (p.type === "AssignmentPattern") idsOf(p.left, out);
};

const factsCache = new Map();
/**
 * What a CODE text is and does, for fitting (cached by its text): module (only an ES module reads it), calls (each
 * load_code / require_code: { fn, key: its slot as written or null when built as the CODE runs, line, text, at: the
 * argument's [start, end], call: the call's }), defines (the names its top level gives the page), declared (every name
 * it declares anywhere), called (the plain names it calls), strings (short strings -> count), error
 */
function facts(text) {
	const id = crypto.createHash("sha1").update(text).digest("hex");
	if (factsCache.has(id)) return factsCache.get(id);
	const out = { module: false, calls: [], defines: new Set(), declared: new Set(), called: new Set(), strings: new Map(), error: null };
	let ast;
	try {
		ast = acorn.parse(text, { ...OPTS, sourceType: "script" });
	} catch (e) {
		try {
			ast = acorn.parse(text, { ...OPTS, sourceType: "module" });
			out.module = ast.body.some((s) => /^(Import|Export)/.test(s.type));
		} catch (x) {
			out.error = N.errorOf(e);
		}
	}
	if (ast) {
		for (const s of ast.body) {
			if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) out.defines.add(s.id.name);
			else if (s.type === "VariableDeclaration") for (const d of s.declarations) idsOf(d.id, out.defines);
			else if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression") {
				const l = s.expression.left;
				if (l.type === "Identifier") out.defines.add(l.name);
				else if (l.type === "MemberExpression" && !l.computed && l.object.type === "Identifier" && ["window", "self", "globalThis"].includes(l.object.name)) out.defines.add(l.property.name);
			}
		}
		const stack = [ast];
		while (stack.length) {
			const n = stack.pop();
			switch (n.type) {
				case "FunctionDeclaration":
				case "FunctionExpression":
				case "ArrowFunctionExpression":
					if (n.id) out.declared.add(n.id.name);
					for (const p of n.params) idsOf(p, out.declared);
					break;
				case "ClassDeclaration":
					if (n.id) out.declared.add(n.id.name);
					break;
				case "VariableDeclarator":
					idsOf(n.id, out.declared);
					break;
				case "CatchClause":
					idsOf(n.param, out.declared);
					break;
				case "ImportSpecifier":
				case "ImportDefaultSpecifier":
				case "ImportNamespaceSpecifier":
					out.declared.add(n.local.name);
					break;
				case "AssignmentExpression":
					if (n.left.type === "Identifier") out.declared.add(n.left.name);
					break;
				case "NewExpression":
					if (n.callee.type === "Identifier") out.called.add(n.callee.name);
					break;
				case "CallExpression": {
					if (n.callee.type === "Identifier") out.called.add(n.callee.name);
					const f = calleeOf(n);
					if (LOADS.has(f)) {
						const a = n.arguments[0],
							v = a && a.type === "Literal" && (typeof a.value === "number" || typeof a.value === "string") ? a.value : a && a.type === "TemplateLiteral" && !a.expressions.length ? a.quasis[0].value.cooked : null;
						out.calls.push({ fn: f, key: v == null ? null : String(v), line: n.loc.start.line, text: text.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 60), at: a ? [a.start, a.end] : null, call: [n.start, n.end] });
					}
					break;
				}
				case "Literal":
					if (typeof n.value === "string" && n.value.length <= 30) out.strings.set(n.value, (out.strings.get(n.value) || 0) + 1);
					break;
			}
			for (const k of Object.keys(n)) {
				if (k === "loc") continue;
				const v = n[k];
				if (Array.isArray(v)) {
					for (const x of v) if (isNode(x)) stack.push(x);
				} else if (isNode(v)) stack.push(v);
			}
		}
	}
	out.calls.sort((a, b) => a.call[0] - b.call[0]);
	factsCache.set(id, out);
	return out;
}

/** A text with its load_code / require_code calls fitted (calls: { <key>: <slot> | null }); one with none of them, or
 * not read (acorn's syntax error), as it is */
function fitCalls(text, calls) {
	if (!calls || !Object.keys(calls).length || !/\b(load_code|require_code)\b/.test(text)) return text;
	const f = facts(text);
	if (f.error) return text;
	const to = new Map(Object.entries(calls).map(([k, v]) => [keyOf(k), v])),
		edits = [];
	for (const c of f.calls) {
		if (c.key == null || !to.has(keyOf(c.key))) continue;
		const y = to.get(keyOf(c.key));
		edits.push(y == null ? [c.call[0], c.call[1], c.fn === "require_code" ? "({})" : "void 0"] : [c.at[0], c.at[1], JSON.stringify(y)]);
	}
	let t = text;
	for (const [a, b, y] of edits.sort((x, z) => z[0] - x[0])) t = t.slice(0, a) + y + t.slice(b);
	return t;
}

// the names the game's CODE page has without any slot (its runner's functions, the browser's)
let pageNames = null;
function pageHas(name) {
	if (!pageNames) {
		pageNames = new Set(["parent", "window", "document", "self", "$", "jQuery", "alert", "Image", "Audio", "fetch", "XMLHttpRequest", "requestAnimationFrame", "localStorage", "performance", "PIXI", "io", "WebSocket", "Worker"]);
		for (const rel of ["common/js/common_functions.js", "js/old_common_functions.js", "js/runner_functions.js", "js/runner_compat.js"])
			try {
				for (const n of facts(fs.readFileSync(path.join(config().al_root, rel), "utf8")).defines) pageNames.add(n);
			} catch (e) {}
	}
	return pageNames.has(name) || name in globalThis;
}

/** A slot folder's slots with what each is: [{ slot, file, says (fileSays), text, facts }] */
function slotsOf(code) {
	if (!code.dir || !fs.existsSync(code.dir)) return [];
	return slotFiles(code.dir, code.recursive).map(({ slot, file }) => {
		const text = fs.readFileSync(file, "utf8");
		return { slot, file, says: fileSays(path.basename(file, ".js")), text, facts: facts(text) };
	});
}

// the slot a call's key names as it is (by name, as the game finds it), else null
const slotNamed = (slots, key) => (/^\d+$/.test(key) ? null : slots.find((s) => s.slot.toLowerCase() === low(key)) || null);

/**
 * What a slot folder's CODE needs fitted, and a fit for it. given: the fit chosen ({ calls, with }), suggestions for
 * the rest.
 * -> { calls: [{ key, fn, number, where: ["slot:line"], to (a slot, null: none, undefined: none found), why }] (each
 *   key written in a load_code / require_code that no slot is named, the given ones too), dynamic: [{ where, line, text }]
 *   (a slot built as the CODE runs), with: [{ entry, slots, names, why }] (the slots an entry calls into, given (none
 *   too: []) or suggested), modules: [slot], errors: [string], loaded: Set (lower-case names of the slots a call loads) }
 */
function suggest(slots, given = {}) {
	const gc = given.calls || {},
		gw = given.with || {},
		calls = new Map(),
		dynamic = [],
		errors = [];
	for (const s of slots) {
		if (s.facts.error) errors.push(`${s.slot}: ${s.facts.error}`);
		for (const c of s.facts.calls) {
			if (c.key == null) {
				dynamic.push({ where: s.slot, line: c.line, text: c.text });
				continue;
			}
			const k = keyOf(c.key),
				g = Object.keys(gc).find((x) => keyOf(x) === k);
			if (g == null && slotNamed(slots, c.key)) continue;
			const x = calls.get(k) || calls.set(k, { key: /^\d+$/.test(c.key) ? k : c.key, fn: c.fn, number: /^\d+$/.test(c.key), where: [] }).get(k);
			x.where.push(`${s.slot}:${c.line}`);
			if (g != null) (x.to = gc[g]), (x.why = "chosen");
		}
	}
	for (const x of calls.values()) {
		if (x.why) continue;
		const s = x.number ? slots.find((y) => y.says && y.says.number === Number(x.key)) : slots.find((y) => y.says && low(y.says.name) === low(x.key));
		if (s) (x.to = s.slot), (x.why = `its file ${path.basename(s.file)}`);
		else x.why = x.number ? `no file numbered ${x.key}` : "no such slot";
	}
	const target = (key) => {
		const x = calls.get(keyOf(key));
		if (x) return x.to ? slots.find((s) => s.slot === x.to) || null : null;
		return slotNamed(slots, key);
	};
	const loaded = new Set();
	for (const s of slots) for (const c of s.facts.calls) if (c.key != null && target(c.key)) loaded.add(target(c.key).slot.toLowerCase());
	// with: each entry's calls of names it, and what it loads, don't declare, that another slot's top level defines
	const reach = (s, seen = new Set()) => {
		if (seen.has(s)) return seen;
		seen.add(s);
		for (const c of s.facts.calls) if (c.key != null && target(c.key)) reach(target(c.key), seen);
		return seen;
	};
	const declared = (set) => new Set([...set].flatMap((s) => [...s.facts.declared, ...s.facts.defines])),
		withs = [];
	for (const s of slots) {
		if (s.facts.error || s.facts.module) continue;
		const g = Object.keys(gw).find((x) => x.toLowerCase() === s.slot.toLowerCase());
		if (g != null) {
			withs.push({ entry: s.slot, slots: gw[g], names: [], why: "chosen" });
			continue;
		}
		const have = reach(s),
			picked = [],
			named = [];
		for (let round = 0; round < 5; round++) {
			const known = declared(have),
				missing = [...new Set([...have].flatMap((x) => [...x.facts.called]))].filter((n) => !known.has(n) && !pageHas(n));
			if (!missing.length) break;
			let best = null;
			for (const t of slots) {
				if (have.has(t) || t.facts.error || t.facts.module) continue;
				const covers = missing.filter((n) => t.facts.defines.has(n));
				if (covers.length && (!best || covers.length > best.covers.length)) best = { t, covers };
			}
			if (!best) break;
			picked.push(best.t.slot), named.push(...best.covers);
			for (const x of reach(best.t)) have.add(x);
		}
		if (picked.length) withs.push({ entry: s.slot, slots: picked, names: named, why: `defines ${named.slice(0, 3).join(", ")}${named.length > 3 ? ` and ${named.length - 3} more` : ""}` });
	}
	return { calls: [...calls.values()], dynamic, with: withs, modules: slots.filter((s) => s.facts.module).map((s) => s.slot), errors, loaded };
}

const CLASSES = ["warrior", "paladin", "rogue", "ranger", "mage", "priest", "merchant"],
	MAIN = ["main", "master", "index", "start", "startup", "bot", "run", "everything"];
/**
 * A character's entry slot in others' CODE ({ name, class }): the slot its file names it by (Name.<id>.js), else one
 * named after a character known here of its class (known: Map name -> { class, of }), else one named for its class
 * (priest.js, 10_priest.js), else a main one (main, master, index, ...), else the one most using its class's skills
 * (G skills, as strings or calls: heal(); only its class's, or 3 times, 2 of them, mostly its class's), else the only
 * one. Slots another loads are helpers, not entries. -> { slot, why } or null
 */
function entryGuess(slots, ch, { skills = null, loaded = new Set(), known = null } = {}) {
	const pool = slots.filter((s) => !loaded.has(s.slot.toLowerCase()) && !s.facts.error),
		bare = (s) => (s.says ? s.says.name : s.slot).toLowerCase();
	let s = pool.find((x) => x.says && x.says.name.toLowerCase() === ch.name.toLowerCase());
	if (s) return { slot: s.slot, why: `its file ${path.basename(s.file)}` };
	if (ch.class && known) {
		const who = (x) => [x.slot, x.says && x.says.name].find((n) => n && known.has(n) && known.get(n).class === ch.class);
		s = pool.find(who);
		if (s) return { slot: s.slot, why: `${who(s)}'s, a ${ch.class} (${known.get(who(s)).of})` };
	}
	if (ch.class) {
		const re = new RegExp(`(^|[^a-z])${ch.class}s?([^a-z]|$)`, "i"),
			named = pool.filter((x) => re.test(x.slot)).sort((a, b) => a.slot.length - b.slot.length);
		if (named.length) return { slot: named[0].slot, why: `named for ${ch.class}s` };
	}
	s = MAIN.map((m) => pool.find((x) => bare(x) === m)).find(Boolean);
	if (s) return { slot: s.slot, why: `named ${bare(s)}` };
	if (ch.class && skills) {
		const of = {};
		for (const [k, v] of Object.entries(skills)) for (const c of v.class || []) (of[k] ||= new Set()).add(c);
		let best = null;
		for (const x of pool) {
			let own = 0,
				all = 0;
			const used = [];
			for (const [str, n] of [...x.facts.strings, ...[...x.facts.called].map((f) => [f, 1])]) {
				if (!of[str]) continue;
				all += n;
				if (of[str].has(ch.class)) (own += n), used.includes(str) || used.push(str);
			}
			if (own && (own === all || (own >= 3 && used.length >= 2 && own >= 0.7 * all)) && (!best || own > best.own)) best = { x, own, used };
		}
		if (best) return { slot: best.x.slot, why: `uses ${ch.class} skills: ${best.used.slice(0, 3).join(", ")}` };
	}
	if (pool.length === 1) return { slot: pool[0].slot, why: "its only slot" };
	return null;
}

/** An ES module and what it imports, as one script (esbuild, in a child process: the sim reads CODE synchronously).
 * "/x" imports: from the entry's folder (a loader's server root); none outside top. Throws on what it can't bundle. */
function bundle(file, top = path.dirname(file)) {
	try {
		return execFileSync(process.execPath, [__filename, "--bundle", file, top], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		throw new Error(`bundling ${path.basename(file)}: ${String(e.stderr || e.message).trim().split("\n").slice(0, 4).join(" | ")}`);
	}
}
async function bundleNow(file, top) {
	const root = path.dirname(file),
		inside = (p) => !path.relative(top, p).startsWith("..") && !path.isAbsolute(path.relative(top, p));
	const pick = (p) => [p, p + ".js", p + ".ts", path.join(p, "index.js")].find((f) => inside(f) && fs.existsSync(f) && fs.statSync(f).isFile());
	const r = await require("esbuild").build({
		entryPoints: [file], absWorkingDir: top, bundle: true, write: false, format: "iife", platform: "browser", target: "esnext", logLevel: "silent", charset: "utf8",
		plugins: [{
			name: "chronal-fit",
			setup(b) {
				b.onResolve({ filter: /^[a-z]+:\/\// }, (a) => ({ path: a.path, external: true }));
				b.onResolve({ filter: /^\.{0,2}\// }, (a) => {
					if (a.kind === "entry-point") return { path: a.path };
					const f = pick(a.path.startsWith("/") ? path.join(root, a.path) : path.resolve(a.resolveDir, a.path));
					return f ? { path: f } : { errors: [{ text: `${a.path}: no such file${a.path.startsWith("/") ? ` in ${path.relative(top, root) || "."}` : ""}` }] };
				});
				b.onResolve({ filter: /^[^./]/ }, (a) => ({ errors: [{ text: `${a.path}: a package (not bundled: nothing is installed here)` }] }));
			},
		}],
	}).catch((e) => {
		throw new Error((e.errors || []).map((x) => (x.location ? `${path.relative(top, x.location.file) || x.location.file}:${x.location.line} ` : "") + x.text).join("; ") || e.message);
	});
	process.stdout.write(r.outputFiles[0].text);
}

if (require.main === module && process.argv[2] === "--bundle")
	bundleNow(process.argv[3], process.argv[4]).catch((e) => {
		process.stderr.write(e.message + "\n");
		process.exit(1);
	});

module.exports = { toFilename, fitProblems, slotFiles, fileSays, facts, fitCalls, slotsOf, suggest, entryGuess, bundle, CLASSES };
