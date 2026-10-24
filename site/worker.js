// snyvi.com's one piece of code: byte ranges for the window's tour clips,
// and a blog post's film.
// Static assets answer a Range request with the whole file, and Safari's
// WebKit (the Mac window) will not play a video that comes back that way.
// Only /tour/* and /blog/* run this (run_worker_first in wrangler.toml); everything
// else is served as assets, untouched. A clip is a few hundred KB, so the
// slice is taken from the whole body.
export default {
  async fetch(request, env) {
    const range = request.method === "GET" && request.headers.get("Range");
    const res = await env.ASSETS.fetch(range ? new Request(request.url) : request);
    const headers = new Headers(res.headers);
    headers.set("Accept-Ranges", "bytes");
    if (!range || res.status !== 200) return new Response(res.body, { status: res.status, headers });

    // One range of bytes; anything else (another unit, several ranges) is
    // answered with the whole file, as a server that ignores Range would.
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) return new Response(res.body, { status: 200, headers });
    const body = await res.arrayBuffer();
    const size = body.byteLength;
    let start = m[1] !== "" ? Number(m[1]) : null;
    let end = m[2] !== "" ? Number(m[2]) : null;
    if (start === null) { start = Math.max(0, size - end); end = size - 1; }
    else end = end === null ? size - 1 : Math.min(end, size - 1);
    if (start >= size || start > end) {
      headers.set("Content-Range", `bytes */${size}`);
      headers.delete("Content-Length");
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(body.slice(start, end + 1), { status: 206, headers });
  },
};
