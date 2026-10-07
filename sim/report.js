"use strict";
// What CODE reports about itself (docs/reference/reporting.md): the optional chronal object, kept current by
// the CODE and only read here. Each field is a plain value or a pure getter (no timers, emits, game actions,
// Math.random, promises, or writes to game or CODE state):
//   self.chronal = { mode: "farm" | () => string, status: {...} | () => ({...}), role: "dps" | "tank" | "healer" | "merchant" | "support" }
// Nothing else of a CODE is read: CODE without chronal reports nothing (a CODE with its own structure reports through
// an adapter file its run setups append (docs/how-to/run-your-code.md).
// In the sim every read that may call into CODE goes through guarded(): the contexts' Math.random and the clock's rng
// are put back after the call, and a call that scheduled a timer, emitted, made a promise or wrote to the game log is
// reported (the caller stops calling that getter).
const { promiseCount } = require("./vclock");

const STATUS_MS = 10_000; // virtual ms between status/role reads
const STATUS_MAX = 64 << 10; // bytes of JSON; a larger status reads as { truncated: true, bytes }
const ROLES = ["dps", "tank", "healer", "merchant", "support"];
// guarded()'s reasons, for notes.chronal
const WHY = { timer: "scheduled a timer", emit: "emitted", promise: "made a promise", log: "wrote to the game log" };

const field = (s, k) => {
	const v = s[k];
	return typeof v === "function" ? v.call(s) : v;
};
const str = (v) => (v == null ? null : String(v));

/** The CODE's mode: { v: string | null, from: "chronal" | null } */
function readMode(win) {
	const s = win && win.chronal;
	return s ? { v: str(field(s, "mode")), from: "chronal" } : { v: null, from: null };
}

/** The CODE's status tree as plain JSON: { v: object | null, from } */
function readStatus(win) {
	const s = win && win.chronal;
	if (!s) return { v: null, from: null };
	const json = JSON.stringify(field(s, "status"));
	if (json === undefined) return { v: null, from: "chronal" };
	const bytes = Buffer.byteLength(json);
	return { v: bytes > STATUS_MAX ? { truncated: true, bytes } : JSON.parse(json), from: "chronal" };
}

/** The CODE's role (one of ROLES, else null): chronal.role */
function readRole(win) {
	const s = win && win.chronal;
	if (!s) return { v: null, from: null };
	const v = field(s, "role");
	return { v: ROLES.includes(v) ? v : null, from: "chronal" };
}

// For client queries in the game window (start.js STAT): the mode by readMode's rule, "?" without chronal
const modeExpr = `(function (r) { var s = r && r.chronal; if (!s) return "?"; var v = s.mode; if (typeof v === "function") v = v.call(s); return v == null ? null : String(v); })(window.__runner)`;

/**
 * Calls fn (a read of CODE state) so that it cannot shift the run: every context's Math.random and clock.rng are put
 * back afterwards. impure: "emit" (hub.out grew), "timer" (the clock scheduled something), "promise", "log" (the game
 * log grew), "threw" (value null), else null. It cannot undo what an impure call did.
 * @param {object[]} ctxs  the character's contexts (game window, CODE runner)
 */
function guarded(ctxs, clock, hub, fn) {
	const rngs = [],
		logs = () => ctxs.reduce((n, c) => n + (c && Array.isArray(c.game_logs) ? c.game_logs.length : 0), 0);
	for (const r of [...ctxs.map((c) => c && c.Math && c.Math.random), clock.rng]) if (r && typeof r.state === "function") rngs.push([r, r.state()]);
	const seq = clock.seq,
		id = clock.nextId,
		out = hub && hub.out ? hub.out.length : 0,
		p0 = promiseCount(),
		l0 = logs();
	let value = null,
		threw = false;
	try {
		value = fn();
	} catch (e) {
		threw = true;
	}
	for (const [r, s] of rngs) r.restore(s);
	const impure = hub && hub.out && hub.out.length !== out ? "emit" : clock.seq !== seq || clock.nextId !== id ? "timer" : promiseCount() !== p0 ? "promise" : logs() !== l0 ? "log" : threw ? "threw" : null;
	return { value, impure };
}

// The game log's new lines (window.game_logs: [message, color], bot mode keeps them all; clear_game_logs() makes a new
// array): a tap per page -> tap(win) = [[kind, text]] since its last call. kind "pageerror" for the error colours (a
// CODE's uncaught error, the game's code_error), else ""; text without HTML, at most LOG_TEXT characters.
const LOG_ERR = new Set(["#ff0000", "#e13758", "red"]),
	LOG_TEXT = 300,
	LOG_KEEP = 30; // lines a snapshot keeps per character
function logTap() {
	let arr = null,
		i = 0;
	return (win) => {
		const a = win && win.game_logs;
		if (!Array.isArray(a)) return [];
		if (a !== arr || a.length < i) (arr = a), (i = 0);
		const out = [];
		for (; i < a.length; i++) {
			const l = a[i] || [];
			out.push([LOG_ERR.has(String(l[1] || "").toLowerCase()) ? "pageerror" : "", String(l[0] ?? "").replace(/<[^>]*>/g, "").slice(0, LOG_TEXT)]);
		}
		return out;
	};
}

/** What a sim prints of its warnings and errors (its own, its server's, its pages' and their CODE's): each distinct message
 * once, a repeat counted; flush() prints "<label>: N more of: <message>" for those (at the end of the run or the
 * thread). silent: nothing printed (tests that make errors on purpose: they read them from messages, the last 500, or
 * the game log). print(kind, text) writes one. */
function onceConsole(print, { silent = false, label = "" } = {}) {
	const seen = new Map(),
		messages = [];
	const say = (kind, text) => {
		messages.push({ kind, text });
		if (messages.length > 500) messages.shift();
		if (silent) return;
		const n = seen.get(text);
		if (n === undefined) return void (seen.set(text, 0), print(kind, text));
		seen.set(text, n + 1);
	};
	const flush = () => {
		for (const [text, n] of seen) if (n) print("warn", `[sim]${label ? " " + label + ":" : ""} ${n} more of: ${text.length > 200 ? text.slice(0, 200) + "..." : text}`);
		seen.clear();
	};
	return { say, flush, messages };
}

module.exports = { onceConsole, readMode, readStatus, readRole, modeExpr, guarded, logTap, LOG_TEXT, LOG_KEEP, STATUS_MS, STATUS_MAX, ROLES, WHY };
