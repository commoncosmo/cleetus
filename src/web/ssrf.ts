import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export type AddressClass = "loopback" | "private" | "linklocal" | "public";
export type SsrfPolicy = { allowLocalhost: boolean };
export type ResolveFn = (host: string) => Promise<string[]>;

const defaultResolve: ResolveFn = async (host) => {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
};

function classifyIpv4(ip: string): AddressClass {
  const o = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return "public";
  const [a, b] = o as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 0) return "loopback"; // 0.0.0.0/8 "this host" — reaches localhost
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "linklocal";
  return "public";
}

/** Expand any valid IPv6 literal to its 8 numeric hextets, or null if unparseable. */
function ipv6Hextets(v: string): number[] | null {
  if (!v.includes(":")) return null;
  // Convert a trailing dotted-quad (e.g. ::ffff:127.0.0.1) to two hextets.
  let s = v;
  const dotted = v.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const q = [dotted[2], dotted[3], dotted[4], dotted[5]].map((n) => Number.parseInt(n ?? "", 10));
    if (q.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = q as [number, number, number, number];
    s = `${dotted[1]}${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let all: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    all = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    all = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (all.length !== 8) return null;
  const nums = all.map((h) => Number.parseInt(h || "0", 16));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

export function classifyAddress(ip: string): AddressClass {
  if (isIP(ip) === 4) return classifyIpv4(ip);
  const hx = ipv6Hextets(ip.toLowerCase());
  if (!hx) return "public";
  if (hx.every((h) => h === 0)) return "loopback"; // :: unspecified
  if (hx.slice(0, 7).every((h) => h === 0) && hx[7] === 1) return "loopback"; // ::1, any form
  // IPv4-mapped ::ffff:a.b.c.d (covers dotted and hex-compressed forms)
  if (hx.slice(0, 5).every((h) => h === 0) && hx[5] === 0xffff) {
    const h6 = hx[6] as number;
    const h7 = hx[7] as number;
    return classifyIpv4(`${(h6 >> 8) & 0xff}.${h6 & 0xff}.${(h7 >> 8) & 0xff}.${h7 & 0xff}`);
  }
  const h0 = hx[0] as number;
  if ((h0 & 0xffc0) === 0xfe80) return "linklocal"; // fe80::/10
  if ((h0 & 0xfe00) === 0xfc00) return "private"; // fc00::/7
  return "public";
}

/**
 * Validate a URL against the SSRF policy and return the IP address to pin the
 * connection to. Every resolved address is classified and a single blocked one
 * refuses the whole request (no cherry-picking a safe address), so the returned
 * IP is always one we verified. Callers MUST connect to exactly this address —
 * resolving the hostname a second time at connect time reopens a DNS-rebinding
 * (TOCTOU) window. See `pinnedRequest` in fetch.ts.
 */
export async function assertUrlAllowed(
  url: URL,
  policy: SsrfPolicy,
  resolve: ResolveFn = defaultResolve,
): Promise<string> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`refused: unsupported scheme ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const check = (addr: string): void => {
    const cls = classifyAddress(addr);
    const blocked =
      cls === "private" || cls === "linklocal" || (cls === "loopback" && !policy.allowLocalhost);
    if (blocked) {
      throw new SsrfBlockedError(
        `refused: ${host} resolves to a blocked address (${addr}, ${cls})`,
      );
    }
  };
  if (isIP(host)) {
    check(host);
    return host;
  }
  const addrs = await resolve(host);
  if (addrs.length === 0) throw new SsrfBlockedError(`refused: ${host} did not resolve`);
  for (const a of addrs) check(a);
  return addrs[0]!; // every address validated above; pin the first
}
