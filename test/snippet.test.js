"use strict";
// snippets/export-state.js, run against a fake game page (the live game is the user's to test): the export on the
// clipboard, gzipped and base64 when large, the file when the clipboard refuses; lib/pull.js exportFromText reads
// each back (what Add export and chronal pull --add do).
//   node --test test/snippet.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	path = require("node:path"),
	vm = require("node:vm");
const P = require("../lib/pull");

const SNIPPET = fs.readFileSync(path.join(__dirname, "..", "snippets", "export-state.js"), "utf8");
// the snippet in a page: its parent the game (P), game_log; -> { copied, downloaded, logs, state }
async function run({ items = 3, clipboard = true } = {}) {
	const out = { copied: null, downloaded: null, logs: [] };
	const page = {
		character: { name: "Ran", ctype: "ranger", level: 60, xp: 1, gold: 2, items: Array.from({ length: items }, (_, i) => ({ name: "hpot0", q: 9999, note: "x".repeat(40) + i })), slots: {}, s: {}, q: {}, real_x: 1, real_y: 2, map: "main", in: "main", cash: 0 },
		G: { classes: { ranger: {} } }, X: { characters: [{ name: "Ran", type: "ranger", level: 60, online: true }] }, server_region: "EU", server_identifier: "I",
		localStorage: { getItem: () => null },
		navigator: { clipboard: { writeText: async (t) => { if (!clipboard) throw new Error("denied"); out.copied = t; } } },
		document: { createElement: (k) => (k === "a" ? { click() { out.downloaded = this.download; }, remove() {} } : { style: {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand: () => false },
		URL: { createObjectURL: () => "blob:x" }, Blob, Response, CompressionStream, btoa,
	};
	await new Promise((done) => vm.runInNewContext(SNIPPET, { parent: page, game_log: (m) => (out.logs.push(m), /^Exported|export failed/.test(m) && done()), setTimeout, Promise, JSON, Object, Array, Math, Date, String, Uint8Array }));
	return out;
}

test("the export on the clipboard: as JSON, gzipped when large; the file when the clipboard refuses", async () => {
	const small = await run();
	assert.match(small.logs.at(-1), /^Exported Ran to the clipboard \(\d+ KB\)/);
	assert.ok(small.copied.startsWith("{"));
	assert.equal(P.exportFromText(small.copied).character.items.length, 3);
	const big = await run({ items: 2000 });
	assert.match(big.logs.at(-1), /^Exported Ran to the clipboard \(\d+ KB, compressed\)/);
	assert.ok(big.copied.startsWith("chronal-export:gz:"));
	const e = P.exportFromText(big.copied);
	assert.equal(e.character.items.length, 2000);
	assert.equal(e.character.items[1999].note, "x".repeat(40) + 1999);
	const refused = await run({ clipboard: false });
	assert.equal(refused.copied, null);
	assert.equal(refused.downloaded, "Ran.json");
	assert.match(refused.logs.at(-1), /Ran\.json downloaded/);
	assert.throws(() => P.exportFromText(big.copied.slice(0, 200)), /cut short or changed/);
	assert.throws(() => P.exportFromText("{}"), /not an export/);
});
