"use strict";
// Gear sets: a class's gear in every slot but the elixir, worn at once or compared (chronal new --gear-set and
// --sweep-gear-set; New sim's Gear set picker). The built-in ones (gear_sets.json): early, mid and late game per class
// as shared on the game's Discord. Yours (config gear_sets_dir, default gearsets/, gitignored): a file each (<name>.json):
//   { "format": "chronal-gear-set/1", "name": "ranger-mine", "class": "ranger", "gear": { "mainhand": "firebow+9:dex", ... } }
// gear: per slot an item spec (name[+level][:stat][#title], or none); a slot left out is empty.
const fs = require("node:fs"),
	path = require("node:path");

const FORMAT = "chronal-gear-set/1";
const NAME = /^[A-Za-z0-9_-]{1,24}$/,
	SPEC = /^(none|[a-z0-9_]+(\+\d{1,2})?(:[a-z]+)?(#[a-z0-9_]+)?)$/;
// the sheet's order (the elixir is no gear)
const SLOTS = ["earring1", "helmet", "earring2", "amulet", "mainhand", "chest", "offhand", "cape", "ring1", "pants", "ring2", "orb", "belt", "shoes", "gloves"];
const BUILTIN = require("./gear_sets.json");

/** A set's problems ([] when fine). G: the game (compose.game()) */
function check(s, G) {
	if (!s || typeof s !== "object" || Array.isArray(s)) return ["a gear set: { name, class, gear }"];
	const out = [];
	if (typeof s.name !== "string" || !NAME.test(s.name)) out.push("name: 1-24 letters, digits, _ or -");
	else if (BUILTIN.sets[s.name]) out.push(`name: ${s.name} is a built-in set's`);
	if (!G.classes[s.class]) out.push(`class: one of ${Object.keys(G.classes).join(", ")}`);
	if (!s.gear || typeof s.gear !== "object" || Array.isArray(s.gear)) return [...out, "gear: { slot: item spec }"];
	for (const [slot, spec] of Object.entries(s.gear)) {
		if (!SLOTS.includes(slot)) out.push(`gear: no slot ${slot} (${SLOTS.join(", ")})`);
		else if (typeof spec !== "string" || !SPEC.test(spec)) out.push(`gear ${slot}: an item spec (name[+level][:stat][#title], or none)`);
		else if (spec !== "none" && !G.items[spec.replace(/[+:#].*$/, "")]) out.push(`gear ${slot}: no item ${spec.replace(/[+:#].*$/, "")}`);
	}
	return out;
}

/** Every set, the built-in ones first: { name, class, label, builtin, gear } (a file of yours unreadable: { name, problems }) */
function list(dir) {
	const out = Object.entries(BUILTIN.sets).map(([name, s]) => ({ name, class: s.class, label: s.label, builtin: true, gear: s.gear }));
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch (e) {}
	for (const f of files)
		try {
			const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			if (!s || s.format !== FORMAT) out.push({ name: f.replace(/\.json$/, ""), problems: [`${f}: not ${FORMAT}`] });
			else out.push({ name: s.name, class: s.class, gear: s.gear || {} });
		} catch (e) {
			out.push({ name: f.replace(/\.json$/, ""), problems: [`${f}: ${e.message}`] });
		}
	return out;
}

/** A set by its name (null: none) */
const get = (dir, name) => list(dir).find((s) => s.name === name && !s.problems) || null;

/** Write a set of yours (checked: throws with its problems). -> what was written */
function save(dir, s, G) {
	const p = check(s, G);
	if (p.length) throw Object.assign(new Error(p.join("; ")), { problems: p });
	const out = { format: FORMAT, name: s.name, class: s.class, gear: Object.fromEntries(SLOTS.filter((k) => s.gear[k] && s.gear[k] !== "none").map((k) => [k, s.gear[k]])) };
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, s.name + ".json"), JSON.stringify(out, null, 1) + "\n");
	return out;
}

/** Remove a set of yours. -> whether there was one */
function remove(dir, name) {
	if (!NAME.test(String(name))) return false;
	const f = path.join(dir, name + ".json");
	if (!fs.existsSync(f)) return false;
	fs.rmSync(f);
	return true;
}

module.exports = { FORMAT, SLOTS, check, list, get, save, remove };
