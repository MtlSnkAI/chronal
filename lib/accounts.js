"use strict";
// Crafted accounts (config accounts_dir, default accounts/, gitignored): accounts made here rather than pulled from
// live, a file each (<name>.json):
//   { "format": "chronal-account/1", "name": "alts", "age_days": 0, "code": "<CODE set>" | null,
//     "characters": [{ "name": "AltRan", "class": "ranger", "level": 60, "gear": { "mainhand": "firebow+7:dex" } }] }
// age_days: the account's age (0 = new, with the New Player bonus); code: the CODE set its characters run unless a run
// says otherwise (the account owns its CODE, as on live; any other set can still be picked per character); gear: per
// slot an item spec ("name[+level][:stat][#title]", "none"). New sim adds an account's characters to a run as new
// characters of that account, with its gear, CODE and age (compose.js's char, gear, code_sets, account_age).
const fs = require("node:fs"),
	path = require("node:path");

const FORMAT = "chronal-account/1";
const NAME = /^[A-Za-z0-9_-]{1,24}$/,
	CHAR = /^[A-Za-z0-9]{1,12}$/,
	SPEC = /^(none|[a-z0-9_]+(\+\d{1,2})?(:[a-z]+)?(#[a-z0-9_]+)?)$/;

/** An account's problems ([] when fine). G: the game (compose.game()) to check classes, slots and items against */
function check(a, G) {
	const out = [];
	if (!a || typeof a !== "object" || Array.isArray(a)) return ["an account: { name, age_days, code, characters }"];
	if (typeof a.name !== "string" || !NAME.test(a.name)) out.push("name: 1-24 letters, digits, _ or -");
	if (a.age_days != null && !(typeof a.age_days === "number" && a.age_days >= 0 && a.age_days <= 3650)) out.push("age_days: 0-3650 days");
	if (a.code != null && (typeof a.code !== "string" || !a.code.trim())) out.push("code: a CODE set's name, or null");
	if (!Array.isArray(a.characters) || !a.characters.length) return [...out, "characters: at least one"];
	const seen = new Set();
	a.characters.forEach((c, i) => {
		const at = `characters[${i}]` + (c && typeof c.name === "string" ? " " + c.name : "");
		if (!c || typeof c !== "object") return void out.push(at + ": { name, class, level, gear }");
		if (typeof c.name !== "string" || !CHAR.test(c.name)) out.push(at + ": name: 1-12 letters and digits");
		else if (seen.has(c.name.toLowerCase())) out.push(at + ": twice in the account");
		else seen.add(c.name.toLowerCase());
		if (!G.classes[c.class]) out.push(`${at}: class: one of ${Object.keys(G.classes).join(", ")}`);
		if (!(Number.isInteger(c.level) && c.level >= 1 && c.level <= 200)) out.push(at + ": level: 1-200");
		if (c.gear != null) {
			if (typeof c.gear !== "object" || Array.isArray(c.gear)) out.push(at + ": gear: { slot: item spec }");
			else
				for (const [slot, spec] of Object.entries(c.gear)) {
					if (!require("./compose").SLOTS.includes(slot)) out.push(`${at}: gear: no slot ${slot}`);
					else if (typeof spec !== "string" || !SPEC.test(spec)) out.push(`${at}: gear ${slot}: an item spec (name[+level][:stat][#title], or none)`);
					else if (spec !== "none" && !G.items[spec.replace(/[+:#].*$/, "")]) out.push(`${at}: gear ${slot}: no item ${spec.replace(/[+:#].*$/, "")}`);
				}
		}
	});
	const merchants = a.characters.filter((c) => c && c.class === "merchant").length;
	if (merchants > 1) out.push(`${merchants} merchants: the game lets 1 per account in at once (the others can be offline or out of a run)`);
	return out;
}

/** The crafted accounts in dir, by name (an unreadable file: { name, problems }) */
function list(dir) {
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch (e) {}
	return files.map((f) => {
		try {
			const a = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			if (!a || a.format !== FORMAT) return { name: f.replace(/\.json$/, ""), problems: [`${f}: not ${FORMAT}`] };
			const { format, ...rest } = a;
			return rest;
		} catch (e) {
			return { name: f.replace(/\.json$/, ""), problems: [`${f}: ${e.message}`] };
		}
	});
}

/** Write an account (checked: throws with its problems). -> what was written */
function save(dir, a, G) {
	const p = check(a, G);
	if (p.length) throw Object.assign(new Error(p.join("; ")), { problems: p });
	const out = { format: FORMAT, name: a.name, age_days: a.age_days ?? 0, code: a.code ? a.code.trim() : null, characters: a.characters.map((c) => ({ name: c.name, class: c.class, level: c.level, ...(c.gear && Object.keys(c.gear).length ? { gear: c.gear } : {}) })) };
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, a.name + ".json"), JSON.stringify(out, null, 1) + "\n");
	return out;
}

/** Remove an account's file. -> whether there was one */
function remove(dir, name) {
	if (!NAME.test(String(name))) return false;
	const f = path.join(dir, name + ".json");
	if (!fs.existsSync(f)) return false;
	fs.rmSync(f);
	return true;
}

module.exports = { FORMAT, check, list, save, remove };
