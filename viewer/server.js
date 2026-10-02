"use strict";
// The replay viewer: recorded runs (lib/rec.js, docs/reference/recording.md) played in the game's own page, in any
// browser, view only. The dashboard mounts it on its own port (claims(): the paths below; handle()). On the first
// request it starts the game's web backend (al_root's main.js, backend.js preloaded: the sim's in-memory Mongo, no
// accounts) on a loopback port of its own, which renders the game's page and serves its files:
//   /replay/<run id>/<name>[?t=|?v=][&base=][&max=][&speed=][&paused=1]   the recorded character's game page (replay.js)
//   /__rec/<run id>/<name>/idx | <k>                                     its recording: the index, the members
//   /character/<name>/in/US/I/?chronal_replay=<run id>&...               the page, the time warp and the replay in its head
//   /js/, /css/, /sounds/, /phrases/, /data.js, /favicon.ico, the images the dashboard doesn't serve, and the API calls
//   the page makes (servers_and_characters, pull_chat(s))                   from the backend
// The backend ends with close(), or idleMs (default 5 min) after the last request.
const fs = require("node:fs"),
	http = require("node:http"),
	net = require("node:net"),
	path = require("node:path"),
	crypto = require("node:crypto"),
	{ spawn } = require("node:child_process");
const { routes } = require("./replay");
const { REAL_TIME_LIBS, realTimeWrap } = require("./timewarp");

const FILES = /^\/(js|css|sounds|phrases)\/|^\/(data\.js|favicon\.ico)$/,
	API = new Set(["/api/servers_and_characters", "/api/pull_chat", "/api/pull_chats"]),
	PAGE = /^\/character\/[^/]+\/in\//;
const page = (name) => `/character/${encodeURIComponent(name)}/in/US/I/`;

const freePort = () =>
	new Promise((resolve, reject) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
		s.on("error", reject);
	});
const answers = (port) =>
	new Promise((resolve) => {
		const c = net.connect(port, "127.0.0.1");
		c.once("connect", () => (c.destroy(), resolve(true)));
		c.once("error", () => resolve(false));
	});

/** @param {object} o dir: () => the live dir; appDir: the game (config al_root); idleMs */
function createViewer({ dir, appDir, idleMs = 5 * 60e3 }) {
	const replays = routes({ dir, page });
	let backend = null, // { child, port, ready: Promise }
		used = 0,
		base = null; // the backend's own address in its pages (options.base_url)
	const log = path.join(dir(), "logs", "viewer.log");

	function start() {
		if (backend) return backend.ready;
		const b = (backend = { child: null, port: null, ready: null, ok: false });
		b.ready = (async () => {
			b.port = await freePort();
			fs.mkdirSync(path.dirname(log), { recursive: true });
			const fd = fs.openSync(log, "a");
			try {
				b.child = spawn(process.execPath, ["-r", path.join(__dirname, "backend.js"), "main.js"], { cwd: appDir, env: { ...process.env, PORT: String(b.port), NODE_OPTIONS: "" }, stdio: ["ignore", fd, fd] });
			} finally {
				fs.closeSync(fd);
			}
			b.child.on("exit", () => backend === b && (backend = null));
			try {
				base = require(path.join(appDir, "secretsandconfig", "options.js")).base_url || null;
			} catch (e) {}
			for (const t0 = Date.now(); !(await answers(b.port)); await new Promise((r) => setTimeout(r, 200)))
				if (!b.child || b.child.exitCode != null || Date.now() - t0 > 60e3) throw new Error(`the game's backend did not start: ${log}`);
			b.ok = true;
		})();
		b.ready.catch(() => backend === b && close());
		return b.ready;
	}
	function close() {
		const b = backend;
		backend = null;
		if (b && b.child && b.child.exitCode == null) b.child.kill("SIGTERM");
	}
	const timer = setInterval(() => backend && Date.now() - used > idleMs && close(), Math.min(30e3, idleMs));
	timer.unref();

	// what the viewer takes of a dashboard's requests (p: the path); the dashboard serves the png, jpg and gif images
	function claims(req, p) {
		const get = req.method === "GET" || req.method === "HEAD";
		if (get) return /^\/(replay|__rec)\//.test(p) || FILES.test(p) || PAGE.test(p) || (p.startsWith("/images/") && !/\.(png|jpg|gif)$/.test(p));
		return req.method === "POST" && API.has(p);
	}

	// the backend's answer, its pages' address made this one's; html: scripts for the head of an HTML page
	function proxy(req, res, html = "") {
		const inm = req.headers["if-none-match"];
		const headers = { ...req.headers, host: "127.0.0.1:" + backend.port, "accept-encoding": "identity" };
		for (const k of ["if-none-match", "if-modified-since", "cookie"]) delete headers[k];
		const up = http.request({ host: "127.0.0.1", port: backend.port, method: req.method, path: req.url, headers }, (r) => {
			const type = r.headers["content-type"] || "",
				out = { ...r.headers },
				here = `http://${req.headers.host}`;
			if (out.location && base) out.location = out.location.replace(base, here);
			if (!/^(text\/|application\/(json|javascript))/.test(type)) return res.writeHead(r.statusCode, out), r.pipe(res);
			const chunks = [];
			r.on("data", (c) => chunks.push(c));
			r.on("end", () => {
				let body = Buffer.concat(chunks).toString("utf8");
				if (base) body = body.split(base).join(here);
				if (REAL_TIME_LIBS.test(req.url)) body = realTimeWrap(body);
				if (type.startsWith("text/html")) body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + html) : html + body;
				for (const k of ["content-length", "etag", "last-modified"]) delete out[k];
				out["cache-control"] = "no-store";
				// scripts and styles (as rewritten here): the browser keeps them and asks again each time
				if (/^(application\/javascript|text\/javascript|text\/css)/.test(type) && r.statusCode === 200) {
					const etag = '"' + crypto.createHash("sha1").update(body).digest("base64url") + '"';
					Object.assign(out, { etag, "cache-control": "private, no-cache" });
					if (inm === etag) return res.writeHead(304, { etag, "cache-control": "private, no-cache" }), res.end();
				}
				res.writeHead(r.statusCode, out);
				res.end(body);
			});
		});
		up.on("error", (e) => (res.headersSent ? res.destroy() : (res.writeHead(502), res.end(`the game's backend: ${e.message}`))));
		req.pipe(up);
	}

	async function handle(req, res) {
		used = Date.now();
		const url = new URL(req.url, "http://x");
		try {
			if (replays.handle(req, res, url)) return;
			await start();
			if (PAGE.test(url.pathname)) {
				const html = url.searchParams.get("chronal_replay") != null ? replays.script(url) : null;
				if (!html) return res.writeHead(404, { "content-type": "text/plain" }).end("no such recording");
				return proxy(req, res, html);
			}
			proxy(req, res);
		} catch (e) {
			if (!res.headersSent) res.writeHead(503, { "content-type": "text/plain" });
			res.end(e.message);
		}
	}

	return { claims, handle, start, close, up: () => !!(backend && backend.ok) };
}

module.exports = { createViewer };
