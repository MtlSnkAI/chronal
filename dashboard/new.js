"use strict";
// The New run form's server side (dashboard/server.js mounts it under api/new): what this checkout has to compose from
// (its pulls, CODE sets, templates in setups_dir, the item catalog), a pull of the live account, snippet exports into a
// pull, other players' public pages (taken into players_dir; the site's top characters to find them), the CODE library
// (library.js: CODE added from a link, a paste, an upload or a folder; updated, removed; a set's revisions; what a
// version reaches; trusted), and the composer (compose.js) behind the form: a preview of what its options make (each
// character's start state, CODE, entry slots; the names of characters in its CODE and who they are in the run; the
// storage keys its CODE reads and each account's storage; its steering; the characters whose CODE has no entry for
// them; others' CODE at a version not trusted yet, with what it reaches), a check (resolved and built), a save
// (setups_dir), and starts: chronal run per variant and seed.
const fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto");
const { config } = require("../lib/config");
const { FORMAT } = require("../lib/setup");

// The composer's problems name chronal new's options (--chars Ran1: ...); the form says them with its own labels
const LABELS = {
	chars: "Who is logged in", char: "New character", offline: "Offline", state: "State", level: "Level", at: "At", gold: "Gold", items: "Inventory",
	gear: "Equipment", "sweep-gear": "Compare items", "sweep-code-set": "CODE (compare)", "code-set": "CODE", missing: "CODE", entries: "Entry", code_sets: "CODE",
	"code-name": "Names", prelude: "Prelude", party: "Party", account: "Account", "account-of": "Account", "account-age": "Account age", "account-bank": "Bank",
	storage: "Storage", "local-storage": "Storage", steer: "Steering", until: "Until", "check-every": "Check every", template: "Start from (template)",
	pull: "Start from (pull)", player: "Add player", duration: "Duration", warmup: "Warm-up", seed: "Seeds", ping: "Ping", "world-age": "World age", "age-days": "Account age",
};
function formText(p) {
	if (/^--chars: who is logged in/.test(p)) return "Who is logged in: add a character (New character), pick a template, or pull your account (Pull now)";
	return String(p).replace(/^--([a-z_-]+)( ?)/, (m, k, sp) => (LABELS[k] ? LABELS[k] + (sp ? ": " : "") : m)).replace(/ \(chronal pull[^)]*\)/, " (Pull now)");
}
const formTexts = (ps) => (ps || []).map(formText);

// x: the dashboard's own { dir, cli, root, worlds, threads, startSim, stamp, addLaunch (into its registry, saved) }
function newRuns(x) {
	const cfg = () => config();
	let pulling = null,
		catalog = null,
		topList = null; // the site's top characters: { at, characters } (an hour)
	const taking = new Set(); // players' pages being taken (by name, lower case)
	let adding = null; // CODE being added to the library

	// the setups in setups_dir a new run may start from: setup files (not a run's side file), at its top level
	function templates(dir) {
		let files = [];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		} catch (e) {}
		const out = [];
		for (const f of files) {
			let s;
			try {
				s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			} catch (e) {
				continue;
			}
			if (!s || s.format !== FORMAT || "resolved" in s || !Array.isArray(s.characters)) continue;
			const acct = s.defaults && s.defaults.account;
			out.push({
				file: path.join(dir, f), name: s.name || f.replace(/\.json$/, ""), notes: s.notes || null,
				characters: s.characters.filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name, class: c.class, account: c.account || acct || "main", exported: !!(c.state && (c.state.from || (s.defaults && s.defaults.state && s.defaults.state.from))), level: (c.state && c.state.level) || null, online: c.online !== false })),
				party: s.party || null,
			});
		}
		return out;
	}

	/** GET api/new: pulls and players' pages taken (newest first), CODE sets, templates, classes, whether a pull can run */
	function info() {
		const c = cfg(),
			P = require("../lib/pull"),
			C = require("../lib/code_sets"),
			G = require("../lib/compose").game(c.al_root);
		const pulls = P.listPulls(c.pulls_dir)
			.sort((a, b) => (a.meta.pulled_at < b.meta.pulled_at ? 1 : -1))
			.map((p) => ({
				id: p.account + "/" + path.basename(p.dir), account: p.account, pulled_at: p.meta.pulled_at,
				characters: p.meta.characters.map((ch) => ({ name: ch.name, class: ch.class, level: ch.level, online: !!ch.online, source: ch.source, synchronized_at: ch.synchronized_at || null })),
				bank: p.meta.bank, account_age: p.meta.account_age, warnings: p.meta.warnings || [], overrides: (p.meta.overrides || []).map((o) => o.name),
				code: p.meta.code ? p.meta.code.characters : null,
				game: p.meta.game ? { differ: Object.values(p.meta.game.sections).reduce((n, s) => n + s.differ.length, 0), text: Object.values(p.meta.game.sections).reduce((n, s) => n + (s.text || []).length, 0) } : null,
			}));
		const players = P.listPulls(c.players_dir)
			.sort((a, b) => (a.meta.pulled_at < b.meta.pulled_at ? 1 : -1))
			.map((p) => ({ id: p.account + "/" + path.basename(p.dir), account: p.account, pulled_at: p.meta.pulled_at, url: p.meta.url || null, warnings: p.meta.warnings || [], characters: p.meta.characters.map((ch) => ({ name: ch.name, class: ch.class, level: ch.level, online: !!ch.online })) }));
		const cs = C.loadCodeSets();
		// (group: the picker's; files: the slots it holds now, a file set's 1, null: not built yet)
		const sets = cs.sets.map((s) => {
			let files = null;
			try {
				const n = s.code.file ? null : C.slotNames(s);
				files = s.code.file ? 1 : n ? n.length : null;
			} catch (e) {}
			return {
				name: s.name, kind: s.kind, note: s.note, where: s.pull ? `${s.pull.account}/${path.basename(s.pull.dir)}` : s.code.file || s.code.dir, git: s.git || null, build: !!s.code.build,
				append: (s.code.append || []).map((p) => path.basename(p)), entries: s.entries, own: s.pull ? s.pull.characters : null,
				group: s.builtin ? "builtin" : s.lib ? "others" : s.name.startsWith("pull:") ? "pulls" : "yours", lib: s.lib || null, files, at: s.lib ? s.lib.fetched_at || s.lib.added_at : s.pull ? s.pull.pulled_at : null,
			};
		});
		const token = !!(process.env.CHRONAL_AL_TOKEN || (c.al_token_file && fs.existsSync(c.al_token_file)));
		return [200, {
			ok: true, pulls, players, accounts: require("../lib/accounts").list(c.accounts_dir), gear_sets: require("../lib/gear_sets").list(c.gear_sets_dir), code_sets: sets, code_set_problems: cs.problems, templates: templates(c.setups_dir), setups_dir: c.setups_dir, pulls_dir: c.pulls_dir,
			classes: Object.fromEntries(Object.entries(G.classes).map(([k, v]) => [k, { main_stat: v.main_stat || null }])),
			token, pulling: !!pulling,
			// the server's clock-driven events (lib/schedule.js): the New sim form's Starts and Events
			schedule: (({ SCHEDULE, DAILIES, NIGHTLIES, SEASONS, DEFAULT_START }) => ({ ...SCHEDULE, dailies_events: DAILIES, nightlies_events: NIGHTLIES, seasons: SEASONS, default_start: DEFAULT_START }))(require("../lib/schedule")),
		}];
	}

	/** PUT api/accounts/<name> { account, was? }: a crafted account written (lib/accounts.js; was: its name before a
	 *  rename, removed); DELETE: removed */
	function accountPut(name, b) {
		const A = require("../lib/accounts"),
			a = b && b.account;
		if (!a || a.name !== name) return [400, { reason: "account: { name: " + JSON.stringify(name) + ", ... }" }];
		const dir = cfg().accounts_dir;
		if (b.was != null && b.was !== name && A.list(dir).some((x) => x.name === name)) return [409, { reason: `an account ${name} exists already` }];
		try {
			const saved = A.save(dir, a, require("../lib/compose").game(cfg().al_root));
			if (b.was != null && b.was !== name) A.remove(dir, b.was);
			return [200, { account: saved }];
		} catch (e) {
			return [400, { reason: e.message, problems: e.problems || [e.message] }];
		}
	}
	function accountDel(name) {
		return require("../lib/accounts").remove(cfg().accounts_dir, name) ? [200, { removed: name }] : [404, { reason: `no account ${name}` }];
	}
	/** GET api/gearsets: every gear set (lib/gear_sets.js), the classes; PUT api/gearsets/<name> { set, was? }: a gear
	 *  set of yours written (one of that name replaced; was: its name before a rename, removed), DELETE: removed */
	function gearSets() {
		return [200, { sets: require("../lib/gear_sets").list(cfg().gear_sets_dir), classes: Object.keys(require("../lib/compose").game(cfg().al_root).classes) }];
	}
	function gearSetPut(name, b) {
		const GS = require("../lib/gear_sets"),
			s = b && b.set,
			dir = cfg().gear_sets_dir;
		if (!s || s.name !== name) return [400, { reason: "set: { name: " + JSON.stringify(name) + ", class, gear }" }];
		if (b.was != null && b.was !== name && GS.get(dir, name)) return [409, { reason: `a gear set ${name} exists already` }];
		try {
			const saved = GS.save(dir, s, require("../lib/compose").game(cfg().al_root));
			if (b.was != null && b.was !== name) GS.remove(dir, b.was);
			return [200, { set: saved }];
		} catch (e) {
			return [400, { reason: e.message, problems: e.problems || [e.message] }];
		}
	}
	function gearSetDel(name) {
		return require("../lib/gear_sets").remove(cfg().gear_sets_dir, name) ? [200, { removed: name }] : [404, { reason: `no gear set ${name} of yours` }];
	}
	/** DELETE api/pulls/<account>[?older=1]: your account's pulls removed (older: all but the newest), its CODE with
	 *  them; DELETE api/players/<account>: another player's pages taken removed */
	function pullsDel(root, account, older) {
		const ps = require("../lib/pull").listPulls(root, account).sort((a, b) => (a.meta.pulled_at < b.meta.pulled_at ? 1 : -1));
		if (!ps.length) return [404, { reason: `no ${account} in ${root}` }];
		const gone = older ? ps.slice(1) : ps;
		for (const p of gone) fs.rmSync(p.dir, { recursive: true, force: true });
		if (!older) fs.rmSync(path.join(root, account), { recursive: true, force: true });
		return [200, { account, removed: gone.length }];
	}
	const pullDel = (account, older) => pullsDel(cfg().pulls_dir, account, older),
		playerDel = (account) => pullsDel(cfg().players_dir, account, false);

	/** GET api/new/items: the game's items for the pickers: { items: { key: [name, type, wtype, max level, takes a stat scroll, classes, stack size] }, stats, titles, monsters, conditions } */
	function items() {
		if (!catalog) {
			const G = require("../lib/compose").game(cfg().al_root),
				it = G.items;
			catalog = {
				items: Object.fromEntries(Object.entries(it).map(([k, d]) => [k, [d.name || k, d.type || "", d.wtype || "", d.upgrade || d.compound ? (d.grades || [9, 10, 11, 12])[3] : 0, d.stat ? 1 : 0, Array.isArray(d.class) ? d.class : 0, d.s || 0]])),
				stats: Object.keys(it).filter((k) => /scroll$/.test(k) && it[k].type === "pscroll").map((k) => k.slice(0, -6)),
				titles: Object.keys(G.titles || {}),
				// (for the steering conditions' picker)
				monsters: Object.keys(G.monsters || {}), conditions: Object.keys(G.conditions || {}),
			};
		}
		return [200, catalog];
	}

	/** GET api/new/fits?class=&slot=&mainhand=&offhand=: the items that class can wear there, as the game decides, in order */
	function fits(q) {
		const K = require("../lib/compose"),
			G = K.game(cfg().al_root),
			cls = q.get("class"),
			slot = q.get("slot");
		if (!G.classes[cls]) return [400, { reason: `class: one of ${Object.keys(G.classes).join(", ")}` }];
		if (!K.SLOTS.includes(slot)) return [400, { reason: `slot: one of ${K.SLOTS.join(", ")}` }];
		const others = { mainhand: q.get("mainhand") ? { name: q.get("mainhand") } : null, offhand: q.get("offhand") ? { name: q.get("offhand") } : null };
		const out = [];
		for (const k of Object.keys(G.items)) {
			const slots = { ...others, [slot]: { name: k } },
				r = K.checkGear(G, cls, slot, { name: k }, slots);
			if (!r.problems.length) out.push(r.warnings.length ? [k, 1] : [k, 0]); // 1: of another class (no stats)
		}
		// the class's own first, then by tier (none: after the tiers) and value, as a player scans them
		const tier = (k) => G.items[k].tier ?? Infinity;
		out.sort((a, b) => a[1] - b[1] || tier(a[0]) - tier(b[0]) || (G.items[a[0]].g || 0) - (G.items[b[0]].g || 0) || a[0].localeCompare(b[0]));
		return [200, { class: cls, slot, items: out }];
	}

	/** POST api/new/pull: the live account now (chronal pull, read-only), with the game check */
	async function pull() {
		if (pulling) return [409, { reason: "a pull is under way" }];
		const c = cfg(),
			P = require("../lib/pull");
		let token;
		try {
			token = P.token();
		} catch (e) {
			return [400, { reason: e.message }];
		}
		pulling = P.pull({ root: c.pulls_dir, api: process.env.CHRONAL_AL_API || "https://adventure.land/mcp_api", token, game: c.al_root });
		try {
			const { dir, meta } = await pulling;
			return [200, { id: meta.account + "/" + path.basename(dir), warnings: meta.warnings }];
		} catch (e) {
			return [502, { reason: "pull: " + e.message }];
		} finally {
			pulling = null;
		}
	}

	/** POST api/new/player { name }: that player's public page (the account of that character) into players_dir */
	async function player(b) {
		const name = b && typeof b.name === "string" ? b.name.trim() : "";
		if (!/^[A-Za-z0-9]{1,12}$/.test(name)) return [400, { reason: "name: a character's name (1-12 letters and digits)" }];
		if (taking.has(name.toLowerCase())) return [409, { reason: `${name}: its page is being taken` }];
		taking.add(name.toLowerCase());
		const c = cfg();
		try {
			const { dir, meta } = await require("../lib/pull").publicPull({ root: c.players_dir, name, game: c.al_root });
			return [200, { id: meta.account + "/" + path.basename(dir), account: meta.account, name: (meta.characters.find((ch) => ch.name.toLowerCase() === name.toLowerCase()) || {}).name || null, warnings: meta.warnings }];
		} catch (e) {
			return [/^no character /.test(e.message) ? 404 : 502, { reason: e.message }];
		} finally {
			taking.delete(name.toLowerCase());
		}
	}

	/** GET api/new/top: the site's top characters, to find a player by ({ characters: [{ name, class, level, online }] }; an hour's copy) */
	async function top() {
		if (!topList || Date.now() - topList.at > 3600e3)
			try {
				topList = { at: Date.now(), characters: await require("../lib/pull").topCharacters() };
			} catch (e) {
				return [502, { reason: "the top characters: " + e.message }];
			}
		return [200, { at: new Date(topList.at).toISOString(), characters: topList.characters }];
	}

	/** POST api/new/export { pull: id, export }: a snippet export (snippets/export-state.js) over that pull's character */
	function addExport(b) {
		const c = cfg(),
			P = require("../lib/pull"),
			p = P.listPulls(c.pulls_dir).find((q) => q.account + "/" + path.basename(q.dir) === b.pull);
		if (!p) return [404, { reason: `no pull ${b.pull}` }];
		// (its text as the snippet left it, pasted or a file: JSON, or compressed)
		let e = b.export;
		if (typeof b.text === "string")
			try {
				e = P.exportFromText(b.text);
			} catch (err) {
				return [400, { reason: err.message }];
			}
		if (!e || typeof e !== "object" || e.format !== "chronal-export/1" || !e.character || !/^[A-Za-z0-9]{1,12}$/.test(String(e.character.name))) return [400, { reason: "export: a file of snippets/export-state.js (chronal-export/1)" }];
		const file = path.join(p.dir, "uploads", `${e.character.name}-${x.stamp()}.json`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(e, null, 1));
		try {
			const r = P.addExports(p.dir, [file]);
			return [200, { pull: b.pull, name: e.character.name, warnings: r.warnings }];
		} catch (err) {
			fs.rmSync(file, { force: true });
			return [400, { reason: err.message }];
		}
	}

	/** GET api/new/snippet: snippets/export-state.js, to copy into a character's CODE on live */
	function snippet() {
		return [200, { text: fs.readFileSync(path.join(__dirname, "..", "snippets", "export-state.js"), "utf8") }];
	}

	/**
	 * POST api/new/code { action, ... }: the CODE library (library.js). "add": { from: a link or a path | paste: { text,
	 * file } | files: [{ path, text }], name } (a paste or upload under the name of one: a new version of it); "update",
	 * "remove": { name }; "trust": { name, commit } (a commit of its repo)
	 */
	async function code(b) {
		const L = require("../lib/library"),
			act = b && b.action;
		try {
			if (act === "add") {
				if (adding) return [409, { reason: "CODE is being added: one at a time" }];
				const taken = require("../lib/code_sets").loadCodeSets().sets.filter((s) => !s.lib).map((s) => s.name);
				adding = L.add({ from: b.from ?? null, paste: b.paste ?? null, files: b.files ?? null, name: b.name || null, taken });
				try {
					const r = await adding;
					return [200, { name: r.entry.name, added: r.added, commit: r.commit, kind: r.entry.meta.kind }];
				} finally {
					adding = null;
				}
			}
			if (act === "update") {
				const r = await L.update(String(b.name));
				return [200, { name: r.entry.name, was: r.was, commit: r.commit, moved: r.moved, count: r.count, why: r.why || null }];
			}
			if (act === "remove") return [200, { name: L.remove(String(b.name)).name, removed: true }];
			if (act === "trust") {
				const e = L.get(String(b.name)),
					commit = /^[0-9a-f]{40}$/.test(String(b.commit)) ? L.revOf(e.name, b.commit) : null;
				if (!commit || commit !== b.commit) return [400, { reason: `trust: ${b.commit} is not a commit of ${e.name}` }];
				L.trust(commit, { name: e.name, source: e.meta.web || e.meta.url || null, by: "dashboard" });
				return [200, { name: e.name, commit, trusted: true }];
			}
			// its fit chosen (library.js setFit): calls { <key>: <slot> | null | "auto" }, with { <entry slot>: [<slot>] | "auto" }
			if (act === "fit") {
				const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v),
					auto = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v === "auto" ? undefined : v]));
				if ((b.calls != null && !isObj(b.calls)) || (b.with != null && !isObj(b.with))) return [400, { reason: "fit: calls { <key>: <slot> | null | \"auto\" }, with { <entry slot>: [<slot>, ...] | \"auto\" }" }];
				const e = L.setFit(String(b.name), { calls: auto(b.calls), with: auto(b.with) });
				return [200, { name: e.name, fit: e.meta.fit || null }];
			}
			return [400, { reason: 'action: "add", "update", "remove", "trust" or "fit"' }];
		} catch (e) {
			return [/^no CODE |not a name in the library/.test(e.message) ? 404 : 400, { reason: e.message }];
		}
	}

	/** GET api/new/code?set=NAME[&rev=R]: a CODE set's revisions to pick from (a git repo's: its branches, tags, newest
	 * commits; none: not in one); of the library's, what that version (default its pinned one) reaches (scan) */
	function codeInfo(q) {
		const L = require("../lib/library"),
			GIT = require("../lib/git_tree"),
			name = q.get("set") || "",
			rev = q.get("rev") || null;
		let set;
		try {
			set = require("../lib/code_sets").codeSet(name);
		} catch (e) {
			return [404, { reason: e.message }];
		}
		const none = { branches: [], tags: [], commits: [] };
		if (set.lib && set.lib.kind !== "path") {
			let scan = null;
			try {
				scan = L.scanOf(name, rev);
			} catch (e) {
				scan = { error: e.message };
			}
			const R = L.revisions(name),
				mark = (xs) => xs.map((x) => ({ ...x, trusted: L.trusted(x.commit) }));
			return [200, { set: name, lib: set.lib, revisions: { branches: mark(R.branches), tags: mark(R.tags), commits: mark(R.commits) }, scan }];
		}
		// a set of this machine in a git repo: that repo's
		let revisions = none;
		if (!set.pull)
			try {
				revisions = L.revisionsIn(GIT.repoOf(set.code.build ? set.code.build.cwd : set.code.dir || set.code.file));
			} catch (e) {}
		return [200, { set: name, lib: set.lib || null, revisions, scan: null }];
	}

	// the form's options as compose.js takes them (paths: a template of setups_dir, else a file that exists)
	function optsOf(o) {
		if (!o || typeof o !== "object") throw new Error("opts: an object");
		const out = { ...o };
		if (out.template != null) {
			const f = path.resolve(String(out.template));
			if (!f.endsWith(".json") || !fs.existsSync(f)) throw new Error(`template: no setup file ${f}`);
			out.template = f;
		}
		if (out.pull === "" || out.pull === "latest") delete out.pull;
		// players: pages taken (ACCOUNT/TIME in players_dir)
		if (out.players != null && !(Array.isArray(out.players) && out.players.every((r) => typeof r === "string" && /^\w[\w.-]*\/\w[\w.-]*$/.test(r)))) throw new Error("players: [ACCOUNT/TIME] of pages taken");
		// code_names: { <a name in the CODE>: <a character of the run, "" keeps it> }, or false (none mapped)
		if (out.code_names != null && out.code_names !== false && !(typeof out.code_names === "object" && !Array.isArray(out.code_names) && Object.values(out.code_names).every((v) => typeof v === "string"))) throw new Error("code_names: { <a name in the CODE>: <a character of the run, or \"\": it stays> } or false");
		// storage, local_storage: { <account>: { <key>: <value> } }; prelude: { <name>: CODE }; steer: a list (setup.js checks them)
		const obj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
		for (const k of ["storage", "local_storage"]) if (out[k] != null && !(obj(out[k]) && Object.values(out[k]).every(obj))) throw new Error(`${k}: { <account>: { <key>: <value> } }`);
		if (out.prelude != null && !(obj(out.prelude) && Object.values(out.prelude).every((v) => typeof v === "string"))) throw new Error("prelude: { <name>: CODE }");
		if (out.steer != null && !Array.isArray(out.steer)) throw new Error("steer: a list of { at, character, storage, local_storage, code, note }");
		return out;
	}

	/**
	 * POST api/new/compose { opts, missing: { <name>: "slot:<slot>" | "idle" | "exclude" }, action, seeds, speed, force,
	 * name, record }. action "preview": what the options make, for the form; "check": each variant resolved (its CODE
	 * built); "save": into setups_dir; "sim": chronal run per variant and seed.
	 */
	async function compose(b) {
		const K = require("../lib/compose"),
			C = require("../lib/code_sets"),
			S = require("../lib/setup"),
			GIT = require("../lib/git_tree"),
			c = cfg(),
			G = K.game(c.al_root),
			action = b.action || "preview";
		if (!["preview", "check", "save", "sim"].includes(action)) return [400, { reason: 'action: "preview", "check", "save" or "sim"' }];
		if (b.record != null && typeof b.record !== "boolean") return [400, { reason: "record: true or false" }];
		let out;
		try {
			out = K.compose(optsOf(b.opts), { G });
		} catch (e) {
			return [200, { ok: false, problems: formTexts(e.problems || [e.message]) }];
		}
		// names in CODE and missing CODE, settled together (compose.js settle): the choices given, the rest asked for (built
		// once per build hook; each variant's own CODE)
		const given = b.missing && typeof b.missing === "object" ? b.missing : {},
			built = new Set(),
			known = K.knownNames({ pullsDir: c.pulls_dir, playersDir: c.players_dir }),
			missing = [],
			seen = new Set();
		const variants = [];
		for (const v of out.variants) {
			const vp = [];
			let st = { names: null, open: [], applied: [], bad: [] };
			try {
				st = K.settle(v.setup, { given: out.info.code_names, known, choices: given, build: S.runBuild, built, G });
			} catch (e) {
				vp.push(e.message);
			}
			vp.push(...st.bad);
			for (const m of st.open) if (!given[m.name] && !seen.has(m.name + "\0" + m.where)) seen.add(m.name + "\0" + m.where), missing.push({ ...m, code_set: v.code_set });
			let setup = null;
			try {
				setup = S.loadSetup(structuredClone(v.setup), { G });
			} catch (e) {
				vp.push(...(e.problems || [e.message]));
			}
			// each character as it starts: its state, place, CODE and the slots that CODE has (for the entry)
			let states = {};
			try {
				states = K.statesOf(v.setup, G);
			} catch (e) {
				vp.push(e.message);
			}
			// others' CODE fitted (fit.js): what its calls load, what its entries run first, its ES modules
			let fits = [];
			try {
				fits = K.fitsOf(v.setup, { build: S.runBuild, built });
			} catch (e) {
				vp.push(e.message);
			}
			// the storage keys its CODE reads
			let keys = { keys: [], dynamic: [], errors: [] };
			try {
				keys = K.keysOf(v.setup, { build: S.runBuild, built });
			} catch (e) {
				vp.push(e.message);
			}
			const chars = v.setup.characters.map((ch) => {
				const code = { ...(v.setup.defaults && v.setup.defaults.code), ...(ch.code || {}) };
				let slots = null;
				try {
					slots = code.file || !code.dir ? null : C.slotNames({ code: code.git ? GIT.inTree({ ...code, append: [].concat(code.append || []) }) : code });
				} catch (e) {}
				const lc = setup && setup.characters.find((y) => y.name === ch.name);
				return {
					name: ch.name, class: ch.class, account: (lc && lc.account) || ch.account || null, online: ch.online !== false, at: lc ? lc.at : null, source: out.info.states[ch.name] || null,
					start: states[ch.name] || null, code: { set: ((b.opts && b.opts.code_sets) || {})[ch.name] || v.code_set || null, entry: K.entrySlot(v.setup, ch), idle: code.file === C.IDLE, git: code.git ? { rev: code.git.rev } : null, prelude: code.prelude || null },
					slots,
				};
			});
			variants.push({
				label: v.label, key: v.key, name: v.setup.name, code_set: v.code_set, problems: vp, warnings: v.warnings, characters: chars, party: v.setup.party || null, names: st.names, keys, steer: (setup ? setup.steer : v.setup.steer) || [],
				fits, guessed: st.applied.filter((m) => m.guessed).map((m) => ({ name: m.name, slot: m.choice.slice(5), why: m.guess.why, slots: m.slots })),
				accounts: setup ? setup.accounts : v.setup.accounts, run: setup ? setup.run : v.setup.run, world: setup ? { ping: setup.world.ping, age: setup.world.age, start: setup.world.start, seasons: setup.world.seasons, events: setup.world.events } : null, setup: v.setup,
			});
		}
		// others' CODE (the library's) at a version not trusted here: what it is, who runs it, what it reaches
		const L = require("../lib/library"),
			untrusted = new Map();
		for (const v of variants)
			for (const u of L.untrusted(v.setup.characters.map((ch) => [ch.name, { ...(v.setup.defaults && v.setup.defaults.code), ...(ch.code || {}) }]))) {
				const k = u.commit || "-" + u.name,
					x = untrusted.get(k) || untrusted.set(k, { ...u, who: [] }).get(k);
				for (const n of u.who) if (!x.who.includes(n)) x.who.push(n);
			}
		for (const u of untrusted.values())
			try {
				u.scan = u.commit ? L.scanOf(u.name, u.commit) : null;
			} catch (e) {
				u.scan = { error: e.message };
			}
		const problems = variants.flatMap((v) => v.problems.map((p) => (variants.length > 1 ? `${v.label}: ` : "") + p)),
			res = { ok: !problems.length && !missing.length && !untrusted.size, problems: formTexts([...new Set(problems)]), missing, untrusted: [...untrusted.values()], risk: L.RISK, warnings: out.warnings, info: out.info, variants: variants.map(({ setup, ...v }) => v) };
		if (action === "preview") return [200, res];
		if (!res.ok) return [200, res];

		if (action === "check") {
			for (const v of variants)
				try {
					const r = S.resolveSetup(S.loadSetup(structuredClone(v.setup), { G }), { build: true, G });
					v.hashes = Object.fromEntries(r.resolved.characters.map((ch) => [ch.name, ch.code.hash]));
					v.warnings = [...v.warnings, ...r.warnings];
				} catch (e) {
					v.problems.push(...(e.problems || [e.message]));
				}
			return [200, { ...res, ok: variants.every((v) => !v.problems.length), checked: variants.map(({ label, name, hashes, problems, warnings }) => ({ label, name, hashes: hashes || null, problems: formTexts(problems), warnings })) }];
		}

		// written: save into setups_dir (a folder for a sweep); a start into the live dir's .launch/
		const safe = (s) => String(s).replace(/[^\w.+=-]/g, "_").slice(0, 100);
		const base = action === "save" ? c.setups_dir : path.join(x.dir, ".launch", "new-" + x.stamp() + "-" + crypto.randomBytes(2).toString("hex"));
		const name = b.name != null && b.name !== "" ? String(b.name) : out.base.name;
		if (!/^[\w .+=@~-]{1,80}$/.test(name)) return [400, { reason: "name: 1-80 letters, digits, spaces and _ . + = @ ~ -" }];
		const one = variants.length === 1 && !variants[0].label;
		const files = variants.map((v) => ({ file: one ? path.join(base, safe(name) + ".json") : path.join(base, safe(name), safe(v.key) + ".json"), setup: { ...v.setup, name: v.label ? `${name} [${v.label}]` : name }, v }));
		try {
			K.writeSetups(files, { force: action !== "save" || b.force === true, template: out.info.template });
		} catch (e) {
			return [409, { reason: e.message }];
		}
		if (action === "save") return [200, { ...res, files: files.map((f) => f.file) }];

		if (action === "sim") {
			const seeds = Array.isArray(b.seeds) && b.seeds.length ? b.seeds : [null];
			if (b.record && files.some((f) => f.setup.world && f.setup.world.threads === false)) return [400, { reason: "record: a setup with world.threads false runs in one thread, which records nothing" }];
			if (!seeds.every((s) => s === null || (Number.isInteger(s) && s >= 1 && s <= 2 ** 31 - 1))) return [400, { reason: "seeds: whole numbers from 1" }];
			const started = [];
			for (const f of files) for (const seed of seeds) started.push(startSim(f, seed, b.record === true)[1].launch);
			return [202, { ...res, launches: started }];
		}
	}

	// name: the setup's whole name (the tag stops at 80 characters), for the page's label
	const newL = (tag, file, args, name) => ({ key: "l-" + x.stamp() + "-" + crypto.randomBytes(2).toString("hex"), of: null, new: file, tag, name, args, state: "starting", pid: null, proc: null, log: null, started: Date.now(), exit: null, run: null, reason: null, cancel: false });

	// chronal run <file> [--seed N]: as a sim rerun of a setup; past the free sim threads it waits in the queue
	function startSim(f, seed, record) {
		const s = f.setup,
			n = s.world && s.world.threads === false ? 1 : s.characters.length + 1;
		const tag = s.name.slice(0, 80),
			L = newL(tag, f.file, { seed: seed ?? (s.run && s.run.seed) ?? 1, duration: (s.run && s.run.duration) || null, ...(record ? { record } : {}) }, s.name);
		Object.assign(L, { need: n, log: path.join(x.dir, "logs", L.key + ".log") });
		const args = [x.cli, "run", f.file, ...(seed != null ? ["--seed", String(seed)] : []), ...(record ? ["--record"] : []), "--tag", tag];
		x.startSim(L, x.root, args, { CHRONAL_LIVE_DIR: x.dir, CHRONAL_LAUNCH_KEY: L.key });
		x.addLaunch(L);
		return [202, { launch: L }];
	}

	return { info, items, fits, pull, player, top, addExport, snippet, code, codeInfo, compose, accountPut, accountDel, gearSets, gearSetPut, gearSetDel, pullDel, playerDel };
}

module.exports = { newRuns };
