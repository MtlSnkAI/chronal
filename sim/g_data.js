"use strict";
// The game's G as a browser gets it from the server's /data.js, to cache/G-<G.version>.json (plain JSON). config.js
// gData() picks the newest one (the dashboard's item tooltips, tools that read G) when no g_data is configured.
// Boots the server of config().al_root once (a few seconds): the sim's client G (clientInfo), plus the tables /data.js
// also serves that the sim's client G leaves out (upgrades, compounds, monster_gold, drops), from the design files as
// main.js evaluates them (the server's own copies in D change at runtime: event drops).
//   chronal g-data
const fs = require("node:fs"),
	path = require("node:path"),
	vm = require("node:vm");
const { createSim } = require("./sim");
const { clientInfo } = require("./client_host");
const { config } = require("../lib/config");

// main.js's order up to drops.js (dependencies first)
const DESIGN = ["projectiles", "animations", "achievements", "game_design", "games", "conditions", "sprites", "dimensions", "monsters", "maps", "npcs", "multipliers", "items", "classes", "levels", "upgrades", "drops"];

const main = () => (async () => {
	const root = config().al_root;
	const sim = await createSim({ root, threads: false, live: false });
	const info = clientInfo(sim.server),
		G = JSON.parse(info.gJson),
		design = vm.createContext({});
	for (const f of DESIGN) vm.runInContext(fs.readFileSync(path.join(root, "design", f + ".js"), "utf8"), design, { filename: f + ".js" });
	for (const k of ["upgrades", "compounds", "monster_gold", "drops"]) if (G[k] === undefined) G[k] = design[k];
	const json = JSON.stringify(G),
		dir = path.join(__dirname, "..", "cache"),
		file = path.join(dir, `G-${info.version}.json`),
		tmp = file + "." + process.pid + ".tmp";
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(tmp, json);
	fs.renameSync(tmp, file);
	console.log(`${file} (G version ${info.version}, ${(json.length / 1e6).toFixed(1)} MB, from ${root})`);
	await sim.close();
	process.exit(0);
})().catch((e) => {
	console.error("FAILED:", (e && e.stack) || e);
	process.exit(1);
});

module.exports = { main };
