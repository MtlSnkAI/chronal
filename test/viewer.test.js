// viewer/: the replay routes over a recording (lib/rec.js) in a live dir, and the viewer the dashboard mounts: the game's
// web backend (here a fake game app) started on demand, proxied with its pages' address and the replay scripts, closed
// when idle.
// node --test test/viewer.test.js
"use strict";
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	http = require("node:http"),
	zlib = require("node:zlib");
const test = require("node:test");
const assert = require("node:assert");
const { routes } = require("../viewer/replay");
const { createDashboard } = require("../dashboard/server");
const rec = require("../lib/rec");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viewer-test-")));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ID = "party--1790000000000";
// a live dir with a run whose Ran1 is recorded
function liveDir(name) {
	const dir = path.join(TMP, name);
	const r = new rec.Recorder(path.join(dir, ID + ".rec"), "Ran1", { memberMs: 1000 });
	r.add(5000, "a", "s1");
	r.add(5100, "p", JSON.stringify(["start", { map: "main", in: "main", x: 0, y: 0 }]));
	r.add(6200, "p", JSON.stringify(["player", { x: 1 }]));
	r.close();
	fs.writeFileSync(path.join(dir, ID + ".json"), JSON.stringify({ id: ID, tag: "party", schema: 2, schema_minor: 2, done: true, started: new Date().toISOString(), updated: new Date().toISOString(), virtual_ms: 600000, real_ms: 6000, players: [] }));
	return dir;
}
// a response that keeps what was written
const res = () => {
	const r = { code: null, headers: null, body: null };
	r.writeHead = (code, headers) => ((r.code = code), (r.headers = headers || {}), r);
	r.end = (body) => ((r.body = body), r);
	return r;
};

test("replay routes: /replay/ redirects to the character's game page with chronal_replay; /__rec/ serves the index and gzip members; the page's scripts play on a clock of their own", () => {
	const dir = liveDir("routes");
	const R = routes({ dir: () => dir, page: (n) => `/character/${n}/in/US/I/` });
	const get = (u) => { const x = res(); return [R.handle({}, x, new URL(u, "http://v")), x]; };
	let [done, x] = get(`/replay/${ID}/Ran1?t=30`);
	assert.deepStrictEqual([done, x.code, x.headers.location], [true, 302, `/character/Ran1/in/US/I/?t=30&chronal_replay=${ID}`]);
	for (const u of [`/replay/${ID}/Nobody`, `/replay/..%2F${ID}/Ran1`, `/replay/x/Ran1`, `/__rec/${ID}/Ran1/7`, `/__rec/${ID}/Ran%2F1/idx`]) assert.strictEqual(get(u)[1].code, 404, u);
	assert.strictEqual(get("/hub")[0], false);
	[, x] = get(`/__rec/${ID}/Ran1/idx`);
	assert.deepStrictEqual(JSON.parse(x.body).members.map((m) => m.first), [5000, 6200]);
	[, x] = get(`/__rec/${ID}/Ran1/1`);
	assert.strictEqual(x.headers["content-encoding"], "gzip");
	assert.deepStrictEqual(zlib.gunzipSync(x.body).toString("utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[1]), ["S", "p"]);
	const html = R.script(new URL(`http://v/character/Ran1/in/US/I/?chronal_replay=${ID}&v=5500&base=5050`));
	const o = JSON.parse(/\(function replay[\s\S]*\}\)\((\{.*?\}), function fold/.exec(html)[1]);
	assert.deepStrictEqual(o, { id: ID, name: "Ran1", first: 5000, version: 2 ** 50, max: 100, t: null, v: 5500, base: 5050, paused: false, speed: null });
	assert.match(html, /"version":1125899906842624,"segments":\[\{"r":[\d.]+,"v":5000,"f":1\}\]/); // its own clock: from the first packet
	assert.strictEqual(R.script(new URL(`http://v/character/Ran1/in/US/I/?chronal_replay=nope--1`)), null);
});

// a fake game app: what backend.js reads (the maps' seed, mongodb_functions, options.js) and a main.js that serves a
// page, a script and an API call with its base_url in them, uses "mongodb", and bumps version.js as the game's does
function fakeApp() {
	const d = path.join(TMP, "app");
	const put = (f, s) => (fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }), fs.writeFileSync(path.join(d, f), s));
	put("common/mongodb_functions.js", "function get_kind_from_id(id) { return 'map'; }\n");
	put("scripts/seed_mongodb.js", "module.exports = { seedMaps: [] };\n");
	put("secretsandconfig/options.js", 'module.exports = { base_url: "http://localhost:8090" };\n');
	put("version.js", "1\n");
	put("main.js", `const fs = require("fs"), http = require("http"), mongo = require("mongodb");
fs.writeFileSync("version.js", "2\\n");
const srv = http.createServer((q, r) => {
	if (q.url.startsWith("/character/")) return r.writeHead(200, { "content-type": "text/html" }), r.end('<html><head><title>g</title><script src="/js/game.js"></script><script>(function(){})(window,document,"script","https://www.google-analytics.com/analytics.js","ga"); ga("send", "pageview");</script><script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head><body><a href="http://localhost:8090/x">x</a></body></html>');
	if (q.url === "/js/game.js") return r.writeHead(200, { "content-type": "application/javascript" }), r.end('var base = "http://localhost:8090";');
	if (q.url === "/api/servers_and_characters") return r.writeHead(200, { "content-type": "application/json" }), r.end(JSON.stringify({ method: q.method, mongo: typeof mongo.MongoClient, address: srv.address().address }));
	r.writeHead(404).end();
});
srv.listen(+process.env.PORT);
`);
	return d;
}
async function serve(o) {
	const warn = console.warn;
	console.warn = () => {};
	let d;
	try {
		d = createDashboard({ root: path.join(TMP, "no-root"), ...o });
	} finally {
		console.warn = warn;
	}
	const srv = http.createServer(d.handle);
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const port = srv.address().port;
	const call = (method, p, headers = {}) =>
		new Promise((resolve, reject) => {
			const rq = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(method === "POST" && p === "/api/viewer" ? { "x-dashboard": "1", "content-type": "application/json" } : {}), ...headers }, agent: false }, (r) => {
				let s = "";
				r.on("data", (c) => (s += c)).on("end", () => resolve({ code: r.statusCode, headers: r.headers, text: s }));
			});
			rq.on("error", reject);
			rq.end(method === "POST" ? "{}" : undefined);
		});
	return { port, call, close: () => (d.close(), new Promise((r) => srv.close(r))) };
}
async function until(fn, ms, what) {
	for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 100))) {
		const v = await fn();
		if (v) return v;
	}
	throw new Error("timed out waiting for " + what);
}

test("the viewer on the dashboard's port: api/viewer starts the backend (202, then 200); replay pages with the scripts in their head, the game's analytics left out, the backend's address made the dashboard's; closed when idle", async () => {
	const dir = liveDir("mount"),
		app = fakeApp(),
		s = await serve({ dir, appDir: app, viewerIdleMs: 1500 });
	const up = async () => JSON.parse((await s.call("GET", "/api/control")).text).viewer.up;
	try {
		assert.strictEqual(await up(), false);
		let r = await s.call("POST", "/api/viewer");
		assert.deepStrictEqual([r.code, JSON.parse(r.text)], [202, { up: false, starting: true }]);
		await until(async () => (await s.call("POST", "/api/viewer")).code === 200, 10000, "the backend to answer");
		assert.strictEqual(await up(), true);
		// /replay/: to the character's page, served by the backend with the replay's scripts in its head
		r = await s.call("GET", `/replay/${ID}/Ran1?t=5`);
		assert.deepStrictEqual([r.code, r.headers.location], [302, `/character/Ran1/in/US/I/?t=5&chronal_replay=${ID}`]);
		r = await s.call("GET", r.headers.location);
		const here = `http://127.0.0.1:${s.port}`;
		assert.deepStrictEqual([r.code, /<head><script>[\s\S]*__timewarp[\s\S]*<\/script><title>/.test(r.text), r.text.includes(here + "/x"), r.text.includes("localhost:8090")], [200, true, true, false]);
		// the game's analytics left out, its other scripts kept
		assert.deepStrictEqual([/google-analytics|googletagmanager|pageview/.test(r.text), r.text.includes('<title>g</title><script src="/js/game.js"></script></head>')], [false, true]);
		assert.strictEqual((await s.call("GET", `/character/Ran1/in/US/I/?chronal_replay=nope--1`)).code, 404);
		// a script: the address made this one's, kept by the browser (an ETag)
		r = await s.call("GET", "/js/game.js");
		assert.deepStrictEqual([r.code, r.text, r.headers["cache-control"]], [200, `var base = "${here}";`, "private, no-cache"]);
		assert.strictEqual((await s.call("GET", "/js/game.js", { "if-none-match": r.headers.etag })).code, 304);
		// the page's API calls (no dashboard header): the backend's, on the sim's Mongo, bound to loopback
		r = await s.call("POST", "/api/servers_and_characters");
		assert.deepStrictEqual(JSON.parse(r.text), { method: "POST", mongo: "function", address: "127.0.0.1" });
		assert.strictEqual(fs.readFileSync(path.join(app, "version.js"), "utf8"), "1\n"); // main.js's bump: not written
		// unused past viewerIdleMs: closed
		await until(async () => !(await up()), 8000, "the idle backend to close");
	} finally {
		await s.close();
	}
});
