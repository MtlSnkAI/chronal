"use strict";
// Just enough of the `mongodb` driver for AL's common/mongodb_functions.js and the server.
// Every call resolves on a microtask: no real I/O, so DB work costs 0 virtual ms and is deterministic.

const clone = (x) => (x == null ? x : structuredClone(x));
let out = clone; // replaced with the server realm's cloner once the server context exists

function get(doc, dotted) {
	return dotted.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
}
function matches(doc, q = {}) {
	for (const [k, cond] of Object.entries(q)) {
		const v = get(doc, k);
		if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date) && Object.keys(cond).some((c) => c[0] === "$")) {
			for (const [op, arg] of Object.entries(cond)) {
				if (op === "$in" && !arg.some((a) => a === v || (Array.isArray(v) && v.includes(a)))) return false;
				if (op === "$ne" && v === arg) return false;
				if (op === "$exists" && (v !== undefined) !== !!arg) return false;
				if (op === "$gt" && !(v > arg)) return false;
				if (op === "$gte" && !(v >= arg)) return false;
				if (op === "$lt" && !(v < arg)) return false;
				if (op === "$lte" && !(v <= arg)) return false;
			}
		} else if (Array.isArray(v) ? !v.includes(cond) && v !== cond : v !== cond && !(v instanceof Date && cond instanceof Date && +v === +cond)) return false;
	}
	return true;
}

class Cursor {
	constructor(docs) {
		this.docs = docs;
	}
	sort(spec = {}) {
		const keys = Object.entries(spec);
		this.docs.sort((a, b) => {
			for (const [k, dir] of keys) {
				const x = get(a, k),
					y = get(b, k);
				if (x < y) return -dir;
				if (x > y) return dir;
			}
			return 0;
		});
		return this;
	}
	limit(n) {
		if (n) this.docs = this.docs.slice(0, n);
		return this;
	}
	skip(n) {
		this.docs = this.docs.slice(n);
		return this;
	}
	project() {
		return this;
	}
	maxTimeMS() {
		return this;
	}
	batchSize() {
		return this;
	}
	hint() {
		return this;
	}
	async toArray() {
		return out(this.docs);
	}
	async *[Symbol.asyncIterator]() {
		for (const d of this.docs) yield out(d);
	}
}

class Collection {
	constructor(store) {
		this.store = store;
	}
	async findOne(q = {}) {
		if (q._id !== undefined && Object.keys(q).length === 1) return out(this.store.get(q._id)) ?? null;
		for (const d of this.store.values()) if (matches(d, q)) return out(d);
		return null;
	}
	find(q = {}) {
		return new Cursor([...this.store.values()].filter((d) => matches(d, q)));
	}
	async countDocuments(q = {}) {
		return [...this.store.values()].filter((d) => matches(d, q)).length;
	}
	async insertOne(doc) {
		if (this.store.has(doc._id)) throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
		this.store.set(doc._id, clone(doc));
		return { acknowledged: true, insertedId: doc._id };
	}
	async insertMany(docs) {
		for (const d of docs) await this.insertOne(d);
		return { acknowledged: true, insertedCount: docs.length };
	}
	async replaceOne(q, doc, o = {}) {
		const id = q._id ?? doc._id;
		const had = this.store.has(id);
		if (!had && !o.upsert) return { matchedCount: 0, modifiedCount: 0 };
		this.store.set(id, clone({ ...doc, _id: id }));
		return { acknowledged: true, matchedCount: had ? 1 : 0, modifiedCount: had ? 1 : 0, upsertedCount: had ? 0 : 1 };
	}
	_update(q, u, o) {
		if (Array.isArray(u)) return this._pipeline(q, u, o);
		let d = [...this.store.values()].find((x) => matches(x, q)),
			inserted = false;
		if (!d && !o.upsert) return {};
		const before = clone(d);
		if (!d) {
			d = {};
			for (const [k, v] of Object.entries(q)) if (k[0] !== "$" && (v === null || typeof v !== "object" || v instanceof Date)) setPath(d, k, clone(v));
			if (d._id === undefined) d._id = "sim" + Math.random().toString(36).slice(2);
			this.store.set(d._id, d);
			inserted = true;
		}
		if (!Object.keys(u).some((k) => k[0] === "$")) {
			const id = d._id;
			for (const k of Object.keys(d)) delete d[k];
			Object.assign(d, clone(u), { _id: id });
		}
		for (const [k, v] of Object.entries(u.$set || {})) setPath(d, k, clone(v));
		if (inserted) for (const [k, v] of Object.entries(u.$setOnInsert || {})) setPath(d, k, clone(v));
		for (const [k, v] of Object.entries(u.$inc || {})) setPath(d, k, (get(d, k) || 0) + v);
		for (const [k, v] of Object.entries(u.$max || {})) if (get(d, k) === undefined || v > get(d, k)) setPath(d, k, clone(v));
		for (const [k, v] of Object.entries(u.$min || {})) if (get(d, k) === undefined || v < get(d, k)) setPath(d, k, clone(v));
		for (const [k, v] of Object.entries(u.$push || {})) setPath(d, k, [...(get(d, k) || []), ...(v && v.$each ? v.$each : [v])]);
		for (const [k, v] of Object.entries(u.$addToSet || {})) {
			const arr = get(d, k) || [];
			for (const x of v && v.$each ? v.$each : [v]) if (!arr.includes(x)) arr.push(x);
			setPath(d, k, arr);
		}
		for (const [k, v] of Object.entries(u.$pull || {})) setPath(d, k, (get(d, k) || []).filter((x) => x !== v));
		for (const k of Object.keys(u.$unset || {})) setPath(d, k, undefined);
		return { before, after: d, inserted };
	}
	/** Update with an aggregation pipeline ([{ $set: { field: <expression> } }, ...]), as logic/encouragement.js does. */
	_pipeline(q, stages, o) {
		let d = [...this.store.values()].find((x) => matches(x, q)),
			inserted = false;
		if (!d && !o.upsert) return {};
		const before = clone(d);
		if (!d) {
			d = {};
			for (const [k, v] of Object.entries(q)) if (k[0] !== "$" && (v === null || typeof v !== "object" || v instanceof Date)) setPath(d, k, clone(v));
			if (d._id === undefined) d._id = "sim" + Math.random().toString(36).slice(2);
			this.store.set(d._id, d);
			inserted = true;
		}
		for (const stage of stages) {
			const set = stage.$set || stage.$addFields;
			if (set) {
				const values = Object.entries(set).map(([k, e]) => [k, expr(e, d)]); // a stage sees the document as it was before it
				for (const [k, v] of values) setPath(d, k, v);
			}
			if (stage.$unset) for (const k of [].concat(stage.$unset)) setPath(d, k, undefined);
		}
		return { before, after: d, inserted };
	}
	async updateOne(q, u, o = {}) {
		const r = this._update(q, u, o);
		if (!r.after) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
		return { acknowledged: true, matchedCount: r.inserted ? 0 : 1, modifiedCount: r.inserted ? 0 : 1, upsertedCount: r.inserted ? 1 : 0, upsertedId: r.inserted ? r.after._id : null };
	}
	async updateMany(q, u, o = {}) {
		let n = 0;
		for (const d of [...this.store.values()]) if (matches(d, q)) this._update({ _id: d._id }, u, {}), n++;
		if (!n && o.upsert) return this.updateOne(q, u, o);
		return { acknowledged: true, matchedCount: n, modifiedCount: n };
	}
	async findOneAndUpdate(q, u, o = {}) {
		const r = this._update(q, u, o);
		const doc = out(o.returnDocument === "after" || o.returnNewDocument ? r.after : r.before) ?? null;
		return o.includeResultMetadata ? { value: doc, ok: 1 } : doc;
	}
	async findOneAndReplace(q, doc, o = {}) {
		return this.findOneAndUpdate(q, doc, o);
	}
	async findOneAndDelete(q, o = {}) {
		const d = await this.findOne(q);
		if (d) this.store.delete(d._id);
		void 0;
		return o.includeResultMetadata ? { value: d, ok: 1 } : d;
	}
	async deleteOne(q) {
		for (const [id, d] of this.store) if (matches(d, q)) return this.store.delete(id), { deletedCount: 1 };
		return { deletedCount: 0 };
	}
	async deleteMany(q = {}) {
		let n = 0;
		for (const [id, d] of [...this.store]) if (matches(d, q)) this.store.delete(id), n++;
		return { deletedCount: n };
	}
	async createIndex() {
		return "sim";
	}
}
// Aggregation expressions (the subset the server uses): "$field", literals, and the operators below.
function expr(e, doc) {
	if (typeof e === "string") return e[0] === "$" && e[1] !== "$" ? clone(get(doc, e.slice(1))) : e;
	if (e === null || typeof e !== "object" || e instanceof Date) return e;
	if (Array.isArray(e)) return e.map((x) => expr(x, doc));
	const keys = Object.keys(e);
	if (keys.length === 1 && keys[0][0] === "$") {
		const op = keys[0], raw = e[op];
		if (op === "$literal") return raw;
		const args = Array.isArray(raw) ? raw.map((x) => expr(x, doc)) : op === "$cond" ? null : [expr(raw, doc)];
		const num = (v) => (v instanceof Date ? v.getTime() : v);
		const present = (args || []).filter((v) => v !== null && v !== undefined);
		switch (op) {
			case "$min": return present.length ? present.reduce((a, b) => (num(b) < num(a) ? b : a)) : null;
			case "$max": return present.length ? present.reduce((a, b) => (num(b) > num(a) ? b : a)) : null;
			case "$ifNull": for (const v of args.slice(0, -1)) if (v !== null && v !== undefined) return v; return args.at(-1);
			case "$add": { const date = args.some((v) => v instanceof Date); const t = args.reduce((a, b) => a + num(b), 0); return date ? new Date(t) : t; }
			case "$subtract": { const [a, b] = args; const t = num(a) - num(b); return a instanceof Date && !(b instanceof Date) ? new Date(t) : t; }
			case "$multiply": return args.reduce((a, b) => a * num(b), 1);
			case "$divide": return num(args[0]) / num(args[1]);
			case "$gt": return num(args[0]) > num(args[1]);
			case "$gte": return num(args[0]) >= num(args[1]);
			case "$lt": return num(args[0]) < num(args[1]);
			case "$lte": return num(args[0]) <= num(args[1]);
			case "$eq": return num(args[0]) === num(args[1]);
			case "$ne": return num(args[0]) !== num(args[1]);
			case "$and": return args.every(Boolean);
			case "$or": return args.some(Boolean);
			case "$not": return !args[0];
			case "$cond": {
				const [c, t, f] = Array.isArray(raw) ? raw : [raw.if, raw.then, raw.else];
				return expr(c, doc) ? expr(t, doc) : expr(f, doc);
			}
		}
		throw new Error(`[sim] fake mongo: unsupported expression operator ${op}`);
	}
	return Object.fromEntries(keys.map((k) => [k, expr(e[k], doc)]));
}

function setPath(o, dotted, v) {
	const ks = dotted.split(".");
	let c = o;
	for (const k of ks.slice(0, -1)) c = c[k] ??= {};
	if (v === undefined) delete c[ks.at(-1)];
	else c[ks.at(-1)] = v;
}

class Db {
	constructor() {
		this.cols = new Map();
	}
	collection(name) {
		if (!this.cols.has(name)) this.cols.set(name, new Collection(new Map()));
		return this.cols.get(name);
	}
	async listCollections() {
		return { toArray: async () => [...this.cols.keys()].map((name) => ({ name })) };
	}
	/** Seed helper: docs are routed to collections by their "XX_" id prefix, like get_kind_from_id(). */
	seed(docs, kindOf = (d) => d._id.split("_")[0]) {
		for (const d of docs) this.collection(kindOf(d)).store.set(d._id, clone(d));
		return this;
	}
}

function createMongoModule(db = new Db()) {
	const session = {
		startTransaction() {},
		async commitTransaction() {},
		async abortTransaction() {},
		async endSession() {},
		async withTransaction(fn) {
			return fn(session);
		},
		inTransaction: () => false,
	};
	class MongoClient {
		constructor(uri, options) {
			this.options = options || {};
		}
		async connect() {
			return this;
		}
		db() {
			return db;
		}
		startSession() {
			return session;
		}
		async close() {}
		on() {
			return this;
		}
	}
	return { MongoClient, db, Db };
}

module.exports = { createMongoModule, Db, setOutputCloner: (f) => (out = f) };
