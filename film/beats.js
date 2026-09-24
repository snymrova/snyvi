/* The film's clock, in one place: the composition reads it to time its
 * scenes, and film/mix.mjs reads it to lay the narration under them. A beat
 * is a scene and the line spoken over it.
 *
 *   at    when the scene starts, in the finished film
 *   dur   how long it holds before the next one begins
 *   out   the transition into the next scene, and how long it runs -- the
 *         scene stays on screen for that long after `dur`, under the one
 *         coming in
 *   lead  how long the picture is up before the line starts
 *   line  how long the line runs, measured from the mp3 in film/audio
 *   cues  moments inside the line, in seconds from its start, measured from
 *         the pauses in the voice: what the picture is timed against
 *
 * `at` is derived, so a scene can be lengthened by changing `dur` alone.
 */
(function () {
  const beats = [
    // The problem: more passion projects than hours, and the work scatters.
    { name: "passion", dur: 9.6, out: ["push", 0.45], lead: 0.6, line: 8.016,
      cues: { agents: 4.023, all: 5.214, same: 6.919 } },
    { name: "scatter", dur: 10.6, out: ["leak", 0.6], lead: 0.6, line: 9.096,
      cues: { plans: 1.695, todo: 4.399, switch: 6.477 } },
    // The answer.
    { name: "answer", dur: 10.8, out: ["hold", 0.5], lead: 0.6, line: 9.264,
      cues: { app: 2.670, desk: 3.891, write: 6.076 } },
    // How, one part of the problem a scene.
    { name: "desks", dur: 7.6, out: ["hold", 0.5], lead: 0.6, line: 6.264,
      cues: { folder: 1.910, four: 2.807 } },
    { name: "docs", dur: 9.8, out: ["hold", 0.5], lead: 0.6, line: 8.448,
      cues: { lands: 3.899, marked: 5.236, opens: 6.907 } },
    { name: "library", dur: 9.4, out: ["hold", 0.5], lead: 0.6, line: 7.992,
      cues: { inbox: 2.731, kept: 4.105, key: 5.800 } },
    { name: "notes", dur: 7.2, out: ["hold", 0.5], lead: 0.6, line: 5.832,
      cues: { stays: 3.343, head: 4.859 } },
    { name: "switch", dur: 9.6, out: ["hold", 0.5], lead: 0.6, line: 8.352,
      cues: { left: 1.688, key: 4.885 } },
    { name: "agents", dur: 7.8, out: ["up", 0.5], lead: 0.6, line: 6.216,
      cues: { names: 1.222, mcp: 4.408 } },
    { name: "private", dur: 8.6, out: ["push", 0.4], lead: 0.6, line: 7.320,
      cues: { app: 0.050, start: 2.986, home: 5.062 } },
    // What it adds up to.
    { name: "summary", dur: 9.4, out: ["cut", 0.04], lead: 0.6, line: 7.680,
      cues: { calm: 1.942, name: 3.909, free: 5.150, github: 6.890 } },
    { name: "rocket", dur: 8.6, out: null, lead: 0.6, line: 5.520,
      cues: { rocket: 3.266, welcome: 4.830 } },
  ];
  let at = 0;
  for (const b of beats) {
    b.at = +at.toFixed(3);
    b.say = +(at + b.lead).toFixed(3);   // when the line starts, in the film
    at += b.dur;
  }
  const FILM = {
    beats,
    total: +at.toFixed(3),
    by: Object.fromEntries(beats.map(b => [b.name, b])),
    /** A moment inside a beat, in film seconds: `t("hook", "plans")`, or
     *  `t("hook", 2)` for two seconds into the scene. */
    t(name, cue) {
      const b = FILM.by[name];
      return +(typeof cue === "number" ? b.at + cue : b.say + b.cues[cue]).toFixed(3);
    },
  };
  (typeof globalThis !== "undefined" ? globalThis : window).FILM = FILM;
})();
