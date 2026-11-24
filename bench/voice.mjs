#!/usr/bin/env node
/* What voice takes a heard phrase to be (ui/voice.js `match`), against the
 * phrases the model really gave on the maker's machine (plan ed0af62be2).
 *
 * The model mishears a short command in ways that still sound like it:
 * "Open inbox" came back as "Opening box", "About snyvi" as "About stavey".
 * The match is by sound, and this holds both of its edges: those must land
 * on their command, and what the model says of a cough or a room ("You",
 * "Thank you, thank you") must land on nothing. A miss costs a repeat; a
 * wrong command costs the reader's trust.
 *
 *   node bench/voice.mjs --check
 */
import { match, near, hints } from "../ui/voice.js";

const t = (label, ...say) => ({ label, say });
const TARGETS = [
  t("home", "Home", "go home"), t("inbox", "Inbox", "open inbox"), t("theme", "Theme…", "themes"),
  t("sidebars", "Arrange sidebars…", "sidebars"), t("about", "About snyvi", "about"),
  t("updates", "Check for updates", "updates"), t("keys", "Keys…"), t("voice", "Voice…", "voice"),
  t("new desk", "New desk…"), t("desk snyvi", "desk snyvi"), t("desk omd", "desk omd"),
  t("panel 1", "panel one"), t("panel 2", "panel two", "panel tests", "tests"), t("board", "Board", "Board view"),
  t("back", "back", "go back"),
];
const HEARD = [
  ["Open inbox.", "inbox"], ["Opening box", "inbox"], ["About stavey", "about"], ["About snifey", "about"],
  ["On inside bars", "sidebars"], ["Arrange sidebars.", "sidebars"], ["Desco md", "desk omd"],
  ["Desk snyvi", "desk snyvi"], ["Panel two.", "panel 2"], ["Go home. Thank you.", "home"], ["Board", "board"],
  ["Back.", "back"], ["Go back", "back"], ["Go back.", "back"],
  // And what must run nothing.
  ["Black", null], ["Pack", null], ["Bag", null],
  ["You", null], ["Wow", null], ["Thank you, thank you", null], ["Tease.", null], ["", null], ["...", null],
  ["I was going to say something else entirely", null],
];

let bad = 0;
for (const [heard, want] of HEARD) {
  const got = match(heard, TARGETS)?.label ?? null;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${JSON.stringify(heard).padEnd(48)} → ${got ?? "nothing"}${ok ? "" : ` (wanted ${want ?? "nothing"})`}`);
}

// A near miss is asked about, never run: the one command just under its
// bar. What the model says of a cough must still find nothing to ask, and
// "Tease." (said for "Keys") is not near enough by its letters to ask
// honestly, so it is not asked.
const NEARLY = [
  ["Black", "back"], ["In the box", "inbox"],
  ["Tease.", null], ["You", null], ["Wow", null], ["Thank you, thank you", null], ["Pack", null],
  ["I was going to say something else entirely", null],
  // What is matched outright is not also asked.
  ["Open inbox.", null], ["Back.", null],
];
for (const [heard, want] of NEARLY) {
  const got = near(heard, TARGETS)?.label ?? null, ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} near  ${JSON.stringify(heard).padEnd(42)} → ${got ? `${got}?` : "nothing"}${ok ? "" : ` (wanted ${want ?? "nothing"})`}`);
}

// The three things the bar offers a silent hold: from the live targets and
// nowhere else, what is nearest first.
const k = (kind, ...say) => ({ kind, say });
const HINTS = [
  ["on a desk", [k("cmd", "Home"), k("cmd", "Inbox"), k("desk", "desk omd"), k("panel", "panel one"), k("panel", "panel two"), k("view", "Board")], ["panel one", "board", "desk omd"]],
  ["on Home", [k("cmd", "Home"), k("cmd", "Inbox"), k("cmd", "Theme…"), k("cmd", "Keys…")], ["home", "inbox", "theme"]],
  ["two things only", [k("cmd", "Home"), k("desk", "desk omd")], ["desk omd", "home"]],
  ["nothing to say", [], []],
];
for (const [name, targets, want] of HINTS) {
  const got = hints(targets), ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} hints ${name.padEnd(42)} → ${got.join(" · ") || "nothing"}${ok ? "" : ` (wanted ${want.join(" · ") || "nothing"})`}`);
}
console.log(bad ? `\n${bad} wrong` : `\nall as they should be`);
if (bad && process.argv.includes("--check")) process.exit(1);
