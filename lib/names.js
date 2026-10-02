"use strict";
// Character names in CODE (docs/reference/setup.md). CODE written for some characters names them: "JohnRanger"
// in a party list, { JohnPriest: { ... } } in a config. Run on other characters, a setup's code_names maps those names
// to the run's (setup.js applies it to what a character's CODE reads from disk: its slots, entry file, appended files).
// Found by parsing the CODE (acorn), mapped: a string that is the name exactly ('X', "X", `X` without ${}), a property
// named so ({ X: 1 }, { "X": 1 }, a.X, a method or class member X; a shorthand { X } becomes { Y: X }). Not mapped:
// comments; the name inside a longer string, a template's text or a pattern, or in another case; a name the CODE builds
// as it runs ("John" + cls). Each string of those is flagged ("may not be mapped").
// storageKeys(): the keys a CODE reads from its browser's storage (get("k"), localStorage.getItem("k"), ...), for the
// setup's accounts.<k>.storage (docs/reference/setup.md).
const acorn = require("acorn");

const OPTS = { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true };
// a CODE text's tree: a script (as the game runs a slot), else a module (CODE a loader imports); throws the script's error
function parse(text) {
	try {
		return acorn.parse(text, OPTS);
	} catch (e) {
		try {
			return acorn.parse(text, { ...OPTS, sourceType: "module" });
		} catch (x) {
			throw e;
		}
	}
}
const NAME = /^[A-Za-z0-9]{1,12}$/;
// the game's CODE functions whose first argument is a character's name (send_cm's: one or a list)
const NAME_CALLS = new Set(["start_character", "stop_character", "command_character", "send_party_invite", "send_party_request", "accept_party_invite", "accept_party_request", "kick_party_member", "send_cm", "send_local_cm", "send_item", "send_gold", "send_mail", "get_player", "get_entity", "is_character_local"]);
const CALLS = new RegExp(`\\b(${[...NAME_CALLS].join("|")})\\b|character\\.name|\\bentities\\b`);
// a string this long or longer that starts or ends a name: maybe a part of one the CODE builds as it runs
const PART = 3;

const isNode = (v) => v != null && typeof v === "object" && typeof v.type === "string";
// a call's function name: f(...), parent.f(...), window.f(...)
const calleeOf = (c) => (c.callee.type === "Identifier" ? c.callee.name : c.callee.type === "MemberExpression" && !c.callee.computed && c.callee.property.type === "Identifier" ? c.callee.property.name : null);
// character.name, parent.character.name
const isOwnName = (e) => e && e.type === "MemberExpression" && !e.computed && e.property.name === "name" && ((e.object.type === "Identifier" && e.object.name === "character") || (e.object.type === "MemberExpression" && !e.object.computed && e.object.property.name === "character"));
// entities, parent.entities
const isEntities = (e) => e && ((e.type === "Identifier" && e.name === "entities") || (e.type === "MemberExpression" && !e.computed && e.property.name === "entities"));

// where a string is used as a character's name by the game's CODE functions (for suggestions), else null
function contextOf(n, p, g) {
	if (!p) return null;
	if (p.type === "CallExpression" && p.arguments[0] === n && NAME_CALLS.has(calleeOf(p))) return calleeOf(p) + "()";
	if (p.type === "ArrayExpression" && g && g.type === "CallExpression" && g.arguments[0] === p && calleeOf(g) === "send_cm") return "send_cm()";
	if (p.type === "BinaryExpression" && /^[!=]==?$/.test(p.operator) && isOwnName(p.left === n ? p.right : p.left)) return "character.name " + p.operator;
	if (p.type === "SwitchCase" && p.test === n && g && isOwnName(g.discriminant)) return "switch (character.name)";
	if (p.type === "MemberExpression" && p.computed && p.property === n && isEntities(p.object)) return "entities[]";
	return null;
}

/**
 * Every place in a CODE text a name may be, in text order: { kind, value, start, end, line, col, quote, ctx }. kind
 * "string": a string ('X', "X", `X`); "key": a property's name (a.X, { X: 1 }, X() {}); "shorthand": { X }; "text": a
 * template's text beside its ${}; "pattern": a regular expression's. Throws acorn's SyntaxError.
 */
function sitesOf(text) {
	const ast = parse(text),
		out = [],
		stack = [[ast, null, null]];
	const add = (kind, value, node, extra) => out.push({ kind, value, start: node.start, end: node.end, line: node.loc.start.line, col: node.loc.start.column + 1, ...extra });
	while (stack.length) {
		const [n, p, g] = stack.pop();
		switch (n.type) {
			case "Literal":
				if (n.regex) add("pattern", n.regex.pattern, n);
				else if (typeof n.value === "string" && !(p && p.type === "ExpressionStatement" && p.directive != null)) add("string", n.value, n, { quote: text[n.start], ctx: contextOf(n, p, g) });
				break;
			case "TemplateLiteral":
				// a tagged template's text goes to its tag as it is written: only its flags
				if (!n.expressions.length && !(p && p.type === "TaggedTemplateExpression")) add("string", n.quasis[0].value.cooked, n, { quote: "`", ctx: contextOf(n, p, g) });
				else for (const q of n.quasis) add("text", q.value.cooked ?? q.value.raw, q);
				break;
			case "Property":
			case "MethodDefinition":
			case "PropertyDefinition":
				if (!n.computed && n.key.type === "Identifier") add(n.shorthand ? "shorthand" : "key", n.key.name, n.key);
				break;
			case "MemberExpression":
				if (!n.computed && n.property.type === "Identifier") add("key", n.property.name, n.property, { ctx: isEntities(n.object) ? "entities." : null });
				break;
		}
		for (const k of Object.keys(n)) {
			if (k === "loc") continue;
			const v = n[k];
			if (Array.isArray(v)) {
				for (let i = v.length - 1; i >= 0; i--) if (isNode(v[i])) stack.push([v[i], n, p]);
			} else if (isNode(v)) stack.push([v, n, p]);
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

const errorOf = (e) => (e && e.loc ? `line ${e.loc.line}: ${String(e.message).replace(/ \(\d+:\d+\)$/, "")}` : String((e && e.message) || e));

/**
 * The names a CODE text has, of those looked for (exact case), and the name-like strings it gives the game's CODE
 * functions as a character's name (send_cm, get_player, character.name ===, ...) that aren't among them.
 * -> { found: { <name>: count }, suggested: { <string>: [where it's used] }, error }
 */
function scan(text, names) {
	const want = new Set(names),
		out = { found: {}, suggested: {}, error: null };
	if (![...want].some((n) => text.includes(n)) && !CALLS.test(text)) return out;
	let sites;
	try {
		sites = sitesOf(text);
	} catch (e) {
		return (out.error = errorOf(e)), out;
	}
	for (const s of sites) {
		if (s.kind === "text" || s.kind === "pattern") continue;
		if (want.has(s.value)) out.found[s.value] = (out.found[s.value] || 0) + 1;
		else if (s.ctx && s.kind === "string" && NAME.test(s.value) && /[A-Za-z]/.test(s.value)) {
			const at = (out.suggested[s.value] ||= []);
			if (!at.includes(s.ctx)) at.push(s.ctx);
		}
	}
	return out;
}

// a string that may be meant as a moved name without being it: the name inside it, in another case, or a start or end
// of it (built as the CODE runs) -> { name, why } or null
function flagOf(s, moved) {
	for (const a of moved) {
		if (a.length < PART) continue;
		if (s.value.includes(a)) return { name: a, why: "inside" };
		if (s.value.toLowerCase().includes(a.toLowerCase())) return { name: a, why: "case" };
		if (s.kind !== "pattern" && s.value.length >= PART && s.value.length < a.length && (a.startsWith(s.value) || a.endsWith(s.value))) return { name: a, why: "part" };
	}
	return null;
}

/**
 * A CODE text with its names mapped. map: { <name in the CODE>: <name in the run> } (a name to itself stays); known:
 * the other names a string may be (the run's characters): a string that is one of them isn't flagged.
 * -> { text, hits: { <name>: count }, flags: [{ line, col, text, name, why }], error }; why: "inside" (a longer string, a
 * template's text or a pattern holds the name), "case" (holds it in another case), "part" (starts or ends it). Unread
 * (a syntax acorn doesn't take: error), the text comes back as it was.
 */
function mapText(text, map, known = []) {
	const moves = Object.entries(map || {}).filter(([a, b]) => a !== b),
		out = { text, hits: {}, flags: [], error: null };
	if (!moves.length) return out;
	// (a text with none of it, in any case, has nothing to map or flag: not parsed)
	const low = text.toLowerCase();
	if (!moves.some(([a]) => low.includes(a.slice(0, PART).toLowerCase()) || low.includes(a.slice(-PART).toLowerCase()))) return out;
	let sites;
	try {
		sites = sitesOf(text);
	} catch (e) {
		return (out.error = errorOf(e)), out;
	}
	const to = new Map(moves),
		names = new Set([...known, ...Object.keys(map), ...Object.values(map)]),
		moved = [...to.keys()].sort((a, b) => b.length - a.length),
		edits = [];
	for (const s of sites) {
		if (s.kind !== "text" && s.kind !== "pattern" && to.has(s.value)) {
			const y = to.get(s.value);
			out.hits[s.value] = (out.hits[s.value] || 0) + 1;
			edits.push(s.kind === "shorthand" ? [s.start, s.start, y + ": "] : s.kind === "key" ? [s.start, s.end, y] : [s.start, s.end, s.quote + y + s.quote]);
		} else if (s.kind !== "key" && s.kind !== "shorthand" && !(s.kind === "string" && names.has(s.value))) {
			const f = flagOf(s, moved);
			if (f) out.flags.push({ line: s.line, col: s.col, text: text.slice(s.start, s.end).replace(/\s+/g, " ").slice(0, 60), ...f });
		}
	}
	let t = text;
	for (const [a, b, y] of edits.sort((x, z) => z[0] - x[0])) t = t.slice(0, a) + y + t.slice(b);
	out.text = t;
	return out;
}

// localStorage, window.localStorage, parent.localStorage
const isStorage = (e) => e && ((e.type === "Identifier" && e.name === "localStorage") || (e.type === "MemberExpression" && !e.computed && e.property.name === "localStorage"));
const STORAGE_API = new Set(["getItem", "setItem", "removeItem", "clear", "key", "length"]);
const strOf = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : n && n.type === "TemplateLiteral" && !n.expressions.length ? n.quasis[0].value.cooked : null);

/**
 * The storage keys a CODE text reads and writes: the game's get(k) and set(k, v) (its localStorage "cstore_<k>", JSON),
 * localStorage's own (getItem, setItem, removeItem, localStorage.k, localStorage["k"]). A key the CODE builds as it
 * runs is listed apart (dynamic: its text). get/set are the game's unless the text declares its own get or set.
 * -> { get: { <key>: count }, set, local, local_set, dynamic: [{ line, text, kind }], error }
 */
function storageKeys(text) {
	const out = { get: {}, set: {}, local: {}, local_set: {}, dynamic: [], error: null };
	if (!/\b(get|set)\s*\(|localStorage/.test(text)) return out;
	let ast;
	try {
		ast = parse(text);
	} catch (e) {
		return (out.error = errorOf(e)), out;
	}
	const hits = [],
		own = new Set(),
		stack = [[ast, null]];
	while (stack.length) {
		const [n, p] = stack.pop();
		if ((n.type === "FunctionDeclaration" || n.type === "VariableDeclarator") && n.id && n.id.type === "Identifier" && (n.id.name === "get" || n.id.name === "set")) own.add(n.id.name);
		if (n.type === "CallExpression") {
			const f = n.callee,
				a = n.arguments[0];
			if (f.type === "Identifier" && (f.name === "get" || f.name === "set") && a) hits.push([f.name, a, n]);
			else if (f.type === "MemberExpression" && !f.computed && isStorage(f.object) && ["getItem", "setItem", "removeItem"].includes(f.property.name) && a) hits.push([f.property.name === "getItem" ? "local" : "local_set", a, n]);
		} else if (n.type === "MemberExpression" && isStorage(n.object) && !(p && p.type === "CallExpression" && p.callee === n)) {
			const k = n.computed ? n.property : !STORAGE_API.has(n.property.name) ? { type: "Literal", value: n.property.name } : null,
				w = p && ((p.type === "AssignmentExpression" && p.left === n) || (p.type === "UnaryExpression" && p.operator === "delete"));
			if (k) hits.push([w ? "local_set" : "local", k, n]);
		}
		for (const k of Object.keys(n)) {
			if (k === "loc") continue;
			const v = n[k];
			if (Array.isArray(v)) {
				for (let i = v.length - 1; i >= 0; i--) if (isNode(v[i])) stack.push([v[i], n]);
			} else if (isNode(v)) stack.push([v, n]);
		}
	}
	for (const [kind, a, n] of hits.sort((x, y) => x[2].start - y[2].start)) {
		if (own.has(kind)) continue;
		const k = strOf(a);
		if (k != null) out[kind][k] = (out[kind][k] || 0) + 1;
		else if (kind === "get" || kind === "local") out.dynamic.push({ line: n.loc.start.line, text: text.slice(n.start, n.end).replace(/\s+/g, " ").slice(0, 60), kind });
	}
	return out;
}

// a flag as a line: where it is, the string, why
const WHY = { inside: "holds", case: "holds in another case", part: "a part of" };
const flagText = (f) => `${f.where ? f.where + ":" : "line "}${f.line} ${f.text} (${WHY[f.why]} ${f.name})`;

module.exports = { NAME, parse, errorOf, scan, mapText, flagText, storageKeys };
