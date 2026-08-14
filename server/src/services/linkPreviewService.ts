import { promises as dns } from "node:dns";
import net from "node:net";

/**
 * Link previews (unfurling).
 *
 * Fetches a URL server-side and extracts Open Graph / Twitter / basic meta tags
 * into a compact card. SSRF-hardened: only http(s), blocks requests that resolve
 * to private / loopback / link-local ranges, caps redirects, response size and
 * time, and only parses text/html. Results are cached in-memory with a TTL.
 */
export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

const cache = new Map<string, { at: number; data: LinkPreview }>();

export const linkPreviewService = {
  async preview(rawUrl: string): Promise<LinkPreview> {
    const empty: LinkPreview = { url: rawUrl, title: null, description: null, image: null, siteName: null };

    const hit = cache.get(rawUrl);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

    let data: LinkPreview = empty;
    try {
      const { html, finalUrl } = await fetchHtml(rawUrl);
      data = { ...parseMeta(html, finalUrl), url: rawUrl };
    } catch {
      data = empty; // blocked / unreachable / non-html — no preview, never leak why
    }
    cache.set(rawUrl, { at: Date.now(), data });
    return data;
  },
};

/* -- Safe fetch ------------------------------------------------------------ */

async function fetchHtml(startUrl: string): Promise<{ html: string; finalUrl: string }> {
  let current = new URL(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("unsupported-protocol");
    }
    await assertPublicHost(current.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Present as a normal browser so sites serve their real OG markup.
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect-no-location");
      current = new URL(loc, current); // resolve relative redirects
      continue;
    }

    // Non-2xx (e.g. a bot-challenge page) has no useful OG markup — bail so the
    // client falls back to a minimal card instead of parsing junk.
    if (!res.ok) throw new Error(`http-${res.status}`);

    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("application/xhtml")) {
      throw new Error("not-html");
    }
    const html = await readCapped(res, MAX_BYTES);
    return { html, finalUrl: current.toString() };
  }
  throw new Error("too-many-redirects");
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (received >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return html;
}

/** Throw unless every address the host resolves to is a public/global IP. */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("blocked-ip");
    return;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("no-address");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("blocked-ip");
  }
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    // IPv4-mapped (::ffff:a.b.c.d)
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIPv4(mapped[1]!);
    const head = parseInt(lower.split(":")[0] || "0", 16);
    if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return true; // unknown format → block
}

function isBlockedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0 test
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/* -- Meta parsing ---------------------------------------------------------- */

function parseMeta(html: string, baseUrl: string): LinkPreview {
  const head = html.slice(0, 200_000);
  const meta = (...names: string[]): string | null => {
    for (const name of names) {
      const v = metaContent(head, name);
      if (v) return v;
    }
    return null;
  };

  const title = meta("og:title", "twitter:title") || tagText(head, "title");
  const description = meta("og:description", "twitter:description", "description");
  const siteName = meta("og:site_name");
  let image = meta("og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (image) {
    try {
      image = new URL(image, baseUrl).toString();
    } catch {
      image = null;
    }
  }

  return {
    url: baseUrl,
    title: title ? clip(title, 200) : null,
    description: description ? clip(description, 400) : null,
    image,
    siteName: siteName ? clip(siteName, 100) : null,
  };
}

function metaContent(html: string, name: string): string | null {
  // Matches <meta property|name="<name>" content="..."> in either attribute order.
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

function tagText(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return m && m[1] ? decodeEntities(m[1].trim()) : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)));
}
function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
