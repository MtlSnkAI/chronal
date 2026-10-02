"use strict";
// dashboard/new.js (the dashboard's New run form, api/new): what there is to compose from, the item catalog and
// what fits a slot, the composer's preview (states, CODE, missing entries) and its check, save and starts (chronal run per
// variant and seed within the sim threads), snippet exports into a pull, other
// players' public pages (a fake of the site), names in CODE in the preview and check, storage and steering.
//   node --test test/dashboard_new.test.js      (needs the game: config al_root, chronal install)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const { newRuns } = require("../dashboard/new");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "dashnew-test-"))), dirs[dirs.length - 1]);
const envWas = { ...process.env };
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	for (const k of ["CHRONAL_PULLS_DIR", "CHRONAL_PLAYERS_DIR", "CHRONAL_SETUPS_DIR", "CHRONAL_CODE_SETS", "CHRONAL_LIBRARY_DIR", "CHRONAL_AL_TOKEN_FILE", "CHRONAL_AL_TOKEN", "CHRONAL_AL_SITE"]) (envWas[k] === undefined ? delete process.env[k] : (process.env[k] = envWas[k]));
});
const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// a world of its own: a pull of "acc" (Ran a ranger, Mer a merchant; CODE for both), a template, a sets file
function world() {
	const root = tmp(),
		pulls = path.join(root, "pulls"),
		pd = path.join(pulls, "acc", "2026-09-27T10-00-00Z"),
		exp = (name, cls, level, slots) => write(pd, name + ".json", JSON.stringify({ format: "chronal-export/1", exported_at: "2026-09-27T10:00:00.000Z", source: { from: "api" }, character: { name, class: cls, level, xp: 5, gold: 100, items: [{ name: "hpot0", q: 9 }, null], slots, map: "main", x: 1, y: 2 }, bank: { gold: 7, items0: [] }, bank_source: { from: "api", at: "2026-09-27T10:00:00.000Z" } }));
	exp("Ran", "ranger", 64, { mainhand: { name: "bow", level: 8 }, chest: { name: "coat", level: 8, stat_type: "dex" } });
	exp("Mer", "merchant", 44, {});
	write(pd, "bank.json", JSON.stringify({ bank: { gold: 7, items0: [] }, bank_source: { from: "api", at: "2026-09-27T10:00:00.000Z" } }));
	write(pd, "code/Ran.js", "// Ran live\n");
	write(pd, "code/Mer.js", "// Mer live\n");
	write(pd, "pull.json", JSON.stringify({
		format: "chronal-pull/1", pulled_at: "2026-09-27T10:00:00.000Z", account: "acc",
		characters: [{ name: "Ran", class: "ranger", level: 64, online: true, file: "Ran.json", source: "api" }, { name: "Mer", class: "merchant", level: 44, online: false, file: "Mer.json", source: "api" }],
		bank: { from: "api", gold: 7 }, account_age: { days: 6.5 }, code: { dir: "code", slots: 2, characters: ["Ran", "Mer"] }, game: { sections: { items: { differ: ["x"], text: [] } } }, warnings: ["a warning"], overrides: [],
	}));
	const setups = path.join(root, "setups");
	write(setups, "duo.json", JSON.stringify({ format: "chronal-setup/1", name: "duo", defaults: { account: "acc", code: { dir: path.join(pd, "code") } }, characters: [{ name: "Ran", class: "ranger", state: { from: path.join(pd, "Ran.json") } }, { name: "Pri", class: "priest", state: { level: 60 } }] }));
	write(setups, "a-run--1.setup.json", JSON.stringify({ format: "chronal-setup/1", resolved: {}, characters: [] })); // a side file: not a template
	write(setups, "junk.json", "{");
	write(root, "farm.js", "// farm\n");
	const sets = write(root, "sets.json", JSON.stringify({ format: "chronal-code-sets/1", sets: { farm: { file: path.join(root, "farm.js") } } }));
	Object.assign(process.env, { CHRONAL_PULLS_DIR: pulls, CHRONAL_PLAYERS_DIR: path.join(root, "players"), CHRONAL_SETUPS_DIR: setups, CHRONAL_CODE_SETS: sets, CHRONAL_LIBRARY_DIR: path.join(root, "library"), CHRONAL_GEAR_SETS_DIR: path.join(root, "gearsets"), CHRONAL_AL_TOKEN_FILE: path.join(root, "no-token") });
	delete process.env.CHRONAL_AL_TOKEN;
	return { root, pulls, pd, setups };
}
// the dashboard around it: its launches and threads
function dash(o = {}) {
	const launches = [],
		started = [];
	const x = {
		dir: o.dir || tmp(), root: "/r", cli: "/r/chronal.js",
		worlds: () => o.worlds || [], threads: () => ({ threads_busy: 0, threads_max: o.max ?? 100 }),
		startSim: (L, cwd, args, env) => started.push({ L, cwd, args, env }), stamp: () => "20260927T100000Z", addLaunch: (L) => launches.push(L),
	};
	return { N: newRuns(x), launches, started, x };
}

test("info: pulls, templates (not side files), CODE sets, classes, no token; items and what fits a slot", () => {
	const w = world(),
		{ N } = dash();
	const [code, i] = N.info();
	assert.equal(code, 200);
	assert.deepEqual(i.pulls.map((p) => [p.id, p.characters.map((c) => c.name), p.game, p.account_age.days, p.warnings]), [["acc/2026-09-27T10-00-00Z", ["Ran", "Mer"], { differ: 1, text: 0 }, 6.5, ["a warning"]]]);
	assert.deepEqual(i.templates.map((t) => [t.name, t.characters.map((c) => [c.name, c.exported, c.level])]), [["duo", [["Ran", true, null], ["Pri", false, 60]]]]);
	assert.deepEqual(i.code_sets.map((s) => s.name), ["farm", "example", "pull:latest", "pull:acc", "pull:acc/2026-09-27T10-00-00Z"]);
	assert.equal(i.token, false);
	assert.equal(i.setups_dir, w.setups);
	assert.ok(i.classes.ranger && i.classes.merchant);
	const [, it] = N.items();
	assert.deepEqual(it.items.bow.slice(1, 5), ["weapon", "bow", 12, 0]);
	assert.ok(it.stats.includes("dex") && it.titles.includes("shiny"));
	const fits = (q) => N.fits(new URLSearchParams(q));
	assert.ok(fits("class=ranger&slot=mainhand")[1].items.some(([k]) => k === "bow"));
	assert.ok(!fits("class=mage&slot=mainhand")[1].items.some(([k]) => k === "bow"));
	assert.ok(fits("class=ranger&slot=chest")[1].items.every(([k]) => it.items[k][1] === "chest"));
	// the class's own first, then by tier (untiered last) and value
	const G = require("../lib/compose").game(require("../lib/config").config().al_root), order = fits("class=ranger&slot=mainhand")[1].items;
	const cmp = ([a, x], [b, y]) => x - y || (G.items[a].tier ?? Infinity) - (G.items[b].tier ?? Infinity) || (G.items[a].g || 0) - (G.items[b].g || 0);
	assert.ok(order.some(([, o]) => o) && order.every((x, i) => !i || cmp(order[i - 1], x) <= 0));
	assert.equal(fits("class=bard&slot=mainhand")[0], 400);
	assert.equal(fits("class=ranger&slot=trade1")[0], 400);
});

test("compose preview: each character's start and CODE, the ones without an entry asked for, then chosen", async () => {
	const w = world(),
		{ N } = dash();
	let [code, r] = await N.compose({ opts: { chars: "Mer,Ran", char: [{ name: "Wiz", class: "mage", level: 30 }], gear: ["Ran:mainhand=firebow+7"], items: { Mer: [{ name: "hpot1", q: 5 }] } } });
	assert.equal(code, 200);
	assert.equal(r.ok, false);
	assert.deepEqual(r.missing.map((m) => [m.name, m.entry, m.slots]), [["Wiz", "Wiz", ["Mer", "Ran"]]]);
	const v = r.variants[0],
		c = Object.fromEntries(v.characters.map((x) => [x.name, x]));
	assert.deepEqual([c.Ran.start.level, c.Ran.start.slots.mainhand, c.Ran.start.slots.chest, c.Ran.source], [64, { name: "firebow", level: 7 }, { name: "coat", level: 8, stat_type: "dex" }, "pull (L64)"]);
	assert.deepEqual(c.Mer.start.items, [{ name: "hpot1", q: 5 }]);
	assert.deepEqual([c.Wiz.start.level, c.Wiz.account, c.Wiz.code.entry], [30, "acc", "Wiz"]);
	assert.deepEqual([c.Ran.code.set, c.Ran.slots], ["pull:acc/2026-09-27T10-00-00Z", ["Mer", "Ran"]]);
	assert.equal(v.setup, undefined); // the setup stays on the server
	[, r] = await N.compose({ opts: { chars: "Mer,Ran", char: [{ name: "Wiz", class: "mage" }] }, missing: { Wiz: "idle" } });
	assert.equal(r.ok, true);
	assert.equal(r.variants[0].characters.find((x) => x.name === "Wiz").code.idle, true);
	[, r] = await N.compose({ opts: { chars: "Mer,Ran", char: [{ name: "Wiz", class: "mage" }] }, missing: { Wiz: "slot:nope" } });
	assert.deepEqual(r.problems, ["Wiz: no slot nope in its CODE"]);
	[, r] = await N.compose({ opts: { chars: "Nobody" } });
	assert.deepEqual([r.ok, r.problems], [false, ["Who is logged in: Nobody: not a character of the pull"]]);
	[, r] = await N.compose({ opts: { template: path.join(w.setups, "duo.json"), code_set: "farm" } });
	assert.deepEqual([r.ok, r.variants[0].characters.map((x) => [x.name, x.source, x.code.entry])], [true, [["Ran", "pull (L64)", "farm.js"], ["Pri", "template (L60)", "farm.js"]]]);
	assert.equal((await N.compose({ opts: {}, action: "nope" }))[0], 400);
	assert.equal((await N.compose({ opts: { template: "/etc/passwd" } }))[1].problems[0], "template: no setup file /etc/passwd");
});

test("compose check, save (setups_dir; no overwrite unless force), sim starts (per variant and seed, within the threads)", async () => {
	const w = world(),
		d = dash();
	const opts = { chars: "Mer,Ran", sweep_gear: ["Ran:mainhand=bow+8,firebow+7"], duration: "2m" };
	let [, r] = await d.N.compose({ opts, action: "check" });
	assert.equal(r.ok, true);
	assert.deepEqual(r.checked.map((c) => [c.label, Object.keys(c.hashes)]), [["Ran mainhand=bow+8", ["Mer", "Ran"]], ["Ran mainhand=firebow+7", ["Mer", "Ran"]]]);
	[, r] = await d.N.compose({ opts, action: "save", name: "my try" });
	assert.deepEqual(r.files, [path.join(w.setups, "my_try", "Ran-mainhand-bow+8.json"), path.join(w.setups, "my_try", "Ran-mainhand-firebow+7.json")]);
	assert.equal(read(r.files[1]).name, "my try [Ran mainhand=firebow+7]");
	let code;
	[code, r] = await d.N.compose({ opts, action: "save", name: "my try" });
	assert.equal(code, 409);
	[code, r] = await d.N.compose({ opts, action: "save", name: "my try", force: true });
	assert.equal(code, 200);
	assert.equal((await d.N.compose({ opts, action: "save", name: "bad/name" }))[0], 400);
	// starts: 2 variants x 2 seeds, each chronal run <its file> --seed N into the live dir
	[code, r] = await d.N.compose({ opts, action: "sim", seeds: [1, 2] });
	assert.equal(code, 202);
	assert.equal(r.launches.length, 4);
	assert.deepEqual(d.started.map((s) => [s.args[1], path.basename(s.args[2]), s.args.slice(3), s.env.CHRONAL_LIVE_DIR]), [
		["run", "Ran-mainhand-bow+8.json", ["--seed", "1", "--tag", "now-0927-1000 [Ran mainhand=bow+8]"], d.x.dir], ["run", "Ran-mainhand-bow+8.json", ["--seed", "2", "--tag", "now-0927-1000 [Ran mainhand=bow+8]"], d.x.dir],
		["run", "Ran-mainhand-firebow+7.json", ["--seed", "1", "--tag", "now-0927-1000 [Ran mainhand=firebow+7]"], d.x.dir], ["run", "Ran-mainhand-firebow+7.json", ["--seed", "2", "--tag", "now-0927-1000 [Ran mainhand=firebow+7]"], d.x.dir],
	]);
	assert.ok(d.started[0].args[2].startsWith(path.join(d.x.dir, ".launch", "new-")));
	assert.deepEqual([d.launches[0].of, d.launches[0].need, d.launches[0].args.seed], [null, 3, 1]);
	// no room for them all: every one goes to the dashboard's startSim (it starts them or queues the rest)
	const tight = dash({ max: 3 });
	[code, r] = await tight.N.compose({ opts, action: "sim", seeds: [1, 2] });
	assert.deepEqual([code, r.launches.length, tight.started.length], [202, 4, 4]);
	// recorded: chronal run --record (threads mode only)
	const rec = dash();
	[code, r] = await rec.N.compose({ opts: { chars: "Mer,Ran" }, action: "sim", seeds: [4], record: true });
	assert.deepEqual([code, rec.started[0].args.slice(3, 6), r.launches[0].args.record], [202, ["--seed", "4", "--record"], true]);
	assert.equal((await rec.N.compose({ opts: { chars: "Mer,Ran" }, action: "sim", record: "yes" }))[0], 400);
	const one = write(tmp(), "one.json", JSON.stringify({ format: "chronal-setup/1", name: "one", world: { threads: false }, defaults: { account: "acc", code: { file: path.join(w.root, "farm.js") } }, characters: [{ name: "Ran", class: "ranger" }] }));
	[code, r] = await rec.N.compose({ opts: { template: one }, action: "sim", record: true });
	assert.deepEqual([code, r.reason], [400, "record: a setup with world.threads false runs in one thread, which records nothing"]);
	assert.equal((await d.N.compose({ opts, action: "sim", seeds: [0] }))[0], 400);
});

test("snippet exports into a pull; a pull needs a token", async () => {
	const w = world(),
		{ N } = dash();
	const ex = { format: "chronal-export/1", exported_at: "2026-09-27T11:00:00.000Z", character: { name: "Ran", class: "ranger", level: 65, items: [], slots: {} } };
	const [code, r] = N.addExport({ pull: "acc/2026-09-27T10-00-00Z", export: ex });
	assert.deepEqual([code, r.name, r.warnings], [200, "Ran", []]);
	assert.equal(read(path.join(w.pd, "Ran.json")).character.level, 65);
	assert.ok(fs.existsSync(path.join(w.pd, "Ran.api.json")));
	assert.equal(fs.readdirSync(path.join(w.pd, "uploads")).length, 1);
	assert.equal(N.addExport({ pull: "acc/nope", export: ex })[0], 404);
	assert.equal(N.addExport({ pull: "acc/2026-09-27T10-00-00Z", export: { format: "x" } })[0], 400);
	assert.equal(N.addExport({ pull: "acc/2026-09-27T10-00-00Z", export: { ...ex, character: { ...ex.character, name: "Zed" } } })[0], 400); // not a character of the pull
	const [pc, pr] = await N.pull();
	assert.equal(pc, 400);
	assert.match(pr.reason, /no token/);
});

test("removal: an account's older pulls (its newest kept), then all of them; another player's pages", () => {
	const w = world(),
		{ N } = dash(),
		newer = path.join(w.pulls, "acc", "2026-09-28T10-00-00Z");
	fs.cpSync(w.pd, newer, { recursive: true });
	write(newer, "pull.json", JSON.stringify({ ...read(path.join(w.pd, "pull.json")), pulled_at: "2026-09-28T10:00:00.000Z" }));
	const pl = path.join(w.root, "players", "Kestrel", "2026-09-28T10-00-00Z");
	write(pl, "pull.json", JSON.stringify({ format: "chronal-pull/1", pulled_at: "2026-09-28T10:00:00.000Z", account: "Kestrel", characters: [] }));
	assert.deepEqual(N.pullDel("acc", true), [200, { account: "acc", removed: 1 }]);
	assert.deepEqual([fs.existsSync(w.pd), fs.existsSync(newer)], [false, true]);
	assert.deepEqual(N.info()[1].pulls.map((p) => p.id), ["acc/2026-09-28T10-00-00Z"]);
	assert.deepEqual(N.pullDel("acc", false), [200, { account: "acc", removed: 1 }]);
	assert.equal(fs.existsSync(path.join(w.pulls, "acc")), false);
	assert.equal(N.pullDel("acc", false)[0], 404);
	assert.equal(N.pullDel("..", false)[0], 404);
	assert.deepEqual(N.playerDel("Kestrel"), [200, { account: "Kestrel", removed: 1 }]);
	assert.deepEqual([fs.existsSync(path.join(w.root, "players", "Kestrel")), N.info()[1].players.length], [false, 0]);
});

test("gear sets: the built-in ones and yours in info and api/gearsets; yours saved (checked; one of that name replaced), renamed and removed", () => {
	const w = world(),
		{ N } = dash(),
		set = { name: "mine", class: "ranger", gear: { mainhand: "firebow+9:dex", helmet: "none" } };
	assert.deepEqual(N.info()[1].gear_sets.filter((s) => s.class === "ranger").map((s) => [s.name, s.label]), [["ranger-early", "Early"], ["ranger-mid", "Mid"], ["ranger-late", "Late"]]);
	assert.deepEqual(N.gearSetPut("mine", { set }), [200, { set: { format: "chronal-gear-set/1", name: "mine", class: "ranger", gear: { mainhand: "firebow+9:dex" } } }]);
	assert.deepEqual(N.gearSetPut("mine", { set: { ...set, gear: { mainhand: "bow+3" } } })[0], 200);
	assert.deepEqual(N.info()[1].gear_sets.filter((s) => !s.builtin), [{ name: "mine", class: "ranger", gear: { mainhand: "bow+3" } }]);
	assert.equal(N.gearSetPut("other", { set })[0], 400);
	assert.match(N.gearSetPut("ranger-mid", { set: { ...set, name: "ranger-mid" } })[1].reason, /built-in/);
	assert.match(N.gearSetPut("bad", { set: { ...set, name: "bad", gear: { mainhand: "nosuchitem" } } })[1].reason, /no item nosuchitem/);
	const [code, g] = N.gearSets();
	assert.deepEqual([code, g.sets.length, g.sets.at(-1).name, g.classes.includes("merchant")], [200, 19, "mine", true]);
	// renamed (the old one gone), not over another set
	N.gearSetPut("two", { set: { ...set, name: "two" } });
	assert.deepEqual(N.gearSetPut("two", { set: { ...set, name: "two" }, was: "mine" })[0], 409);
	assert.deepEqual(N.gearSetPut("mine2", { set: { ...set, name: "mine2" }, was: "mine" })[0], 200);
	assert.deepEqual(N.gearSets()[1].sets.filter((s) => !s.builtin).map((s) => s.name), ["mine2", "two"]);
	assert.deepEqual(N.gearSetDel("mine2"), [200, { removed: "mine2" }]);
	assert.deepEqual([N.gearSetDel("mine2")[0], fs.existsSync(path.join(w.root, "gearsets", "mine2.json"))], [404, false]);
});

test("another player: their account's public page taken (by any of its characters), listed, in the preview on its own account; the site's top", async (t) => {
	const { fakeSite } = require("./fixtures/public_site");
	const f = await fakeSite({ Kestrel: [{ name: "Zed", cls: "Priest", level: 80, online: true, slots: { mainhand: { name: "bow", level: 7 } } }, { name: "ZedRan", cls: "Ranger", level: 70, slots: { chest: { name: "coat", level: 5, stat_type: "dex" } } }] });
	t.after(f.close);
	const w = world(),
		{ N } = dash();
	process.env.CHRONAL_AL_SITE = f.site;
	const [code, r] = await N.player({ name: "zedran" });
	assert.deepEqual([code, r.account, r.name, r.warnings], [200, "Kestrel", "ZedRan", []]);
	assert.match(r.id, /^Kestrel\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
	assert.ok(fs.existsSync(path.join(w.root, "players", r.id, "ZedRan.json")));
	const [, info] = N.info();
	assert.deepEqual(info.players.map((p) => [p.id, p.account, p.characters.map((c) => c.name)]), [[r.id, "Kestrel", ["Zed", "ZedRan"]]]);
	assert.deepEqual(info.pulls.map((p) => p.id), ["acc/2026-09-27T10-00-00Z"]); // (not among the pulls)
	assert.deepEqual((await N.player({ name: "Nobody" }))[0], 404);
	assert.deepEqual((await N.player({ name: "a b" }))[0], 400);
	// the preview: their characters on their account, the pull's ranger's inventory for theirs
	const [, pv] = await N.compose({ opts: { chars: "Ran,ZedRan,Zed", players: [r.id], account_age: { Kestrel: 90 } }, missing: { ZedRan: "slot:Ran", Zed: "idle" }, action: "preview" });
	assert.deepEqual(pv.problems, []);
	const v = pv.variants[0];
	assert.deepEqual(v.characters.map((c) => [c.name, c.account, c.source]), [["Ran", "acc", "pull (L64)"], ["ZedRan", "Kestrel", "public page (L70), the inventory and gold of Ran"], ["Zed", "Kestrel", "public page (L80), a new character's inventory"]]);
	assert.deepEqual([v.accounts.Kestrel.age_days, v.accounts.Kestrel.bank], [90, null]);
	assert.deepEqual(v.characters[1].start.slots.chest, { name: "coat", level: 5, stat_type: "dex" });
	assert.equal((await N.compose({ opts: { chars: "Ran", players: ["../x"] }, action: "preview" }))[1].problems[0], "players: [ACCOUNT/TIME] of pages taken");
	// the top characters (an hour's copy)
	const [tc, top] = await N.top();
	assert.deepEqual([tc, top.characters.map((c) => c.name)], [200, ["Zed", "ZedRan"]]);
	await N.top();
	assert.equal(f.hits.filter((h) => h === "/characters").length, 1);
});

test("names in CODE: the preview's (by class, chosen: then its CODE is asked for), the entry slot on disk; check resolves the CODE mapped", async (t) => {
	const { fakeSite } = require("./fixtures/public_site");
	const f = await fakeSite({ Kestrel: [{ name: "Zed", cls: "Ranger", level: 80 }, { name: "ZedMer", cls: "Merchant", level: 50 }] });
	t.after(f.close);
	const w = world(),
		{ N } = dash();
	write(w.pd, "code/Mer.js", 'var fighters = ["Ran"], also = "Ran,Pri";\n');
	process.env.CHRONAL_AL_SITE = f.site;
	const [, r] = await N.player({ name: "Zed" });
	const opts = { chars: "Mer,Zed", players: [r.id] };
	const [, pv] = await N.compose({ opts, action: "preview" });
	assert.deepEqual([pv.ok, pv.problems, pv.missing], [true, [], []]);
	const v = pv.variants[0];
	assert.deepEqual(v.names.map, { Ran: "Zed" });
	assert.deepEqual(v.names.names.map((x) => [x.name, x.class, x.of, x.to, x.why, x.count]), [["Ran", "ranger", "pull acc", "Zed", "by class", 1]]);
	assert.deepEqual(v.names.flags.map((x) => [x.where, x.line, x.text, x.name, x.why]), [["Mer.js", 1, '"Ran,Pri"', "Ran", "inside"]]);
	assert.deepEqual(v.characters.map((c) => [c.name, c.code.entry]), [["Mer", "Mer"], ["Zed", "Ran"]]);
	// Ran kept: Zed has no slot of its name, asked for
	const [, kept] = await N.compose({ opts: { ...opts, code_names: { Ran: "Ran" } }, action: "preview" });
	assert.deepEqual([kept.ok, kept.missing.map((m) => m.name), kept.variants[0].names.map], [false, ["Zed"], { Ran: "Ran" }]);
	const [, ck] = await N.compose({ opts, action: "check" });
	assert.equal(ck.ok, true, JSON.stringify(ck.checked));
	assert.deepEqual(ck.checked[0].warnings, ['code_names: 1 string may be meant as a mapped name, not mapped: Mer.js:1 "Ran,Pri" (holds Ran)']);
	assert.equal((await N.compose({ opts: { ...opts, code_names: "Ran=Zed" }, action: "preview" }))[1].problems[0], 'code_names: { <a name in the CODE>: <a character of the run, or "": it stays> } or false');
});

test("storage and steering in the preview: the keys its CODE reads, each account's storage, the steering, a character's prelude; checked and saved with them", async () => {
	const w = world(),
		{ N } = dash();
	write(w.pd, "code/Ran.js", 'var m = get("mode"); var r = localStorage.getItem("raw");\n');
	let [, r] = await N.compose({ opts: { chars: "Mer,Ran", storage: { acc: { mode: "farm" } }, prelude: { Ran: "var P = 1;" }, steer: [{ at: "5m", character: "Ran", code: "P = 2" }] } });
	const v = r.variants[0];
	assert.equal(r.ok, true);
	assert.deepEqual(v.keys.keys.map((x) => [x.key, x.kind, x.accounts]), [["mode", "get", ["acc"]], ["raw", "local", ["acc"]]]);
	assert.deepEqual([v.accounts.acc.storage, v.steer, v.characters.find((x) => x.name === "Ran").code.prelude], [{ mode: "farm" }, [{ at: "5m", character: "Ran", code: "P = 2" }], "var P = 1;"]);
	[, r] = await N.compose({ opts: { chars: "Mer,Ran", steer: [{ at: "x", code: "(" }] } });
	assert.deepEqual(r.problems, [`steer[0].at: "x", a game time since the run's start (90s, 30m, 2h, or minutes)`, "steer[0].code: Unexpected end of input"]);
	for (const [opts, why] of [[{ storage: { acc: 1 } }, "storage: { <account>: { <key>: <value> } }"], [{ prelude: { Ran: 1 } }, "prelude: { <name>: CODE }"], [{ steer: {} }, "steer: a list of { at, character, storage, local_storage, code, note }"]])
		assert.deepEqual((await N.compose({ opts: { chars: "Ran", ...opts } }))[1].problems, [why]);
	[, r] = await N.compose({ opts: { chars: "Mer,Ran", local_storage: { acc: { raw: "t" } }, steer: [{ at: "1m", storage: { mode: "x" } }] }, action: "save", name: "st" });
	const saved = read(r.files[0]);
	assert.deepEqual([saved.accounts.acc.local_storage, saved.steer], [{ raw: "t" }, [{ at: "1m", storage: { mode: "x" } }]]);
	// conditions: a step's when, the run's until; the picker's lists
	[, r] = await N.compose({ opts: { chars: "Mer,Ran", until: "c.Ran.kills.goo >= 5 || steps.go", steer: [{ name: "go", when: "c.Ran.looted.seashell >= 10", for: "1m", repeat: true, storage: { mode: "x" } }, { after: "go", at: "30s", code: "1" }] } });
	assert.deepEqual([r.ok, r.variants[0].run.until, r.variants[0].steer.map((e) => e.when || e.after)], [true, "c.Ran.kills.goo >= 5 || steps.go", ["c.Ran.looted.seashell >= 10", "go"]]);
	[, r] = await N.compose({ opts: { chars: "Mer,Ran", until: "c.Nobody.level > 1" } });
	assert.deepEqual(r.problems, ["run.until: c.Nobody is not a character of this setup"]);
	const [, it] = N.items();
	assert.ok(it.monsters.includes("goo") && it.conditions.includes("mluck"), "the picker's monsters and conditions");
});

test("the CODE library: added from a link, listed under the library, asked to be trusted in the preview (what it reaches), trusted, updated, removed", async () => {
	const w = world(),
		{ N } = dash(),
		{ execFileSync } = require("node:child_process");
	// someone's repo (bot.js reaches a server), by its file:// link
	const src = path.join(w.root, "theirs"),
		bare = path.join(w.root, "theirs.git"),
		git = (...a) => execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" }).trim();
	fs.mkdirSync(src);
	git("init", "-q", "-b", "main");
	write(src, "bot.js", 'fetch("https://dash.example.com/hi");\n');
	git("add", "-A");
	git("commit", "-qm", "one");
	execFileSync("git", ["clone", "-q", "--bare", src, bare]);
	const c1 = git("rev-parse", "HEAD");
	let [code, r] = await N.code({ action: "add", from: "file://" + bare });
	assert.deepEqual([code, r], [200, { name: "theirs", added: true, commit: c1, kind: "git" }]);
	assert.equal((await N.code({ action: "add", from: "file://" + bare, name: "farm" }))[1].reason, "name: a CODE set named farm exists");
	let s = N.info()[1].code_sets.find((x) => x.name === "theirs");
	assert.deepEqual([s.group, s.files, s.lib.commit, s.lib.trusted, s.lib.follows, s.lib.ref], ["others", 1, c1, false, "branch", "main"]);
	assert.deepEqual(N.info()[1].code_sets.map((x) => [x.name, x.group]), [["farm", "yours"], ["theirs", "others"], ["example", "builtin"], ["pull:latest", "pulls"], ["pull:acc", "pulls"], ["pull:acc/2026-09-27T10-00-00Z", "pulls"]]);
	// its revisions, and what it reaches
	const [, ci] = N.codeInfo(new URLSearchParams({ set: "theirs" }));
	assert.deepEqual([ci.revisions.branches.map((b) => [b.name, b.trusted]), ci.scan.network.map((x) => x.what), ci.scan.hosts.map((h) => h.host)], [[["main", false]], ["fetch"], ["dash.example.com"]]);
	assert.equal(N.codeInfo(new URLSearchParams({ set: "nope" }))[0], 404);
	// the preview: others' CODE not trusted yet, nothing starts
	const opts = { chars: "Ran", code_set: "theirs", entries: { Ran: "bot" } };
	[, r] = await N.compose({ opts });
	assert.equal(r.ok, false);
	assert.deepEqual(r.untrusted.map((u) => [u.name, u.commit, u.who, u.scan.network.map((x) => x.what)]), [["theirs", c1, ["Ran"], ["fetch"]]]);
	assert.match(r.risk, /no sandbox/);
	[code, r] = await N.compose({ opts, action: "sim" });
	assert.deepEqual([code, r.ok, r.launches], [200, false, undefined]);
	// trusted: it runs
	assert.equal((await N.code({ action: "trust", name: "theirs", commit: "0".repeat(40) }))[0], 400);
	[code, r] = await N.code({ action: "trust", name: "theirs", commit: c1 });
	assert.deepEqual([code, r.trusted], [200, true]);
	[, r] = await N.compose({ opts, action: "check" });
	assert.deepEqual([r.ok, r.untrusted, r.checked.map((c) => c.problems)], [true, [], [[]]]);
	// a newer commit: pinned on Update, not trusted until it is
	write(src, "bot.js", "say(2);\nload_code(7);\nhelp();\n");
	write(src, "helper.js", "function help() {}\n");
	git("add", "-A");
	git("commit", "-qm", "two");
	execFileSync("git", ["-C", src, "push", "-q", bare, "main"]);
	[, r] = await N.code({ action: "update", name: "theirs" });
	assert.deepEqual([r.moved, r.was, r.count], [true, c1, 1]);
	[, r] = await N.compose({ opts });
	assert.deepEqual(r.untrusted.map((u) => [u.name, u.commit !== c1, u.scan.network]), [["theirs", true, []]]);
	// its fit: a slot number no file has, the helper bot calls; chosen (api/new/code "fit"), and as suggested again
	const fitOf = (x) => x.variants[0].fits.map((f) => [f.lib, f.calls.map((c) => [c.key, c.to, c.why]), f.with.map((w) => [w.entry, w.slots, w.why])]);
	assert.deepEqual(fitOf(r), [["theirs", [["7", undefined, "no file numbered 7"]], [["bot", ["helper"], "defines help"]]]]);
	[code, r] = await N.code({ action: "fit", name: "theirs", calls: { 7: null }, with: { bot: [] } });
	assert.deepEqual([code, r.fit], [200, { calls: { 7: null }, with: { bot: [] } }]);
	[, r] = await N.compose({ opts });
	assert.deepEqual(fitOf(r), [["theirs", [["7", null, "chosen"]], [["bot", [], "chosen"]]]]);
	[, r] = await N.code({ action: "fit", name: "theirs", calls: { 7: "auto" }, with: { bot: "auto" } });
	assert.equal(r.fit, null);
	assert.equal((await N.code({ action: "fit", name: "theirs", calls: { 7: "nope" } }))[1].reason, "fit: 7 -> nope: no slot nope in theirs");
	assert.equal((await N.code({ action: "fit", name: "theirs", calls: [] }))[0], 400);
	// a paste, a new version of it; removed
	[, r] = await N.code({ action: "add", paste: { text: "say(1);\n" }, name: "mine" });
	assert.deepEqual([r.added, r.kind], [true, "paste"]);
	[, r] = await N.code({ action: "add", paste: { text: "say(2);\n" }, name: "mine" });
	assert.equal(r.added, false);
	[code, r] = await N.code({ action: "remove", name: "mine" });
	assert.deepEqual([code, r], [200, { name: "mine", removed: true }]);
	assert.equal((await N.code({ action: "remove", name: "mine" }))[0], 404);
	assert.equal((await N.code({ action: "nope" }))[0], 400);
	assert.equal((await N.code({ action: "add", from: "./relative" }))[1].reason, "./relative: a link (https://...), or a full path on this machine (/..., ~/...)");
});
