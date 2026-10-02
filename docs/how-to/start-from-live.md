# Start from your live characters

Run your characters as they are now on live (their level, gear, inventory, gold, bank, CODE), then change one thing
and see what it does.

## 1. Get an API token

Create one at https://adventure.land/vscode (logged in). Then either:

- the dashboard's **Settings**: paste it, **Test** (the game says which account it is), **Save** (in
  `config/al_token`, readable only by you, gitignored), then **Pull now**; or
- put it in a file of your own and point config `al_token_file` at it (`config/local.json`:
  `{ "al_token_file": "../.al_token" }`), or set `CHRONAL_AL_TOKEN`.

## 2. Pull your account

```sh
chronal pull
```

This reads every character, the bank and your CODE slots through the game's API (it changes nothing) into
`pulls/<account>/<time>/`. It warns when a character is online (its state is the game's last save, at most about
24 s old), when the bank is open in game, and when live's game data differs from the sim's game.

For an exact copy of a character, use New sim's **Add export**: **Copy the snippet** (`snippets/export-state.js`),
paste it into that character's CODE on live and press ENGAGE: it copies the export to the clipboard (gzipped when
large; too large for the clipboard, or refused by it: it downloads `<Name>.json`). Paste it into the box, or drop the
file, and **Add**. On the command line: `chronal pull --add ~/Downloads/<Name>.json` (a file of the clipboard's text
works too). Exported from inside the bank, it also gives
the exact bank.

## 3. Compose a run from it

```sh
chronal new --chars Merch,Ranger,Priest --duration 1h --check
```

Each character starts as pulled, where it was, running its own live CODE slot, on its account with the pull's bank
and account age; the fighters form their party by CODE. The printout says what each character runs, which names in
the CODE were mapped, and any warnings. The setup is saved in `setups/`.

Then run it:

```sh
chronal new --chars Merch,Ranger,Priest --duration 1h --run --seeds 1,2,3
```

The dashboard's **New sim** does the same with a form: pick the pull, who is in game, their gear and CODE, and Start.

## 4. Change one thing

- Gear: `--gear Ranger:mainhand=firebow+8`, or sweep it: `--sweep-gear Ranger:mainhand=bow+8,firebow+7`. A whole set:
  `--gear-set Ranger=ranger-mid`, or compare sets: `--sweep-gear-set Ranger=ranger-mid,ranger-late`.
- CODE: `--code-set mine` (your working tree, from your sets file) instead of the live slots.
- A place: `--at Ranger=halloween:-500:200`.

Then compare the runs ([Compare runs](compare-runs.md)).

## Other players' characters

```sh
chronal pull --player SomeName      # their account's public page: class, level, gear, looks
chronal new --player SomeName --chars Merch,SomeName,TheirPriest --missing TheirPriest=idle
```

A public page has no inventory, gold, bank, place or CODE: their characters take your pull's character of their class's
inventory and gold, and run your CODE (or another set). `chronal pull --top priest` lists the site's top characters to
pick from.
