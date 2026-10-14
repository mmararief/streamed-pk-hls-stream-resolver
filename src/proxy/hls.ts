import { Impit } from "impit";
import { pull, pullCleanSegment } from "./pull.js";

const cdn = new Impit({ browser: "chrome151" });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

export async function proxyHls(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  const referer = reqUrl.searchParams.get("referer") || "https://embed.st/";

  if (!target) {
    return new Response("Missing url parameter", { status: 400, headers: corsHeaders });
  }

  try {
    const upstreamHeaders: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    };

    if (referer) {
      upstreamHeaders["Referer"] = referer;
      try {
        upstreamHeaders["Origin"] = new URL(referer).origin;
      } catch {}
    }

    const range = request.headers.get("range");
    if (range) {
      upstreamHeaders["Range"] = range;
    }

    // 1. M3U8 Playlist rewriting
    if (target.includes(".m3u8") || target.includes("/playlist/") || target.includes("mono.m3u8")) {
      let text = "";
      try {
        const buf = await pull(target, referer);
        text = buf.toString("utf8");
      } catch (err: any) {
        const upRes = await cdn.fetch(target, {
          headers: upstreamHeaders,
          signal: AbortSignal.timeout(8000),
        }).catch(() => fetch(target, { headers: upstreamHeaders, signal: AbortSignal.timeout(8000) }));

        if (!upRes.ok) {
          return new Response(`Upstream M3U8 failed: ${upRes.status}`, {
            status: upRes.status,
            headers: corsHeaders,
          });
        }
        text = await upRes.text();
      }

      const baseObj = new URL(target);
      const origin =
        reqUrl.origin.includes("127.0.0.1") || reqUrl.origin.includes("localhost")
          ? (process.env.PUBLIC_TUNNEL_URL || reqUrl.origin)
          : reqUrl.origin;

      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith("#")) {
            if (!trimmed.includes('URI="')) return line;
            return trimmed.replace(/URI="([^"]+)"/g, (_, u) => {
              const abs = new URL(u, baseObj.href).href;
              const params = new URLSearchParams({ url: abs, referer });
              return `URI="${origin}/api/hls?${params.toString()}"`;
            });
          }

          const abs = new URL(trimmed, baseObj.href).href;
          const params = new URLSearchParams({ url: abs, referer });
          return `${origin}/api/hls?${params.toString()}`;
        })
        .join("\n");

      return new Response(rewritten, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "public, max-age=3, s-maxage=3",
        },
      });
    }

    // 2. Binary Segment (.ts, .html, .image, .m4s) / MP4 Streaming
    if (target.includes("tiktokcdn") || target.includes(".image") || target.includes(".webp") || target.includes("strmd")) {
      try {
        const segBuf = await pullCleanSegment(target, referer);
        return new Response(segBuf, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "video/mp2t",
            "Content-Length": String(segBuf.length),
            "Cache-Control": "public, max-age=3600, s-maxage=3600, immutable",
          },
        });
      } catch (e) {
        // Fall through
      }
    }

    let upRes: any;
    try {
      upRes = await cdn.fetch(target, {
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      upRes = await fetch(target, {
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(20000),
      });
    }

    const resHeaders = new Headers(corsHeaders);
    const ct = upRes.headers.get("content-type");
    if (ct) resHeaders.set("Content-Type", ct);
    const cl = upRes.headers.get("content-length");
    if (cl) resHeaders.set("Content-Length", cl);
    const cr = upRes.headers.get("content-range");
    if (cr) resHeaders.set("Content-Range", cr);
    const ar = upRes.headers.get("accept-ranges");
    if (ar) resHeaders.set("Accept-Ranges", ar);
    resHeaders.set("Cache-Control", "public, max-age=3600, s-maxage=3600, immutable");

    return new Response(upRes.body, {
      status: upRes.status,
      headers: resHeaders,
    });
  } catch (err: any) {
    return new Response(err?.message || "Proxy error", {
      status: 502,
      headers: corsHeaders,
    });
  }
}
