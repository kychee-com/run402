/**
 * Is an IP address public unicast? In-house so the SDK carries no IP
 * library.
 *
 * The special ranges are the ones `ipaddr.js` 1.9.1 named; any address in
 * one of them is not public. Fail-closed: anything that is not a canonical
 * IPv4 or IPv6 address (as `dns.lookup` returns them) is not public either.
 */
import { isIPv4, isIPv6 } from "node:net";

type Range = readonly [bits: readonly number[], prefix: number];

// IPv4 ranges as [octets, prefix length].
const IPV4_SPECIAL: readonly Range[] = [
  [[0, 0, 0, 0], 8], // unspecified
  [[255, 255, 255, 255], 32], // broadcast
  [[224, 0, 0, 0], 4], // multicast
  [[169, 254, 0, 0], 16], // link-local
  [[127, 0, 0, 0], 8], // loopback
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[10, 0, 0, 0], 8], // private
  [[172, 16, 0, 0], 12], // private
  [[192, 168, 0, 0], 16], // private
  [[192, 0, 0, 0], 24], // reserved
  [[192, 0, 2, 0], 24], // reserved (TEST-NET-1)
  [[192, 88, 99, 0], 24], // reserved (6to4 relay anycast)
  [[198, 51, 100, 0], 24], // reserved (TEST-NET-2)
  [[203, 0, 113, 0], 24], // reserved (TEST-NET-3)
  [[240, 0, 0, 0], 4], // reserved
];

// IPv6 ranges as [16-bit groups, prefix length].
const IPV6_SPECIAL: readonly Range[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0], 96], // unspecified, loopback and deprecated IPv4-compatible (::a.b.c.d), which ipaddr.js refused to parse
  [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], // link-local
  [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8], // multicast
  [[0, 0, 0, 0, 0, 0, 0, 1], 128], // loopback
  [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], // unique local
  [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96], // IPv4-mapped
  [[0, 0, 0, 0, 0xffff, 0, 0, 0], 96], // RFC 6145
  [[0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96], // RFC 6052
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16], // 6to4
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 32], // Teredo
  [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32], // documentation
];

function inRange(parts: readonly number[], width: number, [base, prefix]: Range): boolean {
  let remaining = prefix;
  for (let i = 0; i < parts.length && remaining > 0; i += 1) {
    const bits = Math.min(width, remaining);
    const shift = width - bits;
    if ((parts[i]! >>> shift) !== (base[i]! >>> shift)) return false;
    remaining -= bits;
  }
  return true;
}

function ipv4Octets(address: string): number[] {
  return address.split(".").map(Number);
}

/** The eight 16-bit groups of a valid IPv6 address (zone id already removed). */
function ipv6Groups(address: string): number[] {
  let text = address;
  // An embedded IPv4 tail (`::ffff:10.0.0.1`) becomes its two hex groups.
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const [a, b, c, d] = ipv4Octets(last);
    text = `${text.slice(0, lastColon + 1)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const words = (side: string) => (side === "" ? [] : side.split(":").map((word) => parseInt(word, 16)));
  if (!text.includes("::")) return words(text);
  const [head, tail] = text.split("::") as [string, string];
  const left = words(head);
  const right = words(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function isPublicUnicastAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  if (isIPv4(address)) return !IPV4_SPECIAL.some((range) => inRange(ipv4Octets(address), 8, range));
  const unzoned = address.split("%")[0]!;
  if (isIPv6(unzoned)) {
    const groups = ipv6Groups(unzoned.toLowerCase());
    if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return false;
    return !IPV6_SPECIAL.some((range) => inRange(groups, 16, range));
  }
  return false;
}

/** Is a URL hostname an IP literal (IPv4, or IPv6 with or without brackets)? */
export function isIpLiteralHostname(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIPv4(bare) || isIPv6(bare.split("%")[0]!);
}
