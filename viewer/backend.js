// Preloaded into the game's web backend (al_root's main.js) when the viewer starts it (server.js): the sim's in-memory
// Mongo in place of a database (the maps, no accounts, no characters: the backend only renders the game's page and
// serves its files), servers bound to loopback, and no writes to the game's version.js (main.js bumps it at every local start).
"use strict";
const fs = require("node:fs"),
	net = require("node:net"),
	path = require("node:path"),
	Module = require("node:module");

// its maps seeded as the sim seeds its own (the game's scripts/seed_mongodb.js): the page's map geometry comes from them
const { Db, createMongoModule } = require("../sim/fake_mongo"),
	{ seedMaps } = require("../sim/server_host");
const env = { root: process.cwd(), db: new Db() };
seedMaps(env);
const mongo = createMongoModule(env.db);
const load = Module._load;
Module._load = function (request) {
	return request === "mongodb" ? mongo : load.apply(this, arguments);
};

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
	const port = typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]));
	if (port && typeof args[1] !== "string") args.splice(1, 0, "127.0.0.1");
	else if (args[0] && typeof args[0] === "object" && args[0].port != null && !args[0].host) args[0] = { ...args[0], host: "127.0.0.1" };
	return listen.apply(this, args);
};

const version = path.resolve("version.js"),
	write = fs.writeFileSync;
fs.writeFileSync = function (file, ...rest) {
	if (typeof file === "string" && path.resolve(file) === version) return;
	return write.call(this, file, ...rest);
};
