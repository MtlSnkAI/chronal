// The Accounts page (#/accounts): every account a run can play on, in one place. Yours: the live account as pulled
// (its CODE: the pull's slots, set pull:<account>; Pull now refreshes it). Crafted: accounts made here (lib/accounts.js:
// their characters' class, level and gear, their age and CODE), edited here or in New sim (Save as account). Other
// players': their public pages taken, read-only. Each starts a New sim with its characters; each can be removed (asked
// again first).
import { h } from "./vendor/preact.js";
import { useState, useEffect } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { cvar, fmtN, ago, call, why } from "./lib.js";
import { pollSoon } from "./store.js";
import { skIcon, iconFit, CLASS_SKILL } from "./art.js";

const html = htm.bind(h);

// a character as a chip: its class icon, name, level (its gear's icons when it has some)
const Char = ({ c }) => html`<span class="achr" style=${cvar(c.class)} data-tip=${c.class + " L" + c.level + (c.gear ? "\n" + Object.entries(c.gear).map(([k, v]) => k + ": " + v).join("\n") : "")}>
	${skIcon(CLASS_SKILL[c.class], 16)}<b>${c.name}</b><span class="gu">L${c.level}</span>${c.gear ? Object.values(c.gear).filter((v) => v !== "none").slice(0, 6).map((v) => iconFit(v.replace(/[+:#].*$/, ""), 16)) : null}</span>`;

// a removal, asked again: Remove, then what goes (or Keep)
export function Del({ label = "Remove", what, go }) {
	const [arm, setArm] = useState(false);
	return arm ? [html`<button type="button" class="danger" onClick=${() => (setArm(false), go())}>${what}</button>`, html`<button type="button" class="cb" onClick=${() => setArm(false)}>Keep</button>`]
		: html`<button type="button" class="lnk sm" onClick=${() => setArm(true)}>${label}</button>`;
}

export function AccountsPage() {
	const [nf, setNf] = useState(null);
	const load = async () => {
		const r = await call("api/new");
		setNf(r.ok && r.body.ok ? r.body : { error: r.ok ? r.body.reason : why(r) });
	};
	useEffect(() => void load(), []);
	if (!nf) return html`<div class="page"><h2>Accounts</h2><p class="mnote">loading...</p></div>`;
	if (nf.error) return html`<div class="page"><h2>Accounts</h2><p class="nbad">${nf.error}</p></div>`;
	return html`<div class="page">
		<h2>Accounts</h2>
		<p class="gu">The accounts a run can play on. An account owns its CODE, as on live: its characters run it unless a run picks another set for one of them (New sim, a character's CODE).</p>
		<${Yours} nf=${nf} reload=${load} />
		<${Crafted} nf=${nf} reload=${load} />
		<${Players} nf=${nf} reload=${load} />
	</div>`;
}

// ---- yours: the pulls, by account (the newest first), its CODE, Pull now
function Yours({ nf, reload }) {
	const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
	const by = new Map();
	for (const p of nf.pulls) (by.get(p.account) || by.set(p.account, []).get(p.account)).push(p);
	const pull = async () => {
		setBusy(true); setMsg(null);
		const r = await call("api/new/pull", "POST", {});
		setBusy(false);
		setMsg(r.ok ? { text: "Pulled " + r.body.id + (r.body.warnings && r.body.warnings.length ? ": " + r.body.warnings.join("; ") : "") } : { text: why(r), bad: true });
		if (r.ok) (reload(), pollSoon());
	};
	const set = (a) => nf.code_sets.find((x) => x.name === "pull:" + a);
	// its pulls removed (older: all but the newest), their CODE with them
	const del = async (a, older) => {
		const r = await call("api/pulls/" + encodeURIComponent(a) + (older ? "?older=1" : ""), "DELETE");
		setMsg(r.ok ? { text: "Removed " + (older ? r.body.removed + " older " + (r.body.removed === 1 ? "pull" : "pulls") + " of " + a : a + " (" + r.body.removed + (r.body.removed === 1 ? " pull" : " pulls") + ")") } : { text: why(r), bad: true });
		reload();
	};
	return html`<section class="paf card">
		<div class="frow"><h3>Yours</h3><span class="gu">your live account, as pulled</span>
			${nf.token ? html`<button type="button" class="cb" disabled=${busy} onClick=${pull}>${busy ? "Pulling (about 15 s)..." : "Pull now"}</button>` : html`<a class="lnk sm" href="#/settings">Set up the token to pull it</a>`}</div>
		${msg && html`<p class=${msg.bad ? "nbad" : "hint"}>${msg.text}</p>`}
		${!by.size ? html`<p class="mnote">No pull yet.${nf.token ? " Pull now reads it (read-only)." : ""}</p>` : [...by].map(([a, ps]) => {
			const p = ps[0], s = set(a);
			return html`<div class="acard">
				<div class="frow"><b>${a}</b><span class="gu">pulled ${ago(p.pulled_at)}${ps.length > 1 ? ", " + ps.length + " pulls" : ""}</span>
					${p.bank && html`<span class="gu">bank ${fmtN(p.bank.gold)} gold</span>`}${p.account_age && p.account_age.days != null && html`<span class="gu">${p.account_age.days} days old</span>`}
					<a class="cb" href=${"#/new?pull=" + encodeURIComponent(p.id)}>New sim with it</a>
					${ps.length > 1 ? html`<${Del} label="Remove older pulls" what=${"Remove its " + (ps.length - 1) + " older " + (ps.length === 2 ? "pull" : "pulls")} go=${() => del(a, true)} />` : null}
					<${Del} what=${"Remove " + a + ": " + (ps.length === 1 ? "its pull and its CODE" : "its " + ps.length + " pulls and their CODE")} go=${() => del(a, false)} /></div>
				<div class="achrs">${p.characters.map((c) => html`<${Char} c=${c} />`)}</div>
				<div class="frow"><span class="fl">CODE</span>${s ? html`<span><b>${s.name}</b><span class="gu"> ${s.files != null ? s.files + " slots" : ""}: each character runs its own slot, as on live</span></span>` : html`<span class="gu">not pulled (chronal pull --no-code)</span>`}</div>
			</div>`;
		})}
	</section>`;
}

// ---- crafted: made here; an editor (name, age, CODE, characters: name, class, level; gear: in New sim)
const blank = () => ({ name: "", age_days: 0, code: "", characters: [{ name: "", class: "ranger", level: 60 }] });
function Crafted({ nf, reload }) {
	const [edit, setEdit] = useState(null); // { a: the account edited, was: its name before (null: a new one) }
	const [msg, setMsg] = useState(null);
	const [arm, setArm] = useState(null); // the one whose Remove asks again
	const remove = async (name) => {
		const r = await call("api/accounts/" + encodeURIComponent(name), "DELETE");
		setArm(null); setMsg(r.ok ? { text: "Removed " + name } : { text: why(r), bad: true });
		reload();
	};
	return html`<section class="paf card">
		<div class="frow"><h3>Crafted</h3><span class="gu">accounts made here: their characters start as new ones of their class and level, in their gear</span>
			${!edit && html`<button type="button" class="cb" onClick=${() => (setEdit({ a: blank(), was: null }), setMsg(null))}>New account</button>`}</div>
		${msg && html`<p class=${msg.bad ? "nbad" : "hint"}>${msg.text}</p>`}
		${edit && html`<${Editor} nf=${nf} edit=${edit} done=${(text) => (setEdit(null), text && setMsg({ text }), reload())} />`}
		${!nf.accounts.length && !edit ? html`<p class="mnote">None yet: New account here, or Save as account on an account of new characters in New sim.</p>` : ""}
		${nf.accounts.map((a) => html`<div class="acard">
			<div class="frow"><b>${a.name}</b>
				${a.problems ? html`<span class="nbad">${a.problems.join("; ")}</span>` : html`<span class="gu">${a.age_days} days old</span><span class="gu">CODE ${a.code || "the run's"}</span>`}
				${!a.problems && html`<a class="cb" href=${"#/new?account=" + encodeURIComponent(a.name)}>New sim with it</a>`}
				${!a.problems && html`<button type="button" class="cb" onClick=${() => (setEdit({ a: JSON.parse(JSON.stringify(a)), was: a.name }), setMsg(null))}>Edit</button>`}
				${arm === a.name ? html`<button type="button" class="danger" onClick=${() => remove(a.name)}>Remove ${a.name}</button><button type="button" class="cb" onClick=${() => setArm(null)}>Keep</button>` : html`<button type="button" class="lnk sm" onClick=${() => setArm(a.name)}>Remove</button>`}</div>
			${a.characters && html`<div class="achrs">${a.characters.map((c) => html`<${Char} c=${c} />`)}</div>`}
		</div>`)}
	</section>`;
}
function Editor({ nf, edit, done }) {
	const [a, setA] = useState(edit.a), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
	const ch = (i, k, v) => setA({ ...a, characters: a.characters.map((c, j) => (j === i ? { ...c, [k]: v } : c)) });
	const save = async () => {
		const account = { ...a, name: a.name.trim(), age_days: Number(a.age_days) || 0, code: a.code || null, characters: a.characters.map((c) => ({ ...c, name: c.name.trim(), level: Number(c.level) })) };
		setBusy(true);
		const r = await call("api/accounts/" + encodeURIComponent(account.name || "-"), "PUT", { account, ...(edit.was ? { was: edit.was } : {}) });
		setBusy(false);
		if (!r.ok) return setErr(r.body.problems ? r.body.problems.join("; ") : why(r));
		done("Saved " + account.name);
	};
	const sets = nf.code_sets.filter((s) => s.group !== "pulls");
	return html`<div class="acard aed">
		<div class="frow"><span class="fl">Name</span><input type="text" maxlength="24" value=${a.name} aria-label="The account's name" onInput=${(e) => setA({ ...a, name: e.target.value })} />
			<span class="fl">Age</span><input type="text" inputmode="numeric" class="sn" value=${a.age_days} aria-label="Its age in days" data-tip="days: under 40, the New Player bonus (0: a new account)" onInput=${(e) => setA({ ...a, age_days: e.target.value })} /><span class="gu">days</span></div>
		<div class="frow"><span class="fl">CODE</span><select aria-label="Its CODE set" value=${a.code || ""} onChange=${(e) => setA({ ...a, code: e.target.value })}>
			<option value="">the run's (New sim's CODE for all)</option>${sets.map((s) => html`<option value=${s.name}>${s.name}${s.group === "builtin" ? " (ChronAL's)" : s.group === "others" ? " (library)" : ""}</option>`)}</select></div>
		${a.characters.map((c, i) => html`<div class="frow"><span class="fl">${i ? "" : "Characters"}</span>
			<input type="text" maxlength="12" placeholder="Name" value=${c.name} aria-label="Name" onInput=${(e) => ch(i, "name", e.target.value)} />
			<select aria-label="Class" value=${c.class} onChange=${(e) => ch(i, "class", e.target.value)}>${Object.keys(nf.classes).map((k) => html`<option value=${k}>${k}</option>`)}</select>
			<input type="text" inputmode="numeric" class="sn" value=${c.level} aria-label="Level" onInput=${(e) => ch(i, "level", e.target.value)} />
			${c.gear && Object.keys(c.gear).length ? html`<span class="gu" data-tip=${Object.entries(c.gear).map(([k, v]) => k + ": " + v).join("\n")}>${Object.keys(c.gear).length} items</span>` : ""}
			${a.characters.length > 1 && html`<button type="button" class="ib ibx" aria-label=${"Remove " + (c.name || "this character")} data-tip="remove this character" onClick=${() => setA({ ...a, characters: a.characters.filter((_, j) => j !== i) })}>×</button>`}</div>`)}
		<div class="frow"><span class="fl"></span><button type="button" class="cb" onClick=${() => setA({ ...a, characters: [...a.characters, { name: "", class: "ranger", level: 60 }] })}>Add a character</button>
			<span class="gu">gear: in New sim (a character's Edit), then Update the account</span></div>
		${err && html`<p class="nbad">${err}</p>`}
		<div class="frow"><span class="fl"></span><button type="button" class="go" disabled=${busy} onClick=${save}>${busy ? "Saving..." : "Save"}</button><button type="button" class="cb" onClick=${() => done(null)}>Cancel</button></div>
	</div>`;
}

// ---- other players': their public pages taken (read-only); Add player takes one (any of its characters' name)
function Players({ nf, reload }) {
	const [name, setName] = useState(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
	const del = async (a) => {
		const r = await call("api/players/" + encodeURIComponent(a), "DELETE");
		setMsg(r.ok ? { text: "Removed " + a } : { text: why(r), bad: true });
		reload();
	};
	const take = async () => {
		setBusy(true); setMsg(null);
		const r = await call("api/new/player", "POST", { name: name.trim() });
		setBusy(false);
		setMsg(r.ok ? { text: "Took " + r.body.account + "'s page" + (r.body.warnings && r.body.warnings.length ? ": " + r.body.warnings.join("; ") : "") } : { text: why(r), bad: true });
		if (r.ok) (setName(""), reload());
	};
	return html`<section class="paf card">
		<div class="frow"><h3>Other players'</h3><span class="gu">their public pages (adventure.land/player/...): class, level and gear; no inventory, gold, bank or CODE. Read-only.</span></div>
		<div class="frow"><input type="text" maxlength="12" placeholder="a player's character" aria-label="A player's character" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && name.trim() && take()} />
			<button type="button" class="cb" disabled=${busy || !/^[A-Za-z0-9]{1,12}$/.test(name.trim())} onClick=${take}>${busy ? "Adding..." : "Add player"}</button></div>
		${msg && html`<p class=${msg.bad ? "nbad" : "hint"}>${msg.text}</p>`}
		${!nf.players.length ? html`<p class="mnote">None taken yet.</p>` : nf.players.map((q) => html`<div class="acard">
			<div class="frow"><b>${q.account}</b><span class="gu">taken ${ago(q.pulled_at)}</span>${q.url && html`<a class="lnk sm" href=${q.url} target="_blank" rel="noopener noreferrer">its page ↗</a>`}
				<a class="cb" href=${"#/new?player=" + encodeURIComponent(q.id)}>New sim with them</a>
				<${Del} what=${"Remove " + q.account + ((n) => (n > 1 ? " (its " + n + " pages)" : ""))(nf.players.filter((x) => x.account === q.account).length)} go=${() => del(q.account)} /></div>
			<div class="achrs">${q.characters.map((c) => html`<${Char} c=${c} />`)}</div>
		</div>`)}
	</section>`;
}
