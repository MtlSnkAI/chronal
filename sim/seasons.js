"use strict";
// The server's seasons switched on and off as a run goes (a setup's world.seasons with times). A season's switch is
// its events flag plus what the server's sprocess_game_data does for it at boot (server_functions.js: the global drop
// entries it pushes, the values it sets, e.g. jr's respawn) and, for valentines, server.js's own pinkgoo timer: done
// when it starts, undone when it ends (the entries removed, the values put back). The event loop then spawns its
// monsters (or no more), and E follows. Monsters already up stay, as when live's admins switch one.
//   blocks(root) -> { <season>: [{ push: src } | { set: lhs, to: src }] }: read from the server's code (throws when its
//   shape changed); seasonOn(ctx, season, state) / seasonOff(ctx, season, state)
const fs = require("node:fs"),
	path = require("node:path"),
	vm = require("node:vm"),
	acorn = require("acorn");
const { SEASONS } = require("../lib/schedule");

// server.js's own, at its top level (before a boot sees events)
const EXTRA = { valentines: [{ set: "events.pinkgoo", to: "60" }] };

const cache = new Map();
function blocks(root) {
	if (cache.has(root)) return cache.get(root);
	const file = path.join(root, "node", "server_functions.js"),
		src = fs.readFileSync(file, "utf8"),
		ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true }),
		fn = ast.body.find((n) => n.type === "FunctionDeclaration" && n.id && n.id.name === "sprocess_game_data");
	if (!fn) throw new Error("[sim] seasons: no sprocess_game_data in server_functions.js: server code changed");
	const text = (n) => src.slice(n.start, n.end),
		out = {};
	for (const st of fn.body.body) {
		const t = st.type === "IfStatement" && st.test;
		if (!t || t.type !== "MemberExpression" || text(t.object) !== "events" || !SEASONS.includes(t.property.name)) continue;
		const list = (out[t.property.name] = []);
		for (const s of st.consequent.type === "BlockStatement" ? st.consequent.body : [st.consequent]) {
			const e = s.type === "ExpressionStatement" && s.expression;
			if (e && e.type === "CallExpression" && text(e.callee) === "D.drops.maps.global.push" && e.arguments.length === 1) list.push({ push: text(e.arguments[0]) });
			else if (e && e.type === "AssignmentExpression" && e.operator === "=") list.push({ set: text(e.left), to: text(e.right) });
			else throw new Error(`[sim] seasons: ${t.property.name}: "${text(s)}" in sprocess_game_data: server code changed`);
		}
	}
	for (const [k, x] of Object.entries(EXTRA)) (out[k] ||= []).push(...x);
	cache.set(root, out);
	return out;
}

// state: { <season>: { pushed: [entry], set: [[lhs, old]] } } of the seasons on
function seasonOn(ctx, season, state, root) {
	if (state[season]) return false;
	const run = (code) => vm.runInContext(code, ctx),
		rec = (state[season] = { pushed: [], set: [] });
	for (const b of blocks(root)[season] || []) {
		if (b.push) {
			const entry = run(`(${b.push})`);
			run("D.drops.maps.global").push(entry);
			rec.pushed.push(entry);
		} else {
			rec.set.push([b.set, run(b.set)]);
			run(`(function (v) { ${b.set} = v; })`)(run(`(${b.to})`));
		}
	}
	ctx.events[season] = true;
	if (ctx.server && ctx.server.live && typeof ctx.broadcast_e === "function") ctx.broadcast_e();
	return true;
}
function seasonOff(ctx, season, state) {
	const rec = state[season];
	if (!rec) return false;
	const run = (code) => vm.runInContext(code, ctx),
		global = run("D.drops.maps.global");
	for (const entry of rec.pushed) {
		const i = global.indexOf(entry);
		if (i >= 0) global.splice(i, 1);
	}
	for (const [lhs, old] of rec.set.slice().reverse()) run(`(function (v) { ${lhs} = v; })`)(old);
	delete state[season];
	ctx.events[season] = false;
	if (ctx.server && ctx.server.live && typeof ctx.broadcast_e === "function") ctx.broadcast_e();
	return true;
}

module.exports = { blocks, seasonOn, seasonOff };
