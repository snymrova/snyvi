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
    { name: "hook", dur: 9.2, out: ["leak", 0.6], lead: 0.7, line: 7.8,
      cues: { plans: 1.92, reviews: 2.76, reports: 3.62, raw: 5.49 } },
    { name: "reveal", dur: 7.5, out: ["push", 0.45], lead: 0.6, line: 6.024,
      cues: { name: 0.703, tagline: 2.174 } },
    { name: "ask", dur: 10.2, out: ["zoom", 0.5], lead: 0.8, line: 8.544,
      cues: { writes: 2.4, call: 4.6, reply: 6.4 } },
    { name: "arrive", dur: 7.6, out: ["push", 0.4], lead: 0.7, line: 6.024,
      cues: { filed: 4.2 } },
    { name: "queue", dur: 6.7, out: ["push", 0.4], lead: 0.6, line: 5.328,
      cues: { key: 3.9 } },
    { name: "diff", dur: 4.9, out: ["push", 0.4], lead: 0.6, line: 3.528,
      cues: { key: 0.15 } },
    { name: "diagram", dur: 5.0, out: ["push", 0.4], lead: 0.6, line: 3.648, cues: {} },
    { name: "search", dur: 6.1, out: ["push", 0.4], lead: 0.6, line: 4.752,
      cues: { key: 0.15 } },
    { name: "source", dur: 9.6, out: ["up", 0.5], lead: 0.6, line: 8.1,
      cues: { speed: 5.81 } },
    { name: "numbers", dur: 9.9, out: ["push", 0.4], lead: 0.7, line: 8.4,
      cues: { binary: 0.2, size: 1.85, start: 3.59, home: 6.59 } },
    { name: "agents", dur: 10.1, out: ["blur", 0.8], lead: 0.6, line: 8.736,
      cues: { a1: 0.15, a2: 1.25, a3: 2.19, a4: 3.05, a5: 3.97, mcp: 4.91, cmd: 7.45 } },
    { name: "outro", dur: 7.5, out: null, lead: 0.7, line: 4.968,
      cues: { shows: 1.589, github: 3.714 } },
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
