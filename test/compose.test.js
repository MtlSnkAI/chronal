"use strict";
// compose.js (chronal new): the gear rules (checkGear), continue-from-now from a pull, a template refreshed from it,
// characters from scratch, gear edits and sweeps, missing CODE applied, names in CODE, storage, preludes and steering,
// writing (relative paths, no overwrite), and chronal new --check end to end.
//   node --test test/compose.test.js      (the last test needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const { execFileSync } = require("node:child_process");
const K = require("../lib/compose");
const S = require("../lib/setup");
const C = require("../lib/code_sets");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "compose-test-"))), dirs[dirs.length - 1]);
const libWas = process.env.CHRONAL_LIBRARY_DIR;
process.env.CHRONAL_LIBRARY_DIR = tmp(); // (an empty CODE library: none of this machine's sets)
test.after(() => (libWas === undefined ? delete process.env.CHRONAL_LIBRARY_DIR : (process.env.CHRONAL_LIBRARY_DIR = libWas)));
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// a small game: rangers wield bows (quiver offhand), mages staves, warriors axes two-handed
const G = {
	items: {
		bow: { type: "weapon", wtype: "bow", upgrade: {}, grades: [7, 9, 10, 12] },
		firebow: { type: "weapon", wtype: "bow", upgrade: {}, grades: [5, 7, 8, 10] },
		staff: { type: "weapon", wtype: "staff", upgrade: {} },
		axe: { type: "weapon", wtype: "axe", upgrade: {} },
		blade: { type: "weapon", wtype: "short_sword", upgrade: {} },
		quiver: { type: "quiver", upgrade: {} },
		wshield: { type: "shield", upgrade: {} },
		coat: { type: "chest", upgrade: {}, stat: 1 },
		helmet: { type: "helmet", upgrade: {}, stat: 1 },
		shoes: { type: "shoes", upgrade: {}, stat: 1 },
		ringsj: { type: "ring", compound: {}, grades: [3, 5, 6, 7] },
		stand0: { type: "stand" },
		hpot0: { type: "pot", s: 9999 },
		mageshood: { type: "helmet", upgrade: {}, class: ["mage"] },
		dexscroll: { type: "pscroll" },
	},
	classes: {
		ranger: { mainhand: { bow: 1, short_sword: 1 }, offhand: { quiver: 1 }, doublehand: {}, base_slots: { mainhand: { name: "bow", level: 0, gift: 1 } } },
		mage: { mainhand: { staff: 1 }, offhand: {}, doublehand: {}, base_slots: { mainhand: { name: "staff", level: 0, gift: 1 } } },
		warrior: { mainhand: { short_sword: 1 }, offhand: { short_sword: 1, shield: 1 }, doublehand: { axe: 1 }, base_slots: { mainhand: { name: "blade", level: 0, gift: 1 } } },
		merchant: { mainhand: {}, offhand: {}, doublehand: {}, base_slots: {} },
	},
	maps: { main: { spawns: [[5, 6, 0, 100]] }, spookytown: {} },
};

test("checkGear: the game's slots, hands, levels, stat scrolls; class items worn without stats", () => {
	const ok = (cls, slot, item, slots = {}) => K.checkGear(G, cls, slot, item, slots);
	assert.deepEqual(ok("ranger", "mainhand", { name: "bow", level: 12 }), { problems: [], warnings: [] });
	assert.deepEqual(ok("ranger", "offhand", { name: "quiver", level: 7 }, { mainhand: { name: "bow" } }).problems, []);
	assert.deepEqual(ok("ranger", "ring2", { name: "ringsj", level: 7 }).problems, []);
	assert.deepEqual(ok("ranger", "chest", { name: "coat", level: 8, stat_type: "dex" }).problems, []);
	assert.deepEqual(ok("ranger", "mainhand", null).problems, []);
	assert.deepEqual(ok("mage", "mainhand", { name: "bow" }).problems, ["mainhand=bow: a mage can't use a bow as its mainhand"]);
	assert.deepEqual(ok("ranger", "helmet", { name: "coat" }).problems, ["helmet=coat: a chest doesn't go in helmet"]);
	assert.deepEqual(ok("ranger", "mainhand", { name: "firebow", level: 11 }).problems, ["mainhand=firebow: level 11: it goes to +10"]);
	assert.deepEqual(ok("ranger", "mainhand", { name: "bow", level: 13 }).problems, ["mainhand=bow: level 13: it goes to +12"]);
	assert.deepEqual(ok("merchant", "mainhand", { name: "stand0", level: 1 }).problems.length, 2); // not a weapon; can't be upgraded
	assert.deepEqual(ok("ranger", "ring1", { name: "ringsj", level: 0, stat_type: "dex" }).problems, ["ring1=ringsj: it takes no stat scroll"]);
	assert.deepEqual(ok("ranger", "chest", { name: "coat", stat_type: "luck" }).problems, ["chest=coat: luck: no such stat scroll"]);
	assert.deepEqual(ok("ranger", "cape", { name: "coat" }).problems, ["cape=coat: a chest doesn't go in cape"]);
	assert.deepEqual(ok("ranger", "trade1", { name: "coat" }).problems, ["trade1: not a gear slot (ring1, ring2, earring1, earring2, belt, mainhand, offhand, helmet, chest, pants, shoes, gloves, amulet, orb, elixir, cape)"]);
	assert.deepEqual(ok("ranger", "mainhand", { name: "nope" }).problems, ["mainhand=nope: no such item"]);
	// two hands: an axe leaves no offhand; a shield not beside one
	assert.deepEqual(ok("warrior", "mainhand", { name: "axe" }, { mainhand: { name: "axe" }, offhand: { name: "wshield" } }).problems, ["mainhand=axe: a warrior can't use a axe as its mainhand", "mainhand=axe: a two-handed axe leaves no offhand (offhand=wshield)"]);
	assert.deepEqual(ok("warrior", "mainhand", { name: "axe" }, { mainhand: { name: "axe" } }).problems, []);
	assert.deepEqual(ok("warrior", "offhand", { name: "wshield" }, { mainhand: { name: "axe" } }).problems, ["offhand=wshield: a shield doesn't go in offhand (a two-handed axe in its mainhand)"]);
	assert.deepEqual(ok("warrior", "offhand", { name: "blade" }, { mainhand: { name: "blade" } }).problems, []);
	// a class item: worn, no stats
	assert.deepEqual(ok("ranger", "helmet", { name: "mageshood" }), { problems: [], warnings: ["helmet=mageshood: for mage: a ranger wears it with none of its stats"] });
	assert.deepEqual(K.parseGear("coat+8:dex", G), { name: "coat", level: 8, stat_type: "dex" });
	assert.deepEqual(K.parseGear("bow", G), { name: "bow", level: 0 });
	assert.deepEqual(K.parseGear("stand0", G), { name: "stand0" });
	assert.equal(K.parseGear("none", G), null);
	assert.throws(() => K.parseGear("Bow!", G), /ITEM\[\+LEVEL\]\[:STAT\]\[#TITLE\] or none/);
	assert.deepEqual(K.parseGear("ringsj+3#shiny", G), { name: "ringsj", level: 3, p: "shiny" });
	assert.equal(K.gearSpec({ name: "coat", level: 8, stat_type: "dex", p: "shiny" }), "coat+8:dex#shiny");
	assert.equal(K.gearSpec(null), "none");
	assert.deepEqual(K.checkGear({ ...G, titles: { shiny: {} } }, "ranger", "ring1", { name: "ringsj", level: 1, p: "shiny" }, {}).problems, []);
	assert.deepEqual(K.checkGear({ ...G, titles: { shiny: {} } }, "ranger", "ring1", { name: "ringsj", level: 1, p: "dull" }, {}).problems, ["ring1=ringsj: #dull: no such title"]);
});

// a pulls dir with one pull of "acc": Ran (ranger L64, at spookytown), Mer (merchant), Pri (priest L1: no class here,
// so a priest-less game rejects it), its CODE (Ran's and Mer's own slots), the account 6.5 days old
function pullOf() {
	const root = tmp(),
		d = path.join(root, "acc", "2026-09-27T10-00-00Z"),
		exp = (name, cls, level, map, x, y, slots) => write(d, name + ".json", JSON.stringify({ format: "chronal-export/1", exported_at: "2026-09-27T09:00:00.000Z", character: { name, class: cls, level, xp: 5, gold: 100, items: [{ name: "hpot0", q: 9 }], slots, map, x, y }, bank: { gold: 7, items0: [] } }));
	exp("Ran", "ranger", 64, "spookytown", 677.4, 129.2, { mainhand: { name: "bow", level: 8 }, offhand: { name: "quiver", level: 7 }, chest: { name: "coat", level: 8, stat_type: "dex" } });
	exp("Mer", "merchant", 44, "nowhere", 1, 2, { mainhand: { name: "stand0" } });
	write(d, "code/Ran.js", "// Ran live\n");
	write(d, "code/Mer.js", "// Mer live\n");
	write(d, "code/core.js", "// core\n");
	write(d, "pull.json", JSON.stringify({
		format: "chronal-pull/1", pulled_at: "2026-09-27T10:00:00.000Z", account: "acc",
		characters: [{ name: "Ran", class: "ranger", level: 64, file: "Ran.json", source: "api" }, { name: "Mer", class: "merchant", level: 44, file: "Mer.json", source: "api" }],
		account_age: { days: 6.5 }, code: { dir: "code", slots: 3, characters: ["Ran", "Mer"] },
	}));
	return { root, dir: d };
}
const env = (p) => ({ G, pullsDir: p.root, codeSets: null, now: new Date("2026-09-27T11:00:00.000Z") });

test("continue from now: the pull's states, places, bank, age and CODE; the fighters partied by CODE", () => {
	const p = pullOf();
	const { base, variants, info, warnings } = K.compose({ chars: "Mer,Ran" }, env(p));
	assert.equal(variants.length, 1);
	const s = variants[0].setup;
	assert.equal(s.name, "now-0927-1000");
	assert.deepEqual(s.defaults, { account: "acc", code: { dir: path.join(p.dir, "code"), append: [] } });
	assert.deepEqual(s.accounts, { acc: { bank: { from: path.join(p.dir, "Mer.json") }, age_days: 6.5 } });
	assert.deepEqual(s.characters, [
		{ name: "Mer", class: "merchant", account: "acc", state: { from: path.join(p.dir, "Mer.json") } },
		{ name: "Ran", class: "ranger", account: "acc", at: "spookytown:677:129", state: { from: path.join(p.dir, "Ran.json") } },
	]);
	assert.equal(s.party, undefined); // one fighter: no party
	assert.deepEqual(warnings, ["Mer: pulled at nowhere 1,2, not a place in the sim's game: it starts at main's spawn"]);
	assert.deepEqual(info.states, { Mer: "pull (L44)", Ran: "pull (L64)" });
	assert.equal(variants[0].code_set, "pull:acc/2026-09-27T10-00-00Z");
	assert.match(s.notes, /^Composed by chronal new, 2026-09-27 11:00 \| pull acc\/2026-09-27T10-00-00Z \| CODE: pull:acc\/2026-09-27T10-00-00Z \| states: Mer pull \(L44\), Ran pull \(L64\)\.$/);
	assert.equal(base.run && Object.keys(base.run).length, 0);
	// it loads as a setup
	assert.deepEqual(S.resolveSetup(S.loadSetup(s, { G }), { build: false, G }).resolved.characters.map((c) => [c.name, c.code.entry]), [["Mer", "Mer"], ["Ran", "Ran"]]);
	// who: --chars, a template or --char; not a character of the pull
	assert.throws(() => K.compose({}, env(p)), /--chars: who is logged in \(the pull has Ran \(ranger L64\), Mer \(merchant L44\)\)/);
	assert.throws(() => K.compose({ chars: "Zed" }, env(p)), /--chars Zed: not a character of the pull/);
	assert.throws(() => K.compose({ chars: "Ran", pull: "acc/nope" }, env(p)), /--pull acc\/nope: no such pull/);
});

test("another player's characters (a page taken, --player): on their account (no bank, 40 days), the inventory and gold of the pull's character of their class, else a new one's; --account-of, --account-age, --account-bank", () => {
	const p = pullOf(),
		players = tmp(),
		d = path.join(players, "Kestrel", "2026-09-27T10-30-00Z"),
		exp = (name, cls, level, slots) => write(d, name + ".json", JSON.stringify({ format: "chronal-export/1", exported_at: "2026-09-27T10:30:00.000Z", source: { from: "public" }, character: { name, class: cls, level, xp: 0, gold: 0, items: [], slots }, bank: null }));
	exp("Zed", "ranger", 90, { mainhand: { name: "firebow", level: 7 } });
	exp("Mage9", "mage", 80, { mainhand: { name: "staff", level: 9 } });
	write(d, "pull.json", JSON.stringify({
		format: "chronal-pull/1", source: "public", pulled_at: "2026-09-27T10:30:00.000Z", account: "Kestrel", bank: null, account_age: { days: null }, code: null,
		characters: [{ name: "Zed", class: "ranger", level: 90, file: "Zed.json", source: "public" }, { name: "Mage9", class: "mage", level: 80, file: "Mage9.json", source: "public" }],
	}));
	const e = { ...env(p), playersDir: players };
	const { variants, info } = K.compose({ chars: "Mer,Ran,Zed,Mage9", players: ["Kestrel"] }, e),
		s = variants[0].setup;
	assert.deepEqual(s.accounts, { acc: { bank: { from: path.join(p.dir, "Mer.json") }, age_days: 6.5 }, Kestrel: { ip: "Kestrel", age_days: 40 } }); // (another player: its own IP)
	assert.deepEqual(s.characters.slice(2), [
		{ name: "Zed", class: "ranger", account: "Kestrel", state: { from: path.join(d, "Zed.json"), items: [{ name: "hpot0", q: 9 }], gold: 100 } },
		{ name: "Mage9", class: "mage", account: "Kestrel", state: { from: path.join(d, "Mage9.json"), items: S.startState(G, "mage", {}, null).items } },
	]);
	assert.deepEqual(info.states, { Mer: "pull (L44)", Ran: "pull (L64)", Zed: "public page (L90), the inventory and gold of Ran", Mage9: "public page (L80), a new character's inventory" });
	assert.deepEqual(info.players, [d]);
	assert.match(s.notes, / \| players' pages Kestrel\/2026-09-27T10-30-00Z \| /);
	assert.deepEqual(s.party.members, ["Ran", "Zed", "Mage9"]);
	// their CODE: none in the pull's (the choices, as for any character without its entry); then it plays their gear and
	// level, with the inventory given
	assert.deepEqual(K.lackingOf(s, { build: null }).map((m) => m.name), ["Zed", "Mage9"]);
	K.applyChoice(s, "Zed", "slot:Ran"), K.applyChoice(s, "Mage9", "idle");
	const z = S.resolveSetup(S.loadSetup(s, { G }), { build: false, G }).resolved.characters.find((c) => c.name === "Zed");
	assert.deepEqual([z.account, z.state.level, z.state.slots.mainhand, z.state.items, z.state.gold], ["Kestrel", 90, { name: "firebow", level: 7 }, [{ name: "hpot0", q: 9 }], 100]);
	// accounts: a character moved to another, an account's age and bank (a pull's, or none)
	assert.deepEqual(K.compose({ chars: "Ran,Zed", players: [d], account_of: { Ran: "Kestrel" }, account_age: { Kestrel: 3 }, account_bank: { Kestrel: "acc" } }, e).variants[0].setup.accounts, { Kestrel: { bank: { from: path.join(p.dir, "Ran.json") }, age_days: 3, ip: "Kestrel" } });
	assert.deepEqual(K.compose({ chars: "Ran", account_bank: { acc: "none" } }, e).variants[0].setup.accounts, { acc: { age_days: 6.5 } });
	assert.throws(() => K.compose({ chars: "Zed", players: ["Kestrel"], account_bank: { Kestrel: "Kestrel" } }, e), /--account-bank Kestrel=Kestrel: none, or the account of a pull with a bank \(acc\)/);
	assert.throws(() => K.compose({ chars: "Zed", players: ["Kestrel"], account_age: { Nope: 1 } }, e), /--account-age Nope: no character of the run is on it \(Kestrel\)/);
	assert.throws(() => K.compose({ chars: "Zed", players: ["Kestrel"], account_of: { Zed: "a b" } }, e), /--account-of Zed=a b: an account's name/);
	assert.throws(() => K.compose({ chars: "Zed", players: ["Nope"] }, e), /--player Nope: no player's page taken in /);
	assert.throws(() => K.compose({ chars: "Zed" }, e), /--chars Zed: not a character of the pull$/);
});

// a player's page taken: Kestrel's Zed (ranger L90) and Mage9 (mage L80)
function pageOf() {
	const players = tmp(),
		d = path.join(players, "Kestrel", "2026-09-27T10-30-00Z"),
		exp = (name, cls, level) => write(d, name + ".json", JSON.stringify({ format: "chronal-export/1", exported_at: "2026-09-27T10:30:00.000Z", source: { from: "public" }, character: { name, class: cls, level, xp: 0, gold: 0, items: [], slots: {} }, bank: null }));
	exp("Zed", "ranger", 90), exp("Mage9", "mage", 80);
	write(d, "pull.json", JSON.stringify({
		format: "chronal-pull/1", source: "public", pulled_at: "2026-09-27T10:30:00.000Z", account: "Kestrel", bank: null, account_age: { days: null }, code: null,
		characters: [{ name: "Zed", class: "ranger", level: 90, file: "Zed.json", source: "public" }, { name: "Mage9", class: "mage", level: 80, file: "Mage9.json", source: "public" }],
	}));
	return { players, dir: d };
}

test("names in CODE: the pull's CODE on a player's characters under their names (by class); chosen, kept, none; the template's", () => {
	const p = pullOf(),
		q = pageOf(),
		e = { ...env(p), playersDir: q.players },
		known = K.knownNames({ pullsDir: p.root, playersDir: q.players });
	write(p.dir, "code/Mer.js", 'var fighters = ["Ran"]; // Ran\nrequire_code("core");\n');
	write(p.dir, "code/Ran.js", 'var merchant = "Mer";\n');
	assert.deepEqual([...known].map(([n, x]) => [n, x.class, x.of]), [["Ran", "ranger", "pull acc"], ["Mer", "merchant", "pull acc"], ["Zed", "ranger", "public page Kestrel"], ["Mage9", "mage", "public page Kestrel"]]);
	const { variants, info } = K.compose({ chars: "Mer,Zed", players: ["Kestrel"] }, e),
		s = variants[0].setup;
	assert.deepEqual(info.code_names, {});
	const st = K.settle(s, { given: info.code_names, known, build: null });
	assert.deepEqual([s.code_names, st.open, st.names.names.map((x) => [x.name, x.to, x.why])], [{ Ran: "Zed" }, [], [["Mer", "Mer", "in the run"], ["Ran", "Zed", "by class"]]]);
	assert.deepEqual(s.characters.map((c) => K.entrySlot(s, c)), ["Mer", "Ran"]);
	const r = S.resolveSetup(S.loadSetup(s, { G }), { build: false, G });
	assert.match(r.bundles.Mer.text, /^var fighters = \["Zed"\]; \/\/ Ran\n/);
	assert.deepEqual([r.bundles.Zed.entry, r.resolved.source.characters.Zed.entry, r.warnings], ["Zed", "Ran", []]);
	// chosen: kept (Ran stays, so Zed lacks its entry); none mapped (false)
	const kept = K.compose({ chars: "Mer,Zed", players: ["Kestrel"], code_names: { Ran: "" } }, e);
	assert.deepEqual(kept.info.code_names, { Ran: "Ran" });
	const s2 = kept.variants[0].setup,
		st2 = K.settle(s2, { given: kept.info.code_names, known, build: null });
	assert.deepEqual([s2.code_names, st2.open.map((m) => m.name)], [{ Ran: "Ran" }, ["Zed"]]);
	const off = K.compose({ chars: "Mer,Zed", players: ["Kestrel"], code_names: false }, e);
	assert.equal(off.info.code_names, false);
	assert.equal(K.settle(off.variants[0].setup, { given: false, known, build: null }).names, null);
	assert.throws(() => K.compose({ chars: "Mer,Zed", players: ["Kestrel"], code_names: { Ran: "Nope" } }, e), /--code-name Ran=Nope: Nope is not in the roster \(Mer, Zed\)/);
	assert.throws(() => K.compose({ chars: "Mer,Zed", players: ["Kestrel"], code_names: { "a b": "Zed" } }, e), /--code-name a b=Zed: NAME=NAME/);
	// a template's moves to a character still in the roster
	const t = write(tmp(), "t.json", JSON.stringify({ format: "chronal-setup/1", name: "t", defaults: { code: { dir: path.join(p.dir, "code") } }, characters: [{ name: "Zed", class: "ranger" }, { name: "Mage9", class: "mage" }], code_names: { Ran: "Zed", Mer: "Mage9", Pri: "Pri" } }));
	assert.deepEqual(K.compose({ template: t, chars: "Zed", players: ["Kestrel"] }, e).info.code_names, { Ran: "Zed" });
});

test("storage, preludes and steering: each account's storage (every account: *; null unsets), a prelude per character (kept over a CODE set), the steering given or the template's; the keys the CODE reads (keysOf); --steer", () => {
	const p = pullOf();
	write(p.dir, "code/Ran.js", 'var m = get("mode"); set("seen", 1); var r = localStorage.getItem("raw"); var d = get(character.name + "_t");\n');
	write(p.dir, "code/Mer.js", 'if (get("mode") === "x" || get("seen")) {}\n');
	const { variants } = K.compose({ chars: "Mer,Ran", storage: { "*": { mode: "farm" }, acc: { n: 3 } }, local_storage: { acc: { raw: "t" } }, prelude: { Ran: 'var boot = get("boot");' }, steer: [{ at: "5m", storage: { mode: "rest" } }] }, env(p)),
		s = variants[0].setup;
	assert.deepEqual([s.accounts.acc.storage, s.accounts.acc.local_storage, s.steer], [{ mode: "farm", n: 3 }, { raw: "t" }, [{ at: "5m", storage: { mode: "rest" } }]]);
	assert.deepEqual(s.characters.map((c) => [c.name, c.code]), [["Mer", undefined], ["Ran", { prelude: 'var boot = get("boot");' }]], "the set's CODE for both, Ran's prelude over it");
	assert.equal(S.resolveSetup(S.loadSetup(s, { G }), { build: false, G }).bundles.Ran.text.split("\n")[0], 'var boot = get("boot");');
	const k = K.keysOf(s, { build: null });
	assert.deepEqual(k.keys.map((x) => [x.key, x.kind, x.count, x.set, x.accounts, x.where]), [
		["mode", "get", 2, false, ["acc"], ["Mer.js", "Ran.js"]], ["boot", "get", 1, false, ["acc"], ["Ran prelude"]], ["raw", "local", 1, false, ["acc"], ["Ran.js"]], ["seen", "get", 1, true, ["acc"], ["Mer.js"]],
	]);
	assert.deepEqual(k.dynamic, [{ where: "Ran.js", line: 1, text: 'get(character.name + "_t")', kind: "get" }]);
	// unset (null), none left: no storage key
	assert.equal(K.compose({ chars: "Mer,Ran", storage: { acc: { mode: null } } }, env(p)).variants[0].setup.accounts.acc.storage, undefined);
	assert.throws(() => K.compose({ chars: "Ran", storage: { other: { a: 1 } }, prelude: { Zed: "1" } }, env(p)), (e) => (assert.deepEqual(e.problems, ["--storage other: no character of the run is on it (acc)", "--prelude Zed: not in the roster (Ran)"]), true));
	// a template's steering and preludes: its entries for the roster's characters; the one given replaces it; a CODE set keeps the prelude
	const t = write(tmp(), "t.json", JSON.stringify({ format: "chronal-setup/1", name: "t", defaults: { code: { dir: path.join(p.dir, "code") } }, accounts: { acc: { storage: { mode: "tpl" } } },
		characters: [{ name: "Ran", class: "ranger", code: { prelude: "var T = 1;" } }, { name: "Mer", class: "merchant" }], steer: [{ at: "1m", character: "Mer", code: "1" }, { at: "2m", code: "2" }] }));
	const ts = K.compose({ template: t, chars: "Ran", code_set: `dir:${path.join(p.dir, "code")}` }, { ...env(p), codeSets: null }).variants[0].setup;
	assert.deepEqual([ts.steer, ts.characters[0].code, ts.accounts.acc.storage], [[{ at: "2m", code: "2" }], { prelude: "var T = 1;" }, { mode: "tpl" }]);
	assert.equal(K.compose({ template: t, chars: "Ran", steer: [] }, env(p)).variants[0].setup.steer, undefined);
	// --steer
	assert.deepEqual(["20m mode=\"rest\"", "25m@Mer run set_message('a=b')", "90s n=3"].map(K.steerOf), [{ at: "20m", storage: { mode: "rest" } }, { at: "25m", character: "Mer", code: "set_message('a=b')" }, { at: "90s", storage: { n: 3 } }]);
	assert.throws(() => K.steerOf("20m"), /--steer 20m: "AT\[@NAME\] KEY=VALUE", "AT\[@NAME\] run CODE" or a step as JSON/);
	assert.deepEqual(K.steerOf('{"when": "c.Ran.kills.goo >= 5", "for": "1m", "code": "x()"}'), { when: "c.Ran.kills.goo >= 5", for: "1m", code: "x()" });
	assert.throws(() => K.steerOf("{nope"), /--steer \{nope: /);
	// --until: the setup's run.until ("": none)
	assert.equal(K.compose({ chars: "Ran", until: "c.Ran.kills.goo >= 5" }, env(p)).variants[0].setup.run.until, "c.Ran.kills.goo >= 5");
	assert.equal(K.compose({ chars: "Ran", check_every: "500ms" }, env(p)).variants[0].setup.run.check, "500ms");
});

test("a template: exported states refreshed from the pull, inline ones kept; --chars, --state, --level, --offline, --party", () => {
	const p = pullOf(),
		d = tmp();
	write(d, "lib/Ran.js", "// Ran local\n");
	write(d, "lib/Pri.js", "// Pri local\n");
	write(d, "old/Ran.json", JSON.stringify({ format: "chronal-export/1", exported_at: "2026-09-20T00:00:00.000Z", character: { name: "Ran", class: "ranger", level: 60 } }));
	const tpl = write(d, "tpl/party.json", JSON.stringify({
		format: "chronal-setup/1", name: "party", strategy: "old words", notes: "the template's notes",
		run: { duration: "30m", seed: 3 }, world: { ping: 50 },
		defaults: { account: "acc", code: { dir: "../lib" } },
		accounts: { acc: { age_days: 0, bank: { from: "../old/Ran.json" } } },
		characters: [
			{ name: "Ran", class: "ranger", at: "spookytown:1:2", state: { from: "../old/Ran.json" }, extra: ["go();"] },
			{ name: "Pri", class: "ranger", state: { level: 60 } },
			{ name: "Wiz", class: "mage" },
		],
		party: { members: ["Ran", "Pri", "Wiz"], leader: "Wiz", form: "harness" },
	}));
	const { variants, info } = K.compose({ template: tpl, chars: "Ran,Pri", duration: "5m", ping: 18 }, env(p));
	const s = variants[0].setup;
	assert.equal(s.name, "party-0927-1000");
	assert.equal(s.strategy, null);
	assert.deepEqual([s.run, s.world], [{ duration: "5m", seed: 3 }, { ping: 18 }]);
	assert.deepEqual(s.defaults, { account: "acc", code: { dir: path.join(d, "lib") } }); // the template's CODE
	assert.deepEqual(s.accounts, { acc: { age_days: 6.5, bank: { from: path.join(p.dir, "Ran.json") } } });
	assert.deepEqual(s.characters.map((c) => [c.name, c.at, c.state]), [["Ran", "spookytown:1:2", { from: path.join(p.dir, "Ran.json") }], ["Pri", undefined, { level: 60 }]]);
	assert.deepEqual(s.characters[0].extra, ["go();"]);
	assert.deepEqual(s.party, { members: ["Ran", "Pri"], leader: "Ran", form: "harness" }); // Wiz is out: Ran leads
	assert.deepEqual(info.states, { Ran: "pull (L64)", Pri: "template (L60)" });
	assert.match(s.notes, /template party\.json .*CODE: the template's.* Template notes: the template's notes$/);
	// --state, --level, --offline, --party, --age-days
	const t = K.compose({ template: tpl, state: { Ran: "template", Pri: "fresh" }, level: { Pri: 30 }, offline: ["Wiz"], party: "Pri,Ran/code", age_days: 2 }, env(p)).variants[0].setup;
	assert.deepEqual(t.characters.map((c) => [c.name, c.state, c.online]), [["Ran", { from: path.join(d, "old", "Ran.json") }, undefined], ["Pri", { level: 30 }, undefined], ["Wiz", undefined, false]]);
	assert.deepEqual(t.party, { members: ["Pri", "Ran"], leader: "Pri", form: "code" });
	assert.deepEqual(t.accounts.acc, { age_days: 2, bank: { from: path.join(d, "old", "Ran.json") } });
	assert.equal(K.compose({ template: tpl, party: false }, env(p)).variants[0].setup.party, undefined);
	assert.throws(() => K.compose({ template: tpl, state: { Wiz: "pull" } }, env(p)), /--state Wiz=pull: not in the pull/);
	assert.throws(() => K.compose({ template: tpl, level: { Zed: 3 } }, env(p)), /--level Zed: not in the roster/);
	assert.throws(() => K.compose({ template: tpl, party: "Ran,Zed/x" }, env(p)), (e) => e.problems.includes("--party Zed: not in the roster") && e.problems.includes("--party /x: harness, code, none"));
});

test("from scratch, gear edits (over the gear it starts with) and sweeps; a CODE set", () => {
	const p = pullOf(),
		d = tmp();
	write(d, "lib/Ran.js", "");
	write(d, "lib/Wiz.js", "");
	const { variants } = K.compose({
		chars: "Ran", char: ["Wiz:mage:60"], code_set: `dir:${path.join(d, "lib")}`,
		gear: ["Ran:chest=coat+9:dex", "Wiz:helmet=mageshood+3"], sweep_gear: ["Ran:mainhand=bow+10,firebow+7"], sweep_code_set: `dir:${path.join(d, "lib")},pull:acc`,
	}, env(p));
	assert.deepEqual(variants.map((v) => [v.label, v.key, v.code_set]), [
		[`Ran mainhand=bow+10, CODE dir:${path.join(d, "lib")}`, `Ran-mainhand-bow+10--code-dir_${path.join(d, "lib").replace(/[^\w.+=-]/g, "_")}`, `dir:${path.join(d, "lib")}`],
		["Ran mainhand=bow+10, CODE pull:acc", "Ran-mainhand-bow+10--code-pull_acc", "pull:acc"],
		[`Ran mainhand=firebow+7, CODE dir:${path.join(d, "lib")}`, `Ran-mainhand-firebow+7--code-dir_${path.join(d, "lib").replace(/[^\w.+=-]/g, "_")}`, `dir:${path.join(d, "lib")}`],
		["Ran mainhand=firebow+7, CODE pull:acc", "Ran-mainhand-firebow+7--code-pull_acc", "pull:acc"],
	]);
	const s = variants[3].setup,
		[ran, wiz] = s.characters;
	assert.equal(s.name, "now-0927-1000 [Ran mainhand=firebow+7, CODE pull:acc]");
	// Ran: its export's gear (no starter helmet or shoes: the export has none), the chest and the mainhand changed; Wiz:
	// the starter gear, the helmet changed
	assert.deepEqual(ran.state, { from: path.join(p.dir, "Ran.json"), slots: { mainhand: { name: "firebow", level: 7 }, helmet: null, shoes: null, offhand: { name: "quiver", level: 7 }, chest: { name: "coat", level: 9, stat_type: "dex" } } });
	assert.deepEqual(wiz, { name: "Wiz", class: "mage", account: "acc", state: { level: 60, slots: { mainhand: { name: "staff", level: 0, gift: 1 }, helmet: { name: "mageshood", level: 3 }, shoes: { name: "shoes", level: 0, gift: 1 } } } });
	assert.deepEqual(variants[0].setup.defaults.code, { dir: path.join(d, "lib"), append: [] });
	assert.deepEqual(s.defaults.code, { dir: path.join(p.dir, "code"), append: [] });
	assert.match(s.notes, /gear: Ran chest=coat\+9:dex, Wiz helmet=mageshood\+3, Ran mainhand=firebow\+7/);
	// the rules, every problem at once
	assert.throws(() => K.compose({ chars: "Ran", char: ["Wiz:mage"], gear: ["Wiz:mainhand=bow", "Ran:mainhand=bow+13"] }, env(p)), (e) => e.problems.join("|") === "Wiz mainhand=bow: a mage can't use a bow as its mainhand|Ran mainhand=bow: level 13: it goes to +12");
	assert.throws(() => K.compose({ chars: "Ran", char: ["Ran:mage"] }, env(p)), /--char Ran: already in the roster/);
	assert.throws(() => K.compose({ chars: "Ran", char: ["Wiz:bard"] }, env(p)), /no class bard/);
	assert.throws(() => K.compose({ chars: "Ran", gear: ["Zed:mainhand=bow"] }, env(p)), /--gear Zed: not in the roster/);
});

test("per character: another CODE set, another entry, inventory, gold; a character as an object; statesOf", () => {
	const p = pullOf(),
		d = tmp();
	write(d, "lib/Wiz.js", "");
	write(d, "lib/core.js", "");
	const { variants } = K.compose({
		chars: "Ran,Mer", char: [{ name: "Wiz", class: "mage", level: 30, account: "alt" }],
		code_sets: { Wiz: `dir:${path.join(d, "lib")}` }, entries: { Ran: "core" },
		items: { Ran: [{ name: "hpot0", q: 5 }, null] }, gold: { Mer: 123 }, gear: ["Wiz:mainhand=staff+3"],
	}, env(p));
	const s = variants[0].setup,
		[ran, mer, wiz] = s.characters;
	assert.deepEqual(ran.code, { entry: "core", file: null });
	assert.deepEqual(wiz.code, { dir: path.join(d, "lib"), recursive: false, entry: "Wiz", file: null, prelude: null, append: [], build: null, git: null });
	assert.equal(wiz.account, "alt");
	assert.deepEqual(ran.state.items, [{ name: "hpot0", q: 5 }, null]);
	assert.equal(mer.state.gold, 123);
	assert.match(s.notes, /CODE per character: Wiz dir:.*, Ran slot core \| gear: Wiz mainhand=staff\+3 \| inventory or gold set: Ran, Mer/);
	const r = S.resolveSetup(S.loadSetup(s, { G }), { build: false, G }).resolved;
	assert.deepEqual(r.characters.map((c) => [c.name, c.code.entry]), [["Ran", "core"], ["Mer", "Mer"], ["Wiz", "Wiz"]]);
	const st = K.statesOf(s, G);
	assert.deepEqual([st.Ran.level, st.Ran.items, st.Mer.gold, st.Mer.level, st.Wiz.level, st.Wiz.slots.mainhand], [64, [{ name: "hpot0", q: 5 }, null], 123, 44, 30, { name: "staff", level: 3 }]);
	assert.deepEqual(st.Ran.slots.chest, { name: "coat", level: 8, stat_type: "dex" });
	assert.throws(() => K.compose({ chars: "Ran", items: { Ran: [{ name: "nope" }] } }, env(p)), /--items Ran: \{"name":"nope"\}/);
	// the inventory's size (42) and a stack's (the game's s; none: 1)
	assert.throws(() => K.compose({ chars: "Ran", items: { Ran: Array.from({ length: 43 }, () => ({ name: "bow" })) } }, env(p)), /--items Ran: 43 items, the inventory holds 42/);
	const big = K.compose({ chars: "Ran", items: { Ran: [{ name: "hpot0", q: 99999 }, { name: "bow", q: 3 }] } }, env(p));
	assert.deepEqual(big.variants[0].setup.characters[0].state.items, [{ name: "hpot0", q: 9999 }, { name: "bow", q: 1 }]);
	assert.ok(big.warnings.some((w) => /hpot0 x99999: a stack holds 9999, so x9999/.test(w)));
	assert.throws(() => K.compose({ chars: "Ran", gold: { Zed: 1 } }, env(p)), /--gold Zed: not in the roster/);
	assert.throws(() => K.compose({ chars: "Ran", char: [{ name: "bad name", class: "mage" }] }, env(p)), /a name of 1-12 letters and digits/);
});

test("missing CODE: lackingOf finds the characters without an entry; applyChoice: idle, exclude (from the party), a slot", () => {
	const p = pullOf();
	const { variants } = K.compose({ chars: "Mer,Ran", char: ["Wiz:mage", "Bob:ranger"], party: "Ran,Wiz,Bob" }, env(p)),
		s = variants[0].setup;
	assert.deepEqual(K.lackingOf(s, { build: null }), [{ name: "Wiz", entry: "Wiz", slots: ["Mer", "Ran", "core"], where: path.join(p.dir, "code"), guess: null }, { name: "Bob", entry: "Bob", slots: ["Mer", "Ran", "core"], where: path.join(p.dir, "code"), guess: null }]);
	K.applyChoice(s, "Wiz", "idle");
	K.applyChoice(s, "Bob", "slot:Ran");
	K.applyChoice(s, "Ran", "exclude");
	assert.deepEqual(s.characters.map((c) => c.name), ["Mer", "Wiz", "Bob"]);
	assert.deepEqual(s.characters[1].code, { file: C.IDLE, entry: null, prelude: null, append: [] });
	assert.deepEqual(s.characters[2].code, { entry: "Ran" });
	assert.deepEqual(s.party, { members: ["Wiz", "Bob"], leader: "Wiz", form: "code" });
	assert.deepEqual(K.lackingOf(s, { build: null }), []);
	const r = S.resolveSetup(S.loadSetup(s, { G }), { build: false, G });
	assert.deepEqual(r.resolved.characters.map((c) => c.code.entry), ["Mer", "idle.js", "Ran"]);
});

test("writeSetups: paths relative within a project, absolute across; no overwrite (--force), never the template", () => {
	const p = pullOf(),
		d = tmp();
	const s = K.compose({ chars: "Ran" }, env(p)).variants[0].setup;
	const inside = path.join(p.root, "setups", "a.json");
	K.writeSetups([{ file: inside, setup: s }]);
	assert.deepEqual(read(inside).characters[0].state, { from: path.join("..", "acc", "2026-09-27T10-00-00Z", "Ran.json") });
	assert.equal(S.loadSetup(inside, { G }).characters[0].state.from, path.join(p.dir, "Ran.json"));
	const outside = path.join("/tmp", path.basename(d) + "-x.json");
	dirs.push(outside);
	K.writeSetups([{ file: outside, setup: s }]);
	assert.equal(read(outside).characters[0].state.from, path.join(p.dir, "Ran.json"));
	assert.throws(() => K.writeSetups([{ file: inside, setup: s }]), /exists \(--force replaces it/);
	K.writeSetups([{ file: inside, setup: s }], { force: true });
	assert.throws(() => K.writeSetups([{ file: inside, setup: s }], { force: true, template: inside }), /that's the template/);
});

test("chronal new --check: writes the setup, asks for missing CODE (--missing), checks it; names in CODE", () => {
	const p = pullOf(),
		out = tmp(),
		players = tmp(),
		run = (...a) => {
			try {
				return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "new", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CHRONAL_PULLS_DIR: p.root, CHRONAL_PLAYERS_DIR: players, CHRONAL_CODE_SETS: "", CHRONAL_LIBRARY_DIR: path.join(out, "library"), CHRONAL_SETUPS_DIR: out } }) };
			} catch (e) {
				return { code: e.status, out: e.stdout + e.stderr };
			}
		};
	// the real game: Ran is a ranger, a new priest has no CODE in the pull
	let r = run("--chars", "Ran", "--char", "Pri1:priest:40", "--check");
	assert.equal(r.code, 2);
	assert.match(r.out, /problem: Pri1: the CODE set pull:acc\/2026-09-27T10-00-00Z has no slot Pri1 \(no CODE loaded for it on live\): choose with --missing Pri1=<slot>\|idle\|exclude/);
	assert.deepEqual(fs.readdirSync(out), []); // nothing written
	r = run("--chars", "Ran", "--char", "Pri1:priest:40", "--missing", "Pri1=idle", "--name", "t1", "--check");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /ok t1\.json: Ran Ran [0-9a-f]{8}, Pri1 idle\.js [0-9a-f]{8}/);
	const s = read(path.join(out, "t1.json"));
	assert.deepEqual(s.characters.map((c) => c.name), ["Ran", "Pri1"]);
	assert.equal(run("--chars", "Ran", "--name", "t1").code, 2); // exists
	assert.equal(run("--chars", "Ran", "--char", "Pri1:priest:40", "--missing", "Ran=idle", "--name", "t2").code, 2);
	// names in CODE: a character from scratch of Ran's class runs Ran's CODE as Ran; one chosen; none
	write(p.dir, "code/Mer.js", 'var fighters = ["Ran"];\n');
	r = run("--chars", "Mer", "--char", "Ran2:ranger:40", "--name", "t3", "--check");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /  Ran2 +ranger .* Ran\n/);
	assert.match(r.out, /names in CODE: Ran as Ran2 \(by class\)/);
	assert.deepEqual(read(path.join(out, "t3.json")).code_names, { Ran: "Ran2" });
	r = run("--chars", "Mer", "--char", "Ran2:ranger:40", "--code-name", "Ran=Ran", "--missing", "Ran2=idle", "--name", "t4", "--check");
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(read(path.join(out, "t4.json")).code_names, { Ran: "Ran" });
	r = run("--chars", "Mer", "--char", "Ran2:ranger:40", "--no-code-names", "--missing", "Ran2=idle", "--name", "t5", "--check");
	assert.equal(r.code, 0, r.out);
	assert.equal("code_names" in read(path.join(out, "t5.json")), false);
});
