import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isIpLiteralHostname, isPublicUnicastAddress } from "./ip-range.js";

// The answers below were checked against ipaddr.js 1.9.1's
// `parse(a).range() === "unicast"` before the SDK dropped it, over these
// cases and 9,000 random addresses. Two answers are deliberately
// stricter: `::a.b.c.d` (which ipaddr.js could not parse) and the rest of
// `::/96` are not public.
const PUBLIC = [
  "8.8.8.8", "1.1.1.1", "11.0.0.0", "100.128.0.0", "172.32.0.0", "192.169.0.1",
  "2606:4700:4700::1111", "2a00:1450:4001::200e", "2001:1::1", "1:2:3:4:5:6:7:8", "1::",
  "2606:4700::1%1", "1:2:3:4:5:6:1.2.3.4",
];

const NOT_PUBLIC = [
  "0.0.0.0", "0.1.2.3", "255.255.255.255", "224.0.0.1", "239.1.1.1", "169.254.1.1", "127.0.0.1",
  "100.64.0.1", "100.127.255.255", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
  "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.51.100.1", "203.0.113.1", "240.0.0.1",
  "::", "::1", "::2", "::1.2.3.4", "fe80::1", "febf::1", "FE80::1", "fe80::1%eth0", "ff02::1", "fc00::1", "fd12:3456::1",
  "::ffff:8.8.8.8", "::ffff:10.0.0.1", "::ffff:808:808", "::ffff:0:808:808", "64:ff9b::808:808",
  "2002::1", "2001::1", "2001:0:ffff::1", "2001:db8::1",
  // Not canonical addresses: fail closed.
  "2130706433", "0x7f.0.0.1", "01.2.3.4", "127.1", "example.com", "", "1.2.3.4.5", ":::",
];

describe("isPublicUnicastAddress", () => {
  for (const address of PUBLIC) it(`${address} is public`, () => assert.equal(isPublicUnicastAddress(address), true));
  for (const address of NOT_PUBLIC) it(`${JSON.stringify(address)} is not public`, () => assert.equal(isPublicUnicastAddress(address), false));
  it("refuses a non-string", () => assert.equal(isPublicUnicastAddress(undefined), false));
});

describe("isIpLiteralHostname", () => {
  it("names IPv4 and IPv6 literals, bracketed or not", () => {
    for (const host of ["127.0.0.1", "8.8.8.8", "::1", "[::1]", "[2606:4700::1]"]) assert.equal(isIpLiteralHostname(host), true, host);
  });
  it("leaves hostnames alone", () => {
    for (const host of ["relay.example.com", "localhost", "[relay]", "1.2.3"]) assert.equal(isIpLiteralHostname(host), false, host);
  });
});
