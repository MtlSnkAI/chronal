"use strict";
// Objects must be created in the realm that consumes them: AL code uses `x instanceof Object/Array` (e.g. clone()),
// which is false for objects built in another vm context. Real sockets/workers/Mongo always deliver fresh local objects.
const vm = require("node:vm");
const SRC = `(function realmClone(x, seen) {
	if (x === null || typeof x !== "object") return x;
	seen = seen || new Map();
	if (seen.has(x)) return seen.get(x);
	var t = Object.prototype.toString.call(x), out;
	if (t === "[object Date]") return new Date(x.getTime());
	if (t === "[object RegExp]") return new RegExp(x.source, x.flags);
	if (ArrayBuffer.isView(x)) return x.slice();
	if (Array.isArray(x)) { out = []; seen.set(x, out); for (var i = 0; i < x.length; i++) out[i] = realmClone(x[i], seen); return out; }
	if (t === "[object Map]") { out = new Map(); seen.set(x, out); x.forEach(function (v, k) { out.set(realmClone(k, seen), realmClone(v, seen)); }); return out; }
	if (t === "[object Set]") { out = new Set(); seen.set(x, out); x.forEach(function (v) { out.add(realmClone(v, seen)); }); return out; }
	out = {}; seen.set(x, out);
	for (var k in x) if (Object.prototype.hasOwnProperty.call(x, k) && typeof x[k] !== "function") out[k] = realmClone(x[k], seen);
	return out;
})`;
const cache = new WeakMap();
function realm(vmContext) {
	if (!cache.has(vmContext)) cache.set(vmContext, { clone: vm.runInContext(SRC, vmContext), JSON: vm.runInContext("JSON", vmContext) });
	return cache.get(vmContext);
}
module.exports = { realm };
