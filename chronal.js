#!/usr/bin/env node
// The chronal CLI: chronal help lists the commands.
"use strict";

const HELP = `usage: chronal <command> [options]
       chronal --version         its version

Run
  run <setup.json | <id>.setup.json> [options]
                            run a setup (a JSON file: the characters, their CODE and start states, the party,
                            the run's length) in the sim: the game's own server and client, headless, as fast as
                            the CPU allows (chronal run --help: its options)
  continue <run id> [--label end] [--duration D] [--at end|spawn] [--reseed ACCOUNT] [--run [-- run options]]
                            a setup that goes on from a run's state export (each character's gear, items,
                            bank and server state, the world's clock): long progressions as stages
  example                   an annotated setup to start from: chronal example | grep -v '^\\s*//' > my.json
  new ...                   compose a setup (pulls, CODE sets, templates; chronal new --help)

Watch
  ps [--dir LIVE] [--all]   the runs running (their pid, speed, game time); --all: every run
  stop <run id | --tag T | --all> [--dir LIVE] [--force [--wait S]]
                            ask runs to stop (at their next game minute, with their final numbers); --force:
                            SIGTERM to their verified process, then SIGKILL after S s
  dash [--port N] [--host H] [--dir LIVE] [--gc-code]
                            the dashboard: every run, live; stop, rerun, compare; new runs; recorded runs
                            replayed in the game's own page (run --record)

Data
  install [--update]        the game the sim runs: its repos in upstream/ (cloned when missing), copied into
                            runtime/app; --update: git pull them first
  pull ...                  pull the live account (states, bank, CODE) through the game's API; other players'
                            public pages (chronal pull --help)
  library ...               the CODE library: others' CODE, added, updated, scanned, trusted, fitted
                            (list, add, update, remove, revisions, scan, trust, fit)
  code-sets [--names A[:class],...]
                            the CODE sets a setup can take (run --code-set)
  g-data                    cache the game's G (the dashboard's item tooltips)
`;

const args = process.argv.slice(2);
const cmd = args.shift() || "help";

const COMMANDS = {
	help: () => console.log(HELP),
	"--version": () => console.log("chronal " + require("./lib/setup").chronalVersion()),
	run: () => require("./sim/run").main(args),
	continue: () => require("./lib/continue").cli(args),
	ps: () => require("./lib/runs").cli("ps", args),
	stop: () => require("./lib/runs").cli("stop", args),
	example: () => process.stdout.write(require("./lib/example").example()),
	new: () => require("./lib/compose").cli(args),
	dash: () => require("./dashboard/server").cli(args),
	install: () => {
		try {
			console.log("installed:", JSON.stringify(require("./lib/install").install(args)));
		} catch (e) {
			console.error("chronal install: " + e.message);
			process.exit(1);
		}
	},
	pull: () => require("./lib/pull").cli(args),
	library: () => require("./lib/library").cli(args),
	"code-sets": () => require("./lib/code_sets").cli(args),
	"g-data": () => require("./sim/g_data").main(),
};

if (!Object.hasOwn(COMMANDS, cmd) || cmd === "--help" || cmd === "-h") {
	if (cmd !== "--help" && cmd !== "-h") console.error(`unknown command "${cmd}"\n`);
	console.log(HELP);
	process.exit(cmd === "--help" || cmd === "-h" ? 0 : 2);
}
COMMANDS[cmd]();
