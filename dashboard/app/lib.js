// The dashboard's plain helpers (no drawing): numbers and times as the pages write them, the dashboard's requests, the
// statistics over runs, what this browser remembers.
export const H = 3600e3;
export const fmtG = (ms) => { const m = Math.round(ms / 60000); return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0"); };
export const fmtN = (v, d = 1) => v == null || !isFinite(v) ? "-" : v === 0 ? "0" : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(d) + "B" : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(d) + "M" : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(0) + "k" : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(d);
export const hms = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 3600) + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
export const hm = (s) => Math.floor(s / 3600) + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0");
export const pct = (v) => (v == null ? "-" : Math.round(v * 100) + "%");
// a share of time: never "0%" or "100%" when it wasn't
export const pctU = (v) => (v > 0 && v < 0.005 ? "<1%" : v < 1 && v > 0.995 ? ">99%" : pct(v));
export const num = (v) => (Number.isFinite(v) ? v : 0);
export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const r2 = (v) => String(+(+v).toFixed(2));
export const short = (s, n = 80) => (s.length > n ? s.slice(0, n) + "..." : s);
export const nice = (v) => { if (!(v > 0)) return 1; const e = 10 ** Math.floor(Math.log10(v)); for (const m of [1, 1.2, 1.5, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * e >= v * 0.999) return m * e; };
export const tick = (v) => fmtN(v).replace(/\.0(?=\D|$)/, "");
export const dur = (s) => (s < 90 ? Math.round(s) + " s" : s < 5400 ? Math.round(s / 60) + " min" : +(s / 3600).toFixed(1) + " h");
// the sum of f over xs, null when none of them measured it
export const tot = (xs, f) => xs.reduce((a, x) => { const v = f(x); return v != null && isFinite(v) ? (a || 0) + v : a; }, null);
export const ratio = (xs, a, b) => { const n = tot(xs, a), d = tot(xs, b); return n != null && d > 0 ? n / d : null; };
// game time as the setups write it: 0m, 90s, 30m, 2h, 1d
const UNIT = { d: 86400e3, h: H, m: 60e3 };
export const fmtSpan = (ms) => (ms === 0 ? "0m" : Object.keys(UNIT).map((u) => ms % UNIT[u] === 0 && ms / UNIT[u] + u).find(Boolean) || +(ms / 1e3).toFixed(3) + "s");
export const parseSpan = (s) => { const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(s)); return m ? +m[1] * (m[2] === "s" ? 1e3 : UNIT[m[2]]) : null; };
export const jp = (v) => { if (v === undefined) return undefined; try { return JSON.parse(v); } catch (e) { return v; } };
export const ORD = (n) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
export const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60e3); return m < 1 ? "just now" : m < 90 ? m + " min ago" : m < 36 * 60 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago"; };
// when a run started: its time today, else its date too
export const startedText = (w) => { const d = new Date(w.started); if (isNaN(d)) return "-"; const p = (n) => String(n).padStart(2, "0"); return (d.toDateString() === new Date().toDateString() ? "" : p(d.getMonth() + 1) + "-" + p(d.getDate()) + " ") + p(d.getHours()) + ":" + p(d.getMinutes()); };

// ---- a run
export const seedOf = (w) => (w.run && w.run.seed != null ? w.run.seed : null);
// the world age (world.age_ms) when there was one: game time the world ran with no characters before they logged in
export const wageOf = (w) => (w.world && Number.isFinite(w.world.age_ms) ? w.world.age_ms : 0);
export const live_ = (w) => w.state === "running" || w.state === "stalled";
export const codeOf = (w) => (w.versions && w.versions.code_hash) || null;
// The party: every character of the run, the merchant too, in roster order (else party.members first, then as listed)
const rank_ = (a, x) => { const i = a.indexOf(x); return i < 0 ? 1e9 : i; };
export function membersOf(w) {
	const order = w.roster && w.roster.length ? w.roster.map((r) => r.name) : (w.party && w.party.members) || [];
	return [...w.players].sort((a, b) => rank_(order, a.name) - rank_(order, b.name));
}
export const CLASSES = ["ranger", "priest", "paladin", "warrior", "mage", "rogue", "merchant"];
export const cvar = (type) => "--c:" + (CLASSES.includes(type) ? "var(--c-" + type + ")" : "var(--muted)");
// the status as the filters name it: running (stalled too), done, stopped (killed, or stopped early), failed; its colour
export const catOf = (w) => (w.state === "running" || w.state === "stalled" ? "running" : w.state === "failed" ? "failed" : w.state === "stopped" || (w.end && w.end.reason === "stopped") ? "stopped" : "done");
export const CATDOT = { running: "running", done: "", stopped: "stopped", failed: "bad" };
export const CAT_ORDER = { running: 0, stopped: 1, failed: 2, done: 3 };
export function stateText(w) {
	const e = w.end || {}, r = w.run || {}, ago = Math.round((Date.now() - Date.parse(w.updated)) / 1000), rm = w.ctl && w.ctl.remove_when_done ? "; removed once it has ended" : "";
	if (w.state === "running") return "running" + rm;
	if (w.state === "stalled") return "running, no update for " + ago + " s" + rm;
	if (w.state === "stopped") return "stopped: the process ended without a final snapshot" + rm;
	if (w.state === "failed") return "failed" + (e.detail ? ": " + e.detail : "") + rm;
	if (e.reason === "stopped") return "stopped early" + (r.duration_ms ? " at " + fmtG(w.measured_ms || 0) + " of " + fmtG(r.duration_ms) : "") + (e.detail ? " (" + e.detail + ")" : "");
	return "done";
}
// a running run's progress through its planned game time
export const progOf = (w) => (live_(w) && w.run && w.run.duration_ms > 0 ? clamp01((w.measured_ms || 0) / w.run.duration_ms) : null);

// ---- the dashboard's requests (x-dashboard: the server's check that the page asks, not another site)
export const api = (url, method, body) => fetch(url, { method, headers: { "x-dashboard": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
// a request's answer: { ok, status, body }
export async function call(url, method, body) {
	try {
		const r = await (method ? api(url, method, body) : fetch(url));
		return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
	} catch (e) {
		return { ok: false, status: 0, body: { reason: e.message } };
	}
}
export const why = (r) => r.body.reason || "HTTP " + r.status;

// ---- remembered in this browser (a read or write that fails: as if nothing were)
export const load = (k, def, f = (x) => x) => { try { const v = localStorage.getItem(k); return v == null ? def : f(v); } catch (e) { return def; } };
export const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// ---- statistics over runs: mean, sample sd, Welch's t-test
export const mean = (xs) => xs.reduce((a, v) => a + v, 0) / xs.length;
const sdev = (xs) => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1)); };
export function agg(xs) { const v = xs.filter((x) => x != null && isFinite(x)); return { n: v.length, mean: v.length ? mean(v) : null, sd: sdev(v), vals: v }; }
function lgamma(x) {
	const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
	let y = x, s = 1.000000000190015, t = x + 5.5;
	t -= (x + 0.5) * Math.log(t);
	for (const k of c) s += k / ++y;
	return -t + Math.log((2.5066282746310005 * s) / x);
}
// the regularized incomplete beta function I_x(a, b) (a continued fraction, as Numerical Recipes' betai)
function ibeta(x, a, b) {
	if (!(x > 0)) return 0;
	if (x >= 1) return 1;
	const cf = (x, a, b) => {
		const tiny = 1e-30, fix = (v) => (Math.abs(v) < tiny ? tiny : v);
		let c = 1, d = 1 / fix(1 - ((a + b) * x) / (a + 1)), h = d;
		for (let m = 1; m <= 300; m++) {
			let aa = (m * (b - m) * x) / ((a - 1 + 2 * m) * (a + 2 * m));
			d = 1 / fix(1 + aa * d); c = fix(1 + aa / c); h *= d * c;
			aa = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 1 + 2 * m));
			d = 1 / fix(1 + aa * d); c = fix(1 + aa / c);
			const del = d * c; h *= del;
			if (Math.abs(del - 1) < 3e-12) break;
		}
		return h;
	};
	const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
	return x < (a + 1) / (a + b + 2) ? (bt * cf(x, a, b)) / a : 1 - (bt * cf(1 - x, b, a)) / b;
}
// Welch's t-test of two agg()s: the two-sided p, null with fewer than 2 values on a side
export function welch(a, b) {
	if (!a || !b || a.n < 2 || b.n < 2) return null;
	const va = a.sd ** 2 / a.n, vb = b.sd ** 2 / b.n, se = Math.sqrt(va + vb);
	if (!(se > 0)) return a.mean === b.mean ? 1 : 0;
	const t = (a.mean - b.mean) / se, df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
	return ibeta(df / (df + t * t), df / 2, 0.5);
}
