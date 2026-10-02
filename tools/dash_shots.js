"use strict";
// Screenshots of every dashboard view, and layout checks on each, to compare a page change before and after. It
// serves the page from a scratch copy of a live dir (its runs without recordings; scratch pulls, setups, players' and accounts folders,
// CODE library, gear sets; no token), never the dashboard in use, and only opens forms and confirms (always cancelled), so nothing starts or moves.
//   node tools/dash_shots.js --out DIR [--src live] [--sizes 1366x768,1920x1080] [--themes dark,light] [--only a,b]
//   node tools/dash_shots.js --serve PORT [--src live]   (the scratch dashboard alone, to look at by hand, until killed)
// Views: the Runs page; each tab of a run's page (the run with the most characters) and of a group's; Compare of 3 runs;
// Compare of the two groups with the most runs, and its tabs (picked-*); the Remove and Remove finished confirms; New
// sim (a character's editor, the item picker, an item and a slot hovered, the inventory's picker); Rerun; CODE;
// Accounts; Settings.
// Checks: the page scrolls sideways; an element clips or scrolls its content sideways (text cut with an ellipsis is
// listed apart, as "truncated"); a table cell's text runs out of its cell; opening a confirm or the picker moves
// other things. Writes DIR/<size>-<theme>/<view>.png and DIR/report.json; exits 1 when a check fails.
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	http = require("node:http");

const arg = (name, def) => {
	const i = process.argv.indexOf("--" + name);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const OUT = arg("out", null), SERVE = arg("serve", null);
if (!OUT && !SERVE) {
	console.error("usage: node tools/dash_shots.js --out DIR [--src live] [--sizes 1366x768,1920x1080] [--themes dark,light] [--only view,...]");
	process.exit(2);
}
const SIZES = arg("sizes", "1366x768,1920x1080").split(",").map((s) => s.split("x").map(Number));
const THEMES = arg("themes", "dark,light").split(",");
const ONLY = arg("only", null) && new Set(arg("only").split(","));

// the scratch world: the runs' files without recordings, removed runs or logs; pulls, setups, players' pages, accounts,
// the CODE library and gear sets copied; no token
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dash-shots-"));
const { config } = require("../lib/config");
const C = config({ cli: { live_dir: arg("src", null) } });
const skip = (p) => /\.rec$/.test(p) || ["removed", "logs"].includes(path.basename(p));
fs.cpSync(C.live_dir, path.join(scratch, "live"), { recursive: true, filter: (p) => p === C.live_dir || !skip(p) });
for (const [k, env] of [["pulls_dir", "CHRONAL_PULLS_DIR"], ["setups_dir", "CHRONAL_SETUPS_DIR"], ["players_dir", "CHRONAL_PLAYERS_DIR"], ["accounts_dir", "CHRONAL_ACCOUNTS_DIR"], ["library_dir", "CHRONAL_LIBRARY_DIR"], ["gear_sets_dir", "CHRONAL_GEAR_SETS_DIR"]]) {
	const to = path.join(scratch, k);
	if (C[k] && fs.existsSync(C[k])) fs.cpSync(C[k], to, { recursive: true });
	else fs.mkdirSync(to);
	process.env[env] = to;
}
process.env.CHRONAL_AL_TOKEN_FILE = path.join(scratch, "no-token");
delete process.env.CHRONAL_AL_TOKEN;
const { createDashboard } = require("../dashboard/server");
const { chromium } = require("playwright");

// ---- in the page: the checks
function checkLayout() {
	const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
	const name = (e) => {
		const t = (e.innerText || e.value || "").trim().replace(/\s+/g, " ").slice(0, 60);
		return e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].join(".") : "") + (t ? ' "' + t + '"' : "");
	};
	const out = { pageScroll: document.documentElement.scrollWidth > innerWidth + 1 ? document.documentElement.scrollWidth - innerWidth : 0, clipped: [], truncated: [], cells: [] };
	for (const e of document.querySelectorAll(".side *, #main *")) {
		if (!vis(e) || e.tagName === "INPUT" || e.closest(".CodeMirror")) continue; // (a field, the CODE editor: scroll their own text)
		const s = getComputedStyle(e);
		if (s.overflowX === "visible" || e.scrollWidth <= e.clientWidth + 1) continue;
		(s.textOverflow === "ellipsis" ? out.truncated : out.clipped).push(name(e) + " by " + (e.scrollWidth - e.clientWidth) + " px");
	}
	// a cell's text past its edges, where nothing inside the cell clips it
	for (const td of document.querySelectorAll(".side td, .side th, #main td, #main th")) {
		if (!vis(td)) continue;
		const b = td.getBoundingClientRect(), tw = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
		for (let n = tw.nextNode(); n; n = tw.nextNode()) {
			if (!n.textContent.trim()) continue;
			let clip = false;
			for (let a = n.parentElement; a && a !== td; a = a.parentElement) if (getComputedStyle(a).overflowX !== "visible") { clip = true; break; }
			if (clip) continue;
			const r = document.createRange();
			r.selectNodeContents(n);
			const past = Math.max(0, ...[...r.getClientRects()].map((q) => Math.max(q.right - b.right, b.left - q.left)));
			if (past > 1) { out.cells.push('"' + n.textContent.trim().slice(0, 50) + '" ' + Math.round(past) + " px out of its cell"); break; }
		}
	}
	return out;
}
// where things are, by selector and index (the page redraws with new elements), in their scroll container's content (a
// scroll isn't a move; a sticky one moves with it)
const LANDMARKS = [".nav > *", "#runs", ".rfilt", "#rtab tr", "#panel", "#panel .ph", "#panel .wt", "#nsim .nsec", "#nsim h5", "#nsim .nbar"];
function landmarks(sels) {
	const o = {};
	const sc = (e) => { let x = scrollX, y = scrollY; for (let a = e.parentElement; a; a = a.parentElement) (x += a.scrollLeft), (y += a.scrollTop); return [x, y]; };
	for (const s of sels) document.querySelectorAll(s).forEach((e, i) => { const r = e.getBoundingClientRect(), [x, y] = sc(e); if ((r.width || r.height) && getComputedStyle(e).position !== "sticky") o[s + "[" + i + "]"] = [r.x + x, r.y + y, r.width, r.height].map(Math.round); });
	return o;
}
const moved = (a, b) => Object.keys(a).filter((k) => b[k] && a[k].some((v, i) => Math.abs(v - b[k][i]) > 1)).map((k) => k + " " + a[k].join(",") + " -> " + b[k].join(","));

(async () => {
	const srv = http.createServer(createDashboard({ dir: path.join(scratch, "live"), host: "127.0.0.1" }).handle);
	await new Promise((r) => srv.listen(Number(SERVE) || 0, "127.0.0.1", r));
	const base = "http://127.0.0.1:" + srv.address().port + "/";
	if (SERVE) {
		console.log("scratch dashboard on " + base + " (reading " + path.join(scratch, "live") + ")");
		const bye = () => { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(0); };
		process.on("SIGINT", bye).on("SIGTERM", bye);
		return;
	}
	const browser = await chromium.launch();
	const report = [];
	let fails = 0;
	try {
		for (const [W, H] of SIZES) for (const theme of THEMES) {
			const dir = path.join(OUT, W + "x" + H + "-" + theme);
			fs.mkdirSync(dir, { recursive: true });
			const page = await browser.newPage({ viewport: { width: W, height: H } });
			const settle = (ms = 1200) => page.waitForTimeout(ms);
			const load = async (hash = "#/runs") => { await page.goto(base + "?theme=" + theme + hash, { waitUntil: "networkidle" }); await settle(1500); };
			const want = (v) => !ONLY || ONLY.has(v) || ONLY.has(v.replace(/-.*/, ""));
			const record = async (view, extra = {}, full = true) => {
				await page.mouse.move(0, 0);
				const r = { view, size: W + "x" + H, theme, ...(await page.evaluate(checkLayout)), ...extra };
				await page.screenshot({ path: path.join(dir, view + ".png"), fullPage: full });
				const bad = (r.pageScroll ? 1 : 0) + r.clipped.length + r.cells.length + (r.shift ? r.shift.length : 0);
				r.ok = !bad; fails += bad ? 1 : 0;
				report.push(r);
				console.log((bad ? "FAIL " : "ok   ") + r.size + " " + theme + " " + view + (bad ? ": " + [r.pageScroll ? "page scrolls sideways " + r.pageScroll + " px" : "", r.clipped.length ? r.clipped.length + " clipped" : "", r.cells.length ? r.cells.length + " cells overflow" : "", r.shift && r.shift.length ? r.shift.length + " moved" : ""].filter(Boolean).join(", ") : ""));
			};
			// the action's effect on everything else: before, act, after (then undo)
			const shiftOf = async (act, undo, sels = LANDMARKS) => {
				const a = await page.evaluate(landmarks, sels);
				await act(); await settle(600);
				const b = await page.evaluate(landmarks, sels);
				return { shift: moved(a, b), undo };
			};
			const enc = encodeURIComponent;

			await load();
			if (want("runs")) await record("runs");
			// the run with the most characters (its party's pips); the groups by their count of runs
			const runId = await page.evaluate(() => {
				const rs = [...document.querySelectorAll("#rtab tr.run:not(.gmem)")];
				rs.sort((a, b) => b.querySelectorAll(".pp").length - a.querySelectorAll(".pp").length);
				return rs[0] && rs[0].dataset.row;
			});
			const gids = await page.evaluate(() => [...document.querySelectorAll("#rtab tr.grp [data-gtog]")].map((b) => ({ id: b.dataset.gtog, n: +((/(\d+) runs/.exec(b.dataset.tip) || [])[1] || 0) })).sort((a, b) => b.n - a.n).map((x) => x.id));
			const tabs = [["chars", "characters"], ["data", "data"], ["buffs", "buffs"], ["supply", "supply"], ["monsters", "monsters"], ["run", "run"]];
			for (const [kind, id] of [["run", runId], ["group", gids[0]]]) {
				if (!id) continue;
				for (const [k, v] of tabs) if (want(kind + "-" + v)) { await load("#/runs/" + enc(id) + "/" + k); await record(kind + "-" + v); }
			}
			// Compare of 3 runs (picked in the list, then Compare), and the confirms (cancelled)
			if (want("compare")) {
				const cks = page.locator("#rtab tr.run:not(.gmem) input[data-ck]");
				for (let i = 0; i < Math.min(3, await cks.count()); i++) { await cks.nth(i).click(); await settle(500); }
				if (await page.locator("#pickbar a.go").count()) { await page.locator("#pickbar a.go").click(); await settle(); await record("compare"); }
			}
			if (want("confirm-remove") && runId) {
				await load("#/runs/" + enc(runId));
				const s = await shiftOf(() => page.locator("#panel [data-tremove]").click());
				await record("confirm-remove", { shift: s.shift }, false);
				await page.locator("[data-tno]").click(); await settle(400);
			}
			if (want("confirm-clear")) {
				await load();
				if (await page.locator("#clear").count()) {
					const s = await shiftOf(() => page.locator("#clear").click());
					await record("confirm-clear", { shift: s.shift }, false);
					await page.locator("#clear-no").click(); await settle(400);
				}
			}
			// Compare of the two groups with the most runs (the deltas past the noise), then its tabs
			if (gids.length >= 2) {
				const ids = gids.slice(0, 2).map(enc).join(",");
				if (want("compare-groups")) { await load("#/compare?ids=" + ids); await record("compare-groups"); }
				for (const [k, v] of tabs) if (want("picked-" + v)) { await load("#/compare/" + k + "?ids=" + ids); await record("picked-" + v); }
			}
			// New sim: the form, a character's editor, the item picker, an item hovered, the inventory's, the gear sets
			if (want("new")) {
				await load("#/new"); await settle(3000);
				await record("new-form", {}, false);
				if ((await page.locator("#nsim [data-nedit]").count()) < 2) {
					const off = page.locator("#nsim .nochip"); // (an Out character: a click brings it in game)
					if (await off.count()) { await off.first().click(); await settle(2500); }
				}
				const ed = page.locator("#nsim [data-nedit]").last();
				if (await ed.count()) {
					await ed.click(); await settle(2500);
					const top = (sel) => page.locator(sel).first().evaluate((e) => e.scrollIntoView({ block: "start" }));
					await top("#nsim .ned");
					await record("new-editor", {}, false);
					const slot = page.locator("#nsim [data-nslot=mainhand]");
					const s = await shiftOf(async () => { await slot.click(); await settle(2000); });
					await top("#nsim .ned");
					await record("new-picker", { shift: s.shift }, false);
					const it = page.locator("#nsim .ipk [data-npick]").nth(2);
					if (await it.count()) { await it.hover(); await settle(800); await page.screenshot({ path: path.join(dir, "new-picker-hover.png") }); }
					await page.keyboard.press("Escape"); await settle(600);
					await page.locator("#nsim [data-nslot=helmet]").hover(); await settle(800);
					await page.screenshot({ path: path.join(dir, "new-slot-hover.png") });
					// the inventory's: a search for potions
					const add = page.locator("#nsim [data-ninvadd]");
					const s2 = await shiftOf(async () => { await add.click(); await settle(800); await page.keyboard.type("pot"); await settle(1200); });
					await record("new-inventory", { shift: s2.shift }, false);
					await page.keyboard.press("Escape"); await settle(600);
					const s3 = await shiftOf(async () => { await page.locator("#nsim [data-nslot=set]").click(); await settle(1500); });
					await top("#nsim .ned");
					await record("new-gearsets", { shift: s3.shift }, false);
				}
			}
			// Rerun of the run
			if (want("rerun") && runId) { await load("#/new?from=" + enc(runId)); await settle(2500); await record("rerun", {}, false); }
			// Gear sets: every set, one open (a built-in one: read-only)
			if (want("gearsets")) { await load("#/gearsets"); await settle(2000); await record("gearsets", {}, false); await load("#/gearsets/ranger-mid"); await settle(2000); await record("gearset", {}, false); }
			// Accounts, Settings
			if (want("code")) { await load("#/code/example/fighter.js"); await settle(2500); await record("code", {}, false); }
			if (want("accounts")) { await load("#/accounts"); await settle(); await record("accounts"); }
			if (want("settings")) { await load("#/settings"); await settle(); await record("settings"); }
			await page.close();
		}
	} finally {
		fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
		await browser.close();
		srv.close();
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	console.log(report.length + " views, " + fails + " with failed checks; " + path.join(OUT, "report.json"));
	process.exit(fails ? 1 : 0);
})().catch((e) => {
	console.error(e);
	fs.rmSync(scratch, { recursive: true, force: true });
	process.exit(2);
});
