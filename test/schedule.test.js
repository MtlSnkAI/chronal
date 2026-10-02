"use strict";
// lib/schedule.js: the server's clock-driven events as the game's own server has them (its node/server.js and
// server_functions.js, the sim's region), and what a span of the clock crosses.
//   node --test test/schedule.test.js      (needs the game: chronal install)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	path = require("node:path");
const { config } = require("../lib/config");
const SCH = require("../lib/schedule");

test("the schedule is the game server's: its dailies, nightlies, night, the sim's region's offset, seasons", () => {
	const root = config().al_root,
		server = fs.readFileSync(path.join(root, "node", "server.js"), "utf8"),
		fns = fs.readFileSync(path.join(root, "node", "server_functions.js"), "utf8"),
		options = fs.readFileSync(path.join(root, "..", "secretsandconfig", "options.js"), "utf8");
	const list = (re, src) => JSON.parse(re.exec(src)[1]);
	assert.deepStrictEqual(list(/dailies:\s*(\[[^\]]*\])/, server), SCH.SCHEDULE.dailies);
	assert.deepStrictEqual(list(/nightlies:\s*(\[[^\]]*\])/, server), SCH.SCHEDULE.nightlies);
	assert.deepStrictEqual(list(/var dailies = (\[[^\]]*\])/, server).sort(), [...SCH.DAILIES].sort());
	assert.deepStrictEqual(list(/var nightlies = (\[[^\]]*\])/, server).sort(), [...SCH.NIGHTLIES].sort());
	assert.match(fns, /if \(ch >= 0 && ch <= 5\) \{\s*E\.schedule\.night = true;/, "night: the server's hours 0-5");
	assert.strictEqual(/region:\s*"(\w+)"/.exec(options)[1], SCH.SCHEDULE.region);
	assert.strictEqual(Number(new RegExp(SCH.SCHEDULE.region + ":\\s*(-?\\d+)").exec(server)[1]), SCH.SCHEDULE.time_offset);
	for (const s of SCH.SEASONS) assert.match(server, new RegExp("\\n\\s*" + s + ":\\s*(false|0)"), s + ": a season switch, off");
});

test("crossed: the night, dailies and nightlies a span of the clock crosses", () => {
	const t = (iso) => Date.parse(iso);
	// the default start (the server's 19:00): a daily at 01:00 UTC (its 20:00), a nightly at 04:00 (23:00), night 05:00-11:00
	assert.deepStrictEqual(SCH.crossed(t("2026-01-01T00:00Z"), t("2026-01-01T00:30Z")), []);
	assert.deepStrictEqual(SCH.crossed(t("2026-01-01T00:00Z"), t("2026-01-01T12:00Z")), [
		{ kind: "daily", at: t("2026-01-01T01:00Z") },
		{ kind: "nightly", at: t("2026-01-01T04:00Z") },
		{ kind: "night", from: t("2026-01-01T05:00Z"), to: t("2026-01-01T11:00Z") },
	]);
	// a span inside the night: all of it
	assert.deepStrictEqual(SCH.crossed(t("2026-01-01T06:10Z"), t("2026-01-01T06:40Z")), [{ kind: "night", from: t("2026-01-01T06:10Z"), to: t("2026-01-01T06:40Z") }]);
	assert.strictEqual(SCH.serverHour(t("2026-01-01T00:00Z")), 19);
});
