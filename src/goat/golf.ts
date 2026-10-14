import { httpHeaders } from "../api/headers.js";
import { embedOrigin } from "../config/site.js";
import { makeSlot, resolveGoat } from "../goat/resolve.js";
import type { Slot } from "../types/models.js";

function iframeSrc(html: string): string {
  const m = html.match(/iframe src="([^"]+)"/i);
  if (!m?.[1]) throw new Error("golf embed iframe missing");
  return m[1].replace(/&amp;/g, "&");
}

function ingestFromRocky(html: string): { id: string; stream: string } {
  let b64 = "";
  const mAtob = html.match(/atob\(["']([^"']+)["']\)/);
  const mData = html.match(/data-source=["']([^"']+)["']/);

  if (mAtob?.[1]) {
    b64 = mAtob[1];
  } else if (mData?.[1]) {
    b64 = mData[1];
  } else {
    const mGeneric = html.match(/[A-Za-z0-9+/=]{30,}/g);
    if (mGeneric) {
      for (const cand of mGeneric) {
        try {
          const dec = Buffer.from(cand, "base64").toString("utf8");
          if (dec.includes("/embed/ingest/")) {
            b64 = cand;
            break;
          }
        } catch {}
      }
    }
  }

  if (!b64) throw new Error("rockystream data-source or atob missing");

  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    throw new Error("rockystream data-source not base64");
  }
  const path = new URL(decoded).pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (path[0] !== "embed" || path[1] !== "ingest" || !path[2] || !path[3]) {
    throw new Error(`unexpected ingest url ${decoded}`);
  }
  return { id: path[2], stream: path[3] };
}

async function resolveGolf(slot: Slot): Promise<Slot> {
  const embedUrl = `${slot.origin}/embed/${slot.path}`;
  const embedHtml = await (await fetch(embedUrl, { headers: httpHeaders(`${slot.origin}/`) })).text();
  const rockyUrl = iframeSrc(embedHtml);
  const rockyHtml = await (await fetch(rockyUrl, { headers: httpHeaders(embedUrl) })).text();
  const ingest = ingestFromRocky(rockyHtml);
  return makeSlot("ingest", ingest.id, ingest.stream, embedOrigin);
}

export async function unlockGolf(slot: Slot): Promise<string> {
  return resolveGoat(await resolveGolf(slot));
}
