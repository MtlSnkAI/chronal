"use strict";
// chronal pull against a fake token API: the pull folder (exports, bank, CODE slots, account age, game check,
// warnings), rate limits, snippet overrides, and a setup reading the pull (state.from, bank.from, code.dir).
//   node --test test/pull.test.js
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	http = require("node:http"),
	os = require("node:os"),
	path = require("node:path");
const P = require("../lib/pull");
const S = require("../lib/setup");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "pull-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const DAY = 86400e3,
	NOW = new Date("2026-09-27T10:00:00.000Z"),
	EXPIRES = NOW.getTime() + 33 * DAY; // created 7 days before NOW

function profile(name, cls, o = {}) {
	return {
		source: "last_account_snapshot", synchronized_at: "2026-09-27T09:00:00.000Z", name, class: cls, level: 50, xp: 10, server: null, online: false,
		map: "main", x: 1, y: 2, rip: false, hp: 100, mp: 50, gold: 1000, inventory_slots: 3, inventory_items: 1,
		equipment: { mainhand: { name: "bow", level: 7 }, trade1: null }, inventory: [{ name: "hpot1", q: 9 }, null, null], conditions: {}, quests: {}, ...o,
	};
}
const ACCOUNT = {
	characters: [
		{ character: "Zed", character_id: "CH_z", class: "priest", level: 50, profile: { online: true, server: "EUI" } },
		{ character: "Ran", character_id: "CH_r", class: "ranger", level: 50, profile: { online: false, server: null } },
	],
	profiles: {
		Zed: profile("Zed", "priest", { online: true, server: "EUI" }),
		Ran: profile("Ran", "ranger", { conditions: { encouragement_new: { expires: EXPIRES } } }),
	},
	bank: { success: true, retrieved_at: NOW.toISOString(), freshness: "possibly_stale", stale: true, gold: 777, shells: 40, packs: { items0: [{ name: "ringsj", level: 1, locked: true }, null], items1: [] } },
	codes: [
		{ slot: "1", name: "core", version: 3, code: "var core = 1;\n" },
		{ slot: "2", name: "core", version: 1, code: "// a second core\n" },
		{ slot: "3", name: "a/b", version: 1, code: "// no file name\n" },
		{ slot: "CH_r", name: "Ran", version: 9, code: "require_code('core');\n" },
	],
	// live's game data; the local design files (below) differ in a stat and in wording
	game: { items: { bow: { name: "Bow", attack: 20, explanation: "A bow. It shoots." }, coat: { name: "Coat", armor: 5, explanation: "Warm." } }, monsters: { goo: { hp: 10 } } },
};

// a fake mcp_api: POST /<method> { token, ... }; `limited` rate-limits the first call of each method once
function fakeApi(account, { limited = false } = {}) {
	const calls = [],
		seen = new Set();
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			const m = req.url.slice(1),
				b = JSON.parse(body);
			calls.push({ m, b });
			const send = (v) => res.end(JSON.stringify(v));
			if (b.token !== "tok") return send({ failed: true, reason: "invalid_token" });
			if (limited && !seen.has(m)) return seen.add(m), send({ failed: true, reason: "rate_limited", retry_after_ms: 5 });
			if (m === "mainframe_list_characters") return send({ success: true, characters: account.characters });
			if (m === "mainframe_get_character") return account.profiles[b.character] ? send({ success: true, profile: account.profiles[b.character] }) : send({ failed: true, reason: "character_not_found" });
			if (m === "get_bank") return send(account.bank);
			if (m === "list_codes") return send({ success: true, codes: account.codes.map(({ slot, name, version }) => ({ slot, name, version })) });
			if (m === "get_code") {
				const c = account.codes.find((x) => x.slot === b.slot);
				return send({ success: true, code: { slot: c.slot, name: c.name, version: c.version, code: c.code } });
			}
			if (m === "get_game_data") return b.section ? send({ success: true, version: 99, section: b.section, data: account.game[b.section] }) : send({ success: true, version: 99, sections: [...Object.keys(account.game), "images"] });
			send({ failed: true, reason: "unknown_method" });
		});
	});
	return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ api: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

// the sim's game: design files as main.js reads them (items differs from live in coat's armor and bow's wording)
function gameRoot() {
	const root = tmp();
	fs.mkdirSync(path.join(root, "design"));
	fs.writeFileSync(path.join(root, "design", "items.js"), 'var items={bow:{name:"Bow",attack:20,explanation:"A bow that shoots."},coat:{name:"Coat",armor:4,explanation:"Warm."}};\n');
	fs.writeFileSync(path.join(root, "design", "monsters.js"), "var monsters={goo:{hp:10}};\n");
	return root;
}

test("pull: a folder of exports, the bank, CODE slots, the account's age, the game check and warnings", async (t) => {
	const f = await fakeApi(ACCOUNT);
	t.after(f.close);
	const root = tmp(),
		{ dir, meta } = await P.pull({ root, api: f.api, token: "tok", game: gameRoot(), now: NOW });
	assert.equal(dir, path.join(root, "Ran", "2026-09-27T10-00-00Z")); // the account: the first character name in sort order
	assert.deepEqual(fs.readdirSync(dir).sort(), ["Ran.json", "Zed.json", "bank.json", "code", "game-diff.json", "pull.json"]);

	const ran = read(path.join(dir, "Ran.json"));
	assert.equal(ran.format, "chronal-export/1");
	assert.equal(ran.exported_at, NOW.toISOString()); // the pull's time; the character's last save in source
	assert.deepEqual(ran.source, { from: "api", synchronized_at: "2026-09-27T09:00:00.000Z", pulled_at: NOW.toISOString() });
	assert.deepEqual(ran.character, {
		name: "Ran", class: "ranger", level: 50, xp: 10, gold: 1000, hp: 100, mp: 50, rip: false, isize: 3, items: [{ name: "hpot1", q: 9 }, null, null],
		slots: { mainhand: { name: "bow", level: 7 }, trade1: null }, s: { encouragement_new: { expires: EXPIRES } }, q: {}, map: "main", in: "main", x: 1, y: 2,
	});
	// the bank: packs and gold, "locked" as the game's l, in every export and bank.json
	const bank = { gold: 777, items0: [{ name: "ringsj", level: 1, l: "l" }, null], items1: [] };
	assert.deepEqual(ran.bank, bank);
	assert.deepEqual(read(path.join(dir, "Zed.json")).bank, bank);
	assert.deepEqual(read(path.join(dir, "bank.json")), { bank, bank_source: { from: "api", at: NOW.toISOString(), freshness: "possibly_stale" } });
	assert.deepEqual(ran.account.characters.map((c) => [c.name, c.online]), [["Zed", true], ["Ran", false]]);
	assert.equal(ran.account.cash, 40); // the account's shells

	// CODE: by name; the second "core" and an unwritable name are listed, not written
	assert.deepEqual(fs.readdirSync(path.join(dir, "code")).sort(), ["Ran.js", "core.js", "slots.json"]);
	assert.equal(fs.readFileSync(path.join(dir, "code", "core.js"), "utf8"), "var core = 1;\n");
	assert.deepEqual(read(path.join(dir, "code", "slots.json")).map((s) => [s.slot, s.file, s.character]), [["1", "core.js", null], ["2", null, null], ["3", null, null], ["CH_r", "Ran.js", "Ran"]]);
	assert.deepEqual(meta.code, { dir: "code", slots: 4, characters: ["Ran"] });

	assert.deepEqual(meta.account_age, { days: 7, created: new Date(NOW.getTime() - 7 * DAY).toISOString(), from: `Ran: encouragement_new expires ${new Date(EXPIRES).toISOString()}` });
	assert.deepEqual(meta.bank, { from: "api", at: NOW.toISOString(), freshness: "possibly_stale", stale: true, gold: 777, packs: 2, items: 1 });
	// game: coat's armor differs, bow only in wording; images has no design file
	assert.deepEqual(meta.game.sections, { items: { entries: 2, differ: ["coat"], text: ["bow"] }, monsters: { entries: 1, differ: [], text: [] } });
	assert.equal(meta.game.version, 99);
	const diff = read(path.join(dir, "game-diff.json"));
	assert.deepEqual(diff.items.coat, { live: ACCOUNT.game.items.coat, local: { name: "Coat", armor: 4, explanation: "Warm." } });
	assert.equal(diff.items.bow.text_only, true);
	const w = meta.warnings.join("\n");
	assert.match(w, /the bank is open in game/);
	assert.match(w, /Zed is online \(EUI\)/);
	assert.match(w, /two named core; slot 2 not written/);
	assert.match(w, /slot 3: its name "a\/b" can't be a file name/);
	assert.match(w, /live's game data differs .*items 1 \(coat\)/);
	assert.doesNotMatch(w, /bow/);

	// a second pull in the same second: its own folder; no temporary folders left
	const again = await P.pull({ root, api: f.api, token: "tok", account: "main", code: false, now: NOW });
	assert.equal(again.dir, path.join(root, "main", "2026-09-27T10-00-00Z"));
	const third = await P.pull({ root, api: f.api, token: "tok", account: "main", code: false, now: NOW });
	assert.equal(third.dir, path.join(root, "main", "2026-09-27T10-00-00Z-2"));
	assert.equal(third.meta.code, null);
	assert.equal(third.meta.game, null);
	assert.ok(!fs.existsSync(path.join(third.dir, "code")));
	assert.deepEqual(fs.readdirSync(path.join(root, "main")).filter((d) => d.startsWith(".")), []);
	assert.deepEqual(P.listPulls(root).map((p) => [p.account, path.basename(p.dir)]), [["Ran", "2026-09-27T10-00-00Z"], ["main", "2026-09-27T10-00-00Z"], ["main", "2026-09-27T10-00-00Z-2"]]);
	assert.equal(P.latestPull(root, "Ran").dir, dir);
});

test("pull: waits out rate limits; a bad token fails; no New Player condition: no age", async (t) => {
	const acct = structuredClone(ACCOUNT);
	acct.profiles.Ran.conditions = {};
	acct.profiles.Zed.inventory = [{ name: "placeholder" }];
	const f = await fakeApi(acct, { limited: true });
	t.after(f.close);
	const { meta } = await P.pull({ root: tmp(), api: f.api, token: "tok", code: false, now: NOW });
	assert.ok(f.calls.filter((c) => c.m === "mainframe_list_characters").length === 2);
	assert.equal(meta.account_age.days, null);
	assert.match(meta.warnings.join("\n"), /Zed was mid-upgrade/);
	await assert.rejects(P.pull({ root: tmp(), api: f.api, token: "nope", now: NOW }), /mainframe_list_characters: invalid_token/);
});

test("addExports: a snippet export replaces a character (the API's copy kept); one taken in the bank becomes the pull's bank", async (t) => {
	const f = await fakeApi(ACCOUNT);
	t.after(f.close);
	const { dir } = await P.pull({ root: tmp(), api: f.api, token: "tok", code: false, now: NOW }),
		d = tmp();
	const snip = (name, o) => {
		const file = path.join(d, name + ".json");
		fs.writeFileSync(file, JSON.stringify({ format: "chronal-export/1", exported_at: "2026-09-27T09:30:00.000Z", character: { name, class: "ranger", level: 51, items: [], slots: {} }, ...o }));
		return file;
	};
	const later = new Date("2026-09-27T11:00:00.000Z");
	// no bank inside: the pull's bank stays, in the export too
	let r = P.addExports(dir, [snip("Ran", { bank: { gold: 1, items0: [] }, bank_source: { from: "al_bank", at: "2026-09-20T00:00:00.000Z" } })], { now: later });
	assert.deepEqual(r.warnings, []);
	assert.equal(read(path.join(dir, "Ran.api.json")).source.from, "api");
	const ran = read(path.join(dir, "Ran.json"));
	assert.equal(ran.character.level, 51);
	assert.equal(ran.source.from, "snippet");
	assert.equal(ran.bank.gold, 777);
	assert.deepEqual(r.meta.characters.find((c) => c.name === "Ran"), { name: "Ran", class: "ranger", level: 51, online: false, server: null, synchronized_at: "2026-09-27T09:00:00.000Z", file: "Ran.json", source: "snippet", exported_at: "2026-09-27T09:30:00.000Z" });
	assert.equal(r.meta.overrides.length, 1);

	// taken inside the bank (and older than the pulled state): its bank in every file; the stale-bank warning goes
	const inBank = { gold: 5, items0: [{ name: "wbook0" }] };
	r = P.addExports(dir, [snip("Zed", { exported_at: "2026-09-27T08:00:00.000Z", bank: inBank, bank_source: { from: "character", at: "2026-09-27T08:00:00.000Z" } })], { now: later });
	assert.match(r.warnings[0], /Zed: the snippet export \(2026-09-27T08:00:00.000Z\) is older than the pulled state/);
	for (const n of ["Ran", "Zed"]) assert.deepEqual(read(path.join(dir, n + ".json")).bank, inBank);
	assert.deepEqual(read(path.join(dir, "bank.json")).bank_source, { from: "character", at: "2026-09-27T08:00:00.000Z", via: "Zed" });
	assert.deepEqual(r.meta.bank, { from: "snippet", character: "Zed", at: "2026-09-27T08:00:00.000Z", freshness: "exact", stale: false, gold: 5, packs: 1, items: 1 });
	assert.doesNotMatch(r.meta.warnings.join("\n"), /the bank is open/);
	// again for Ran: the first API copy stays, one override per character
	r = P.addExports(dir, [snip("Ran", {})], { now: later });
	assert.equal(read(path.join(dir, "Ran.api.json")).source.from, "api");
	assert.deepEqual(r.meta.overrides.map((o) => o.name).sort(), ["Ran", "Zed"]);

	assert.throws(() => P.addExports(dir, [snip("Other", {})]), /Other is not a character of this pull/);
	fs.writeFileSync(path.join(d, "bad.json"), "{}");
	assert.throws(() => P.addExports(dir, [path.join(d, "bad.json")]), /not an export/);
});

test("a setup runs from a pull: state.from, bank.from and code.dir (the character's own slot as its entry)", async (t) => {
	const f = await fakeApi(ACCOUNT);
	t.after(f.close);
	const { dir } = await P.pull({ root: tmp(), api: f.api, token: "tok", now: NOW }),
		G = { classes: { ranger: { base_slots: { mainhand: { name: "bow", level: 0, gift: 1 } } } }, maps: { main: { spawns: [[5, 6, 0, 100]] } } };
	const file = path.join(tmp(), "setup.json");
	fs.writeFileSync(file, JSON.stringify({
		format: "chronal-setup/1",
		defaults: { account: "acc", code: { dir: path.join(dir, "code") } },
		accounts: { acc: { age_days: 7, bank: { from: path.join(dir, "Ran.json") } } },
		characters: [{ name: "Ran", class: "ranger", state: { from: path.join(dir, "Ran.json") } }],
	}));
	const { resolved } = S.resolveSetup(S.loadSetup(file, { G }), { build: false, G });
	const c = resolved.characters[0];
	assert.equal(c.state.level, 50);
	assert.deepEqual([c.state.slots.mainhand.name, c.state.slots.mainhand.level], ["bow", 7]);
	assert.deepEqual(resolved.accounts.acc.bank, { gold: 777, items0: [{ name: "ringsj", level: 1, l: "l" }, null], items1: [] });
	assert.equal(resolved.accounts.acc.cash, 40); // (the bank's export's account)
	assert.equal(c.code.entry, "Ran");
});

test("textOnly: prose and text keys are wording; types, numbers and shapes are not", () => {
	assert.equal(P.textOnly({ explanation: "a" }, { explanation: "b" }), true);
	assert.equal(P.textOnly({ t: "Walk away." }, { t: "Leave now." }), true);
	assert.equal(P.textOnly({ t: "physical" }, { t: "magical" }), false);
	assert.equal(P.textOnly({ armor: 5, explanation: "x" }, { armor: 4, explanation: "y" }), false);
	assert.equal(P.textOnly({ says: ["Hi there"] }, { says: ["Hello there", "More"] }), false);
	assert.equal(P.textOnly({ says: ["Hi"] }, { says: ["Hello"] }), true);
});

test("another player's public page: parsePublic reads each character; publicPull takes the account (by any of its characters) into a folder of its own, leaving out what the sim's game lacks; topCharacters; no such player", async (t) => {
	const { fakeSite, sitePage } = require("./fixtures/public_site");
	const KESTREL = [
		{ name: "Zed", cls: "Priest", level: 80, online: true, skin: "marmor7b", cx: { hat: "hat317" }, slots: { mainhand: { name: "bow", level: 7 }, chest: { name: "coat", level: 5, stat_type: "dex", p: null }, ring1: { name: "newring", level: 1 }, elixir: { name: "coat" } } },
		{ name: "ZedBank", cls: "Merchant", level: 1, skin: "newskin9", cx: { hat: "hat317" }, slots: {} },
		{ name: "Pirate1", cls: "Pirate", level: 3, slots: {} },
	];
	// parsing: the site's markup, a page without characters
	const page = P.parsePublic(sitePage("Kestrel", KESTREL));
	assert.equal(page.title, "Kestrel");
	assert.deepEqual(page.characters[0], { name: "Zed", class: "priest", level: 80, online: true, slots: KESTREL[0].slots, skin: "marmor7b", cx: { hat: "hat317" } });
	assert.deepEqual(page.characters.map((c) => [c.name, c.class, c.online]), [["Zed", "priest", true], ["ZedBank", "merchant", false], ["Pirate1", "pirate", false]]);
	assert.deepEqual(P.parsePublic("<title>Adventure Land</title>Not Found").characters, []);

	const f = await fakeSite({ Kestrel: KESTREL, Other: [{ name: "Top1", cls: "Ranger", level: 99, online: true, slots: {} }] });
	t.after(f.close);
	const root = tmp(),
		game = tmp();
	fs.mkdirSync(path.join(game, "design"));
	fs.writeFileSync(path.join(game, "design", "items.js"), "var items={bow:{},coat:{}};\n");
	fs.writeFileSync(path.join(game, "design", "classes.js"), "var classes={priest:{},merchant:{}};\n");
	fs.writeFileSync(path.join(game, "design", "sprites.js"), 'var sprites={a:{matrix:[["marmor7b","marmor12a"]]},b:{matrix:[["hat317"]]}};\n');
	const { dir, meta } = await P.publicPull({ root, name: "zedbank", site: f.site, game, now: NOW });
	assert.equal(dir, path.join(root, "Kestrel", "2026-09-27T10-00-00Z"));
	assert.deepEqual(f.hits, ["/player/zedbank"]);
	assert.deepEqual({ ...meta, characters: meta.characters.map((c) => c.name) }, {
		format: "chronal-pull/1", source: "public", url: f.site + "/player/zedbank", pulled_at: NOW.toISOString(), account: "Kestrel", characters: ["Zed", "ZedBank"],
		bank: null, account_age: { days: null, created: null, from: "a public page doesn't show it" }, code: null, game: null, overrides: [],
		warnings: ["Pirate1: a pirate, a class the sim's game (" + game + ") lacks: left out", "ZedBank: its skin newskin9, one the sim's game lacks: the class's default look", "Zed: ring1 newring, an item the sim's game lacks (newer on live): left out"],
	});
	const zed = read(path.join(dir, "Zed.json"));
	assert.deepEqual(zed.character, { name: "Zed", class: "priest", level: 80, xp: 0, gold: 0, items: [], slots: { mainhand: { name: "bow", level: 7 }, chest: { name: "coat", level: 5, stat_type: "dex" }, elixir: { name: "coat" } }, s: {}, q: {}, skin: "marmor7b", cx: { hat: "hat317" } });
	assert.deepEqual([zed.format, zed.source.from, zed.bank, zed.account.characters.map((c) => c.name)], ["chronal-export/1", "public", null, ["Zed", "ZedBank"]]);
	assert.deepEqual([read(path.join(dir, "ZedBank.json")).character.skin, read(path.join(dir, "ZedBank.json")).character.cx], [null, null]);
	assert.deepEqual(fs.readdirSync(dir).sort(), ["Zed.json", "ZedBank.json", "pull.json"]);
	// the players' folders list as pulls do
	assert.deepEqual(P.listPulls(root).map((p) => [p.account, p.meta.source]), [["Kestrel", "public"]]);
	// a setup plays it: its gear, level and looks; no items
	const st = S.resolveSetup(S.loadSetup({ format: "chronal-setup/1", name: "p", characters: [{ name: "Zed", class: "priest", account: "Kestrel", code: { file: path.join(__dirname, "..", "codes", "idle.js") }, state: { from: path.join(dir, "Zed.json") } }] }), { build: false }).resolved.characters[0].state;
	assert.deepEqual([st.level, st.slots.mainhand, st.items, st.skin, st.cx], [80, { name: "bow", level: 7 }, [], "marmor7b", { hat: "hat317" }]);
	assert.deepEqual(S.characterOver({ state: st, at: { map: "main", x: 0, y: 0 } }).info.cx, { hat: "hat317" });
	// the top; no such player; not a name
	assert.deepEqual(await P.topCharacters({ site: f.site }), [{ name: "Top1", class: "ranger", level: 99, online: true }, { name: "Zed", class: "priest", level: 80, online: true }, { name: "Pirate1", class: "pirate", level: 3, online: false }, { name: "ZedBank", class: "merchant", level: 1, online: false }]);
	await assert.rejects(P.publicPull({ root, name: "Nobody", site: f.site }), /no character Nobody on http:\/\/127\.0\.0\.1:\d+ \(its page .*\/player\/Nobody shows none\)/);
	await assert.rejects(P.publicPull({ root, name: "a/b", site: f.site }), /a character's name/);
});
