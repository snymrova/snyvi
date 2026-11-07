/* The operator's takedown (docs/WALL.md): a page off the wall and off
 * snyvi.page at once, kept in the database as hidden until its owner takes
 * it down themselves.
 *
 *   WALL_OPERATOR=… npm run hide -- <slug>
 *
 * WALL_OPERATOR is the Worker's secret of that name (wrangler secret put). */

const slug = process.argv[2] ?? "";
const token = process.env.WALL_OPERATOR ?? "";
const base = (process.env.SNYVI_WALL ?? "https://wall.snyvi.com").replace(/\/$/, "");
if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(slug) || !token) {
  console.error("usage: WALL_OPERATOR=… npm run hide -- <slug>");
  process.exit(2);
}
const r = await fetch(`${base}/_op/hide/${slug}`, { method: "POST", headers: { "x-wall-operator": token } });
console.log(r.status, await r.text());
process.exit(r.ok ? 0 : 1);
