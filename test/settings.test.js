"use strict";
// dashboard/settings.js (the dashboard's Settings, api/config): the token tested against a fake token API, saved
// (mode 0600) where nothing is yet, never over a token file of yours; config/local.json's folders and port (a scratch
// local.json here: CHRONAL_LOCAL_CONFIG).
//   node --test test/settings.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	http = require("node:http");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-")));
const LOCAL = path.join(TMP, "local.json"),
	TOKEN = path.join(TMP, "token");
fs.writeFileSync(LOCAL, JSON.stringify({ upstream: "../upstream" }));
Object.assign(process.env, { CHRONAL_LOCAL_CONFIG: LOCAL, CHRONAL_AL_TOKEN_FILE: TOKEN, CHRONAL_LIVE_DIR: path.join(TMP, "live") });
delete process.env.CHRONAL_AL_TOKEN;
fs.mkdirSync(path.join(TMP, "live"));
const { createDashboard } = require("../dashboard/server");

// a fake mcp_api that knows one token
function fakeApi() {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d)).on("end", () => {
			const b = JSON.parse(body);
			res.end(JSON.stringify(b.token !== "goodtoken1" ? { failed: true, reason: "invalid_token" } : { success: true, characters: [{ character: "Ran", class: "ranger", level: 60 }, { character: "Pri", class: "priest", level: 58 }] }));
		});
	});
	return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ api: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
async function serve() {
	const warn = console.warn;
	console.warn = () => {};
	const d = createDashboard({ dir: path.join(TMP, "live"), appDir: TMP, root: path.join(TMP, "no-root") });
	console.warn = warn;
	const srv = http.createServer(d.handle);
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const call = (method, p, body) =>
		new Promise((resolve, reject) => {
			const h = method === "GET" ? {} : { "x-dashboard": "1", "content-type": "application/json" };
			const rq = http.request({ host: "127.0.0.1", port: srv.address().port, method, path: p, headers: h, agent: false }, (res) => {
				let s = "";
				res.on("data", (c) => (s += c)).on("end", () => resolve({ code: res.statusCode, body: s ? JSON.parse(s) : null }));
			});
			rq.on("error", reject);
			rq.end(body != null ? JSON.stringify(body) : undefined);
		});
	return { call, close: () => (d.close(), new Promise((r) => srv.close(r))) };
}

test("the token: tested (the account's characters), saved 0600 where none is, never over yours; tested again from the file", async (t) => {
	const f = await fakeApi(), s = await serve();
	process.env.CHRONAL_AL_API = f.api;
	t.after(() => (f.close(), s.close()));
	let r = await s.call("GET", "/api/config");
	assert.deepStrictEqual(r.body.token, { source: "none", file: TOKEN, ours: false, writable: true });
	r = await s.call("POST", "/api/config/token", { action: "test", token: "not a token" });
	assert.strictEqual(r.code, 400);
	r = await s.call("POST", "/api/config/token", { action: "test", token: "wrongtoken" });
	assert.strictEqual(r.code, 502);
	assert.match(r.body.reason, /doesn't know this token/);
	r = await s.call("POST", "/api/config/token", { action: "test", token: "goodtoken1" });
	assert.deepStrictEqual(r.body, { characters: [{ name: "Ran", class: "ranger", level: 60 }, { name: "Pri", class: "priest", level: 58 }], saved: false });
	assert.ok(!fs.existsSync(TOKEN), "a test saves nothing");
	r = await s.call("POST", "/api/config/token", { action: "save", token: " goodtoken1 " });
	assert.strictEqual(r.code, 200);
	assert.strictEqual(fs.readFileSync(TOKEN, "utf8"), "goodtoken1\n");
	assert.strictEqual(fs.statSync(TOKEN).mode & 0o777, 0o600);
	r = await s.call("GET", "/api/config");
	assert.deepStrictEqual(r.body.token, { source: "file", file: TOKEN, ours: false, writable: false });
	assert.ok(!JSON.stringify(r.body).includes("goodtoken1"), "the token never goes back to the page");
	r = await s.call("POST", "/api/config/token", { action: "save", token: "goodtoken1" });
	assert.strictEqual(r.code, 409, "a token file of yours: not overwritten");
	r = await s.call("POST", "/api/config/token", { action: "test" });
	assert.strictEqual(r.body.characters.length, 2);
	r = await s.call("DELETE", "/api/config/token");
	assert.strictEqual(r.code, 409, "not ChronAL's own file: not removed");
	assert.ok(fs.existsSync(TOKEN));
});

test("config/local.json: a setting set, dropped back to its default, refused when bad or set by the environment", async (t) => {
	const s = await serve();
	t.after(() => s.close());
	let r = await s.call("PUT", "/api/config", { set: { setups_dir: "my-setups", port: 18089 } });
	assert.strictEqual(r.code, 200);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(LOCAL, "utf8")), { upstream: "../upstream", setups_dir: "my-setups", port: 18089 });
	assert.deepStrictEqual([r.body.settings.setups_dir.from, r.body.settings.setups_dir.value, r.body.settings.port.value], ["local", "my-setups", 18089]);
	r = await s.call("PUT", "/api/config", { set: { port: null } });
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(LOCAL, "utf8")), { upstream: "../upstream", setups_dir: "my-setups" });
	assert.strictEqual(r.body.settings.port.from, "default");
	for (const set of [{ port: 0 }, { port: "8089" }, { setups_dir: "" }, { nope: "x" }]) assert.strictEqual((await s.call("PUT", "/api/config", { set })).code, 400, JSON.stringify(set));
	r = await s.call("PUT", "/api/config", { set: { live_dir: "elsewhere" } });
	assert.strictEqual(r.code, 409, "CHRONAL_LIVE_DIR sets it");
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(LOCAL, "utf8")), { upstream: "../upstream", setups_dir: "my-setups" });
});
