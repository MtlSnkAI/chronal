"use strict";
// A run's state as chronal-export/1 files: one per character with its account's bank, what a setup's state.from /
// bank.from continues from exactly (the server's raw items and gear, trade slots included; its p and conditions; the
// whole bank with its rooms and rewards; the account's cash, link, age and its pages' storage). Only reads: the
// server's players, the DB's documents, the pages' localStorage (a query, as steering's get()); no clock event, no game
// call, so an export never changes a run.
//   endState(sim, resolved, { label, run, seed, setupKey }) -> { label, at, files: { <Name>: export }, index }
//   writeState(dir, state): <dir>/<label>/<Name>.json + index.json
const fs = require("node:fs"),
	path = require("node:path");

const FORMAT = "chronal-export/1";
// the server's p a setup's state.p takes (lib/setup.js KEYS.p); the rest is the server's own bookkeeping
const P_KEYS = ["ugrace", "cgrace", "ograce", "stats", "achievements", "ap", "firstbuff", "encouragement_reached80", "first", "first_drop", "dt", "rewards", "minutes", "stand"];
// conditions the server makes at each login (encouragement) or that only a live session has
const S_SKIP = /^(encouragement_|notverified$|authfail$)/;

const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))); // (the server's realm -> ours; Dates -> ISO)

async function endState(sim, resolved, { label = "end", run = null, seed = null, setupKey = null } = {}) {
	const S = sim.server,
		db = sim.env.db,
		doc = (id) => db.collection(sim.env.kindOf(id)).store.get(id),
		nowMs = sim.clock.nowMs(),
		at = new Date(nowMs).toISOString(),
		players = Object.values(S.players || {}),
		inGame = (name) => players.find((p) => p.name === name) || null,
		page = (name) => (sim.clients || []).findLast((c) => c.name === name && c.online !== false) || null;
	const files = {},
		accounts = {};
	for (const [k, ra] of Object.entries(resolved.accounts)) {
		const acc = sim.accounts && sim.accounts.get(k);
		if (!acc) continue;
		const user = doc(acc.user_id),
			names = resolved.characters.filter((c) => c.account === k).map((c) => c.name),
			mounted = names.map(inGame).find((p) => p && p.user) || null,
			info = mounted ? mounted.user : user.info,
			bank = Object.fromEntries(Object.entries(plain(info)).filter(([x]) => /^(gold|items\d+|unlocked|rewards)$/.test(x)));
		// its pages' storage: the first page in game's (each page has its own in threads mode; at the start they had
		// the account's), else what the account's pages were given
		let storage = null;
		for (const n of names) {
			const c = page(n);
			if (!c) continue;
			try {
				storage = await c.query("JSON.stringify(Object.assign({}, localStorage))");
				break;
			} catch (e) {}
		}
		storage = storage ? JSON.parse(storage) : { ...((sim.storage && sim.storage[k]) || {}) };
		const created = user.created ? new Date(user.created).getTime() : nowMs,
			L = ra.linked || null;
		accounts[k] = {
			bank, bank_source: { from: "sim", at, mounted: mounted ? mounted.name : null },
			account: {
				key: k, cash: user.cash || 0, linked: L, created: new Date(created).toISOString(), age_days: +((nowMs - created) / 86400e3).toFixed(6),
				newcomer_claimed: !!(L && doc("MK_auth-" + L.pid)), local_storage: storage,
				characters: user.info.characters.map((e) => ({ name: e.name, type: e.type, level: (doc(e.id) || {}).level || e.level })),
			},
		};
	}
	for (const rc of resolved.characters) {
		const a = accounts[rc.account];
		if (!a) continue;
		const p = inGame(rc.name),
			acc = sim.accounts.get(rc.account),
			e = doc(acc.user_id).info.characters.find((x) => x.name === rc.name),
			d = e && doc(e.id),
			src = p || (d && { ...d.info, level: d.level, xp: d.xp }) || {},
			warnings = [];
		const q = plain(src.q || {});
		for (const k of Object.keys(q)) if (q[k]) warnings.push(`its ${k} queue (${k === "upgrade" || k === "compound" ? "an item in it" : "in progress"}) is lost`);
		const sp = plain((p ? p.p : d && d.info.p) || {}),
			ss = plain(src.s || {});
		files[rc.name] = {
			format: FORMAT,
			exported_at: at,
			source: { from: "sim", run, label, seed, setup_key: setupKey, in_game: !!p },
			character: {
				name: rc.name, class: rc.class, level: src.level, xp: src.xp, gold: src.gold, hp: src.hp, mp: src.mp, rip: !!src.rip,
				items: plain(src.items || []), slots: plain(src.slots || {}), ...(src.skin ? { skin: src.skin, cx: plain(src.cx || {}) } : {}),
				map: src.map, in: src.in, x: Math.round(src.x ?? 0), y: Math.round(src.y ?? 0),
			},
			server: { p: Object.fromEntries(P_KEYS.filter((k) => sp[k] !== undefined).map((k) => [k, sp[k]])), s: Object.fromEntries(Object.entries(ss).filter(([k]) => !S_SKIP.test(k))) },
			bank: a.bank,
			bank_source: a.bank_source,
			account: a.account,
			...(warnings.length ? { warnings } : {}),
		};
	}
	const index = {
		format: "chronal-state/1", label, at, run, seed,
		characters: resolved.characters.filter((c) => files[c.name]).map((c) => ({ name: c.name, class: c.class, account: c.account })),
		accounts: Object.fromEntries(Object.entries(accounts).map(([k, a]) => [k, { bank_from: resolved.characters.find((c) => c.account === k && files[c.name]).name + ".json", age_days: a.account.age_days, cash: a.account.cash, linked: a.account.linked, newcomer_claimed: a.account.newcomer_claimed }])),
	};
	return { label, at, files, index };
}

/** <dir>/<label>/<Name>.json for each character and index.json (each file whole: tmp + rename) -> the label's dir */
function writeState(dir, state) {
	const out = path.join(dir, state.label);
	fs.mkdirSync(out, { recursive: true });
	const put = (f, v) => {
		const tmp = f + "." + process.pid + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
		fs.renameSync(tmp, f);
	};
	for (const [n, x] of Object.entries(state.files)) put(path.join(out, n + ".json"), x);
	put(path.join(out, "index.json"), state.index);
	return out;
}

// a label for a directory: letters, digits, _ . - (an export on request is named by its game time otherwise)
const labelOf = (s, fallback) => (String(s || "").replace(/[^\w.-]+/g, "_").slice(0, 60) || fallback);

module.exports = { endState, writeState, labelOf, FORMAT };
