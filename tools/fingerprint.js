// Per-minute fingerprints of a run setup: every character's state + a hash of its game log, and the server's monsters
// and players. Two checkouts with the same SEED and CODE must print the same lines (timings go to stderr); so must one
// checkout with LIVE=<dir> and without (live snapshots never change outcomes).
//   SETUP=my.json SEED=1 MINUTES=30 node tools/fingerprint.js > a.txt
//   CHRONAL_DIR=../other SETUP=my.json SEED=1 MINUTES=30 node tools/fingerprint.js > b.txt; cmp a.txt b.txt
// SETUP=<setup.json | <id>.setup.json>: a run setup (lib/setup.js + sim/start.js of CHRONAL_DIR, default this checkout;
// CHRONAL_NO_BUILD skips its build hooks, SEED overrides its seed, LIVE=<dir>: live snapshots there; a side file's CODE
// from its live dir's store, else LIVE's or the configured live dir's), its characters by name in setup order. Any CODE.
const path = require("path"), crypto = require("crypto");
const dir = path.resolve(process.env.CHRONAL_DIR || path.join(__dirname, ".."));

const env = process.env;
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const CLIENT = `({ l: character.level, xp: character.xp, g: character.gold, map: character.map, in: character.in, x: character.x, y: character.y,
	rx: character.real_x, ry: character.real_y, hp: character.hp, mp: character.mp, items: character.items, slots: character.slots,
	logs: (window.game_logs || []).map((x) => x[0]).join("\\n") })`;

function serverState(S) {
	const out = [];
	for (const name of Object.keys(S.instances).sort()) {
		const inst = S.instances[name];
		for (const id in inst.monsters) {
			const m = inst.monsters[id];
			out.push(["m", name, id, m.type, m.x, m.y, m.hp, m.mp, m.level, m.target || "", m.moving ? 1 : 0]);
		}
		for (const id in inst.players) {
			const p = inst.players[id];
			out.push(["p", name, id, p.x, p.y, p.hp, p.mp, p.xp, p.gold, p.level, p.target || "", p.moving ? 1 : 0]);
		}
	}
	return out;
}

(async () => {
	const t0 = performance.now();
	if (!env.SETUP) throw new Error("SETUP=<setup.json | <id>.setup.json>: the run to fingerprint");
	const { loadSetup, resolveSetup } = require(path.join(dir, "lib/setup.js")),
		{ startSetup } = require(path.join(dir, "sim/start.js"));
	const s = loadSetup(env.SETUP, { overrides: env.SEED ? { run: { seed: Number(env.SEED) } } : {} }),
		liveDir = env.LIVE ? path.resolve(env.LIVE) : null,
		live = [liveDir, require(path.join(dir, "lib/config.js")).config().live_dir].filter(Boolean);
	const { resolved, bundles } = resolveSetup(s, { build: !env.CHRONAL_NO_BUILD, by: "tools/fingerprint.js", store: live.map((d) => path.join(d, "code")) });
	const { sim } = await startSetup(resolved, bundles, { live: liveDir ? { dir: liveDir, setup: { resolved, bundles, from: s.file } } : false });
	// every character in setup order, the one in game now by name (characters come and go through start_character)
	const inGame = (name) => sim.clients.findLast((c) => c.name === name && c.online !== false) || null;
	const names = resolved.characters.map((c) => c.name);
	console.error(`${dir}: boot + login ${Math.round(performance.now() - t0)} ms`);
	const minutes = Number(env.MINUTES || 30);
	let real = 0;
	for (let i = 1; i <= minutes; i++) {
		const res = await sim.run(60_000);
		// failed (a CODE asked for a slot the setup doesn't give): ended "failed" (as chronal run)
		if (sim.failed) {
			await sim.close();
			console.error("FAILED: " + sim.failed);
			process.exit(1);
		}
		real += res.realMs;
		const parts = [`t${i}`, `ev ${sim.clock.events}`];
		for (const name of names) {
			const c = inGame(name);
			if (!c) {
				parts.push(`${name} offline`);
				continue;
			}
			const q = await c.query(CLIENT);
			const logs = q.logs;
			delete q.logs;
			parts.push(`${name} L${q.l} xp ${q.xp} g ${q.g} ${q.map} ${q.rx},${q.ry} hp ${q.hp} mp ${q.mp} items ${hash(JSON.stringify(q.items))} slots ${hash(JSON.stringify(q.slots))} state ${hash(JSON.stringify(q))} logs ${hash(logs)}`);
		}
		const s = serverState(sim.server);
		parts.push(`S ${s.filter((x) => x[0] === "m").length}m ${s.filter((x) => x[0] === "p").length}p ${hash(JSON.stringify(s))}`);
		console.log(parts.join(" | "));
	}
	console.error(`${minutes} vmin: ${((minutes * 60_000) / real).toFixed(0)}x` + (sim.busy ? `, server busy ${(sim.busy().server / minutes).toFixed(0)} ms/vmin` : ""));
	await sim.close();
	process.exit(0);
})().catch((e) => {
	console.error("FAILED:", (e && e.stack) || e);
	process.exit(1);
});
