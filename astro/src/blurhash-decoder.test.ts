/**
 * Byte-equivalence guard for the inlined blurhash decoder.
 *
 * The reference samples were produced by `blurhash@2.0.5`'s `decode()` and
 * frozen below. If this test ever fails after touching `blurhash-decoder.ts`,
 * the inlined decoder has diverged from upstream — re-derive the bytes by
 * running:
 *
 *     node -e 'import("blurhash").then(({decode}) => { ... })'
 *
 * and update the constants only after confirming the new bytes match a
 * fresh install of `blurhash@2.0.5`. Drift is the failure mode this guard
 * is meant to catch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  averageColorFromBlurhash,
  decode,
  decodeBlurhashToDataUri,
} from "./blurhash-decoder.js";

interface Sample {
  readonly hash: string;
  readonly w: number;
  readonly h: number;
  readonly hex: string;
}

// Frozen reference bytes from `blurhash@2.0.5`'s decode(). DO NOT regenerate
// from the inlined decoder — that would defeat the point of the guard.
const SAMPLES: readonly Sample[] = [
  { hash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4", w: 1, h: 1, hex: "e5e4e2ff" },
  {
    hash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
    w: 4,
    h: 4,
    hex: "e5e4e2ffe4e2e0ffe3e1dfffe2e2dfffe4e2e2ffe0dad6ffddd8d2ffe0dedbffe2dedfffdad0c9ffd6cdc2ffddd8d5ffdddadaffd8d3ceffd8d3ccffdbd8d5ff",
  },
  {
    hash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
    w: 8,
    h: 8,
    hex: "e5e4e2ffe4e3e1ffe4e2e0ffe3e1dfffe3e1dfffe2e2dfffe2e2dfffe3e2dfffe5e3e2ffe4e2e0ffe3e0ddffe2dedbffe1dfdbffe1e0ddffe2e1deffe2e1deffe4e2e2ffe3e0deffe0dad6ffded7d0ffddd8d2ffdfdcd7ffe0dedbffe2dedcffe3e1e1ffe1dddbffddd4ceffd9cfc5ffd9d1c8ffdbd7d1ffdedbd7ffe0dbd9ffe2dedfffdfdad8ffdad0c9ffd6cabeffd6cdc2ffd9d4cdffddd8d5ffded9d7ffe0dcddffddd8d7ffd8d0c9ffd5cbc1ffd6cec4ffd9d4ceffdcd8d4ffddd8d5ffdddadaffdcd8d6ffd8d3ceffd7d0c9ffd8d3ccffdad7d2ffdbd8d5ffdbd8d5ffdbd9d8ffdad8d6ffd9d6d3ffd9d6d2ffdad8d4ffdbd9d6ffdbdad7ffdad8d5ff",
  },
  {
    hash: "L9AS}j^+0KW;~Vj]M{ay9aWBM{j[",
    w: 8,
    h: 8,
    hex: "524253ff5c4c5bff6f5f6aff7d6d77ff7e7079ff71656eff554957ff2d1735ff574856ff60505dff72616cff7e6e77ff7f7079ff72656eff584b58ff342139ff61525eff685863ff76656eff806f76ff7f6f77ff73656dff5d4f59ff413141ff695a63ff6e5e67ff78676fff7f6d74ff7e6c74ff72636aff5e505aff493946ff685963ff6c5d66ff75636cff7a6870ff78666eff6c5c65ff594a56ff453545ff5b4e5bff60515eff695864ff6f5d68ff6d5b67ff60515eff4a3b4eff2e1b3aff41344cff483a50ff574659ff604e60ff5e4e5fff4e4056ff2b1d41ff000023ff12003bff281541ff42304eff503f58ff4f4159ff3a2f4eff000034ff000000ff",
  },
  {
    hash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    w: 16,
    h: 16,
    hex: "87a4b1ff89a4b1ff8fa7b1ff98aab1ffa1adb1ffaab0b0ffb0b2aeffb4b4adffb5b4abffb3b3abffafb1abffa8aeacffa0acaeff97a9b1ff90a7b3ff8aa6b5ff86a3b1ff89a4b1ff8fa6b1ff97a9b0ffa1acb0ffa9afaeffb0b1adffb3b2abffb4b2aaffb2b1a9ffaeb0aaffa7adabff9fabadff97a9b0ff8fa7b3ff8aa5b4ff85a2b0ff87a3b0ff8da4afff96a6aeff9fa9adffa7ababffadada9ffb1aea7ffb2aea5ffb0ada5ffacaca6ffa5aaa8ff9da8abff95a7aeff8ea5b1ff89a4b4ff82a0afff85a1aeff8ba1adff93a2abff9ca4a9ffa4a5a6ffaaa6a3ffaea7a0ffafa79effada79effa8a6a0ffa2a5a3ff9aa4a7ff93a3acff8ca3b0ff87a2b2ff809eadff829eacff889eaaff909ea7ff989ea3ffa09d9fffa69e9affaa9e97ffaa9e95ffa89e95ffa49f98ff9e9f9dff979fa2ff909fa8ff899fadff859fb0ff7d9baaff7f9ba9ff849aa7ff8c98a2ff95979dff9c9596ffa29491ffa5948cffa6948affa4958bffa0978fff9a9895ff939a9dff8d9ba4ff879caaff839caeff7a99a8ff7c98a6ff8296a3ff89939dff919096ff998d8eff9e8b87ffa18a81ffa28a7fffa08c80ff9c8f86ff97928eff919497ff8a969fff8598a7ff8199abff7996a5ff7a95a3ff80929fff878e98ff8f8a90ff968686ff9b837dff9e8277ff9f8274ff9e8576ff9a887dff958c87ff8f8f91ff88929bff8395a3ff7f96a8ff7894a2ff7a93a0ff7f909bff868b94ff8d868bff948180ff9a7e76ff9d7c6eff9e7d6cff9d806eff998476ff948881ff8e8c8dff888f97ff82929fff7f93a5ff79929fff7a919dff7f8e98ff868991ff8d8487ff947f7cff9a7c72ff9d7b6aff9f7c67ff9e7f6aff9a8372ff95877dff8f8b89ff898e94ff83909cff7f91a1ff7b919cff7c909aff818d96ff87898eff8f8585ff96817aff9b7e70ff9f7d69ffa17f66ffa08169ff9d8471ff98887cff928b87ff8a8d91ff848f99ff7f909eff7d9099ff7f8f98ff838d94ff8a8a8dff918784ff98857bff9e8372ffa3836cffa58469ffa4866cffa18973ff9c8b7cff958c86ff8d8e8fff868e96ff818f9bff809097ff828f96ff868e92ff8c8c8cff948b85ff9b8a7dffa28a76ffa68a71ffa98b6fffa98d71ffa68e76ffa08f7eff998f86ff908f8eff888f94ff828e98ff839095ff858f94ff898f91ff8f8f8cff978f86ff9e8f80ffa5907affaa9176ffad9275ffad9376ffaa937affa49380ff9c9287ff93918dff8a8f92ff848e96ff869094ff879093ff8b9091ff92918dff999288ffa19483ffa8957effad977bffb0987affb1987bffae987effa89682ff9f9488ff96928dff8c9091ff858e94ff879093ff899093ff8d9190ff93938dff9b9489ffa29785ffaa9981ffaf9a7effb29c7dffb39c7effb09b80ffaa9984ffa19688ff97938dff8e9090ff868e93ff",
  },
];

function bytesToHex(bytes: Uint8ClampedArray): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]!;
    s += v < 16 ? "0" + v.toString(16) : v.toString(16);
  }
  return s;
}

describe("inlined blurhash decode is byte-equivalent to blurhash@2.0.5", () => {
  for (const sample of SAMPLES) {
    it(`${sample.hash.slice(0, 12)}… at ${sample.w}x${sample.h}`, () => {
      const pixels = decode(sample.hash, sample.w, sample.h);
      assert.equal(pixels.length, sample.w * sample.h * 4);
      assert.equal(bytesToHex(pixels), sample.hex);
    });
  }
});

describe("blurhash helpers", () => {
  it("decodeBlurhashToDataUri returns a PNG data URI", () => {
    const uri = decodeBlurhashToDataUri("L6PZfSi_.AyE_3t7t7R**0o#DgR4");
    assert.match(uri, /^data:image\/png;base64,/);
    // Base64 of a non-empty PNG with header → minimum length sanity check.
    assert.ok(uri.length > 200, `data URI suspiciously short: ${uri.length} chars`);
  });

  it("averageColorFromBlurhash returns a #RRGGBB color", () => {
    const color = averageColorFromBlurhash("L6PZfSi_.AyE_3t7t7R**0o#DgR4");
    assert.match(color, /^#[0-9a-f]{6}$/);
  });

  it("rejects too-short blurhash strings", () => {
    assert.throws(() => decodeBlurhashToDataUri("L6"), /at least 6 characters/);
  });

  it("rejects length-mismatched blurhash strings", () => {
    // First char "L" → sizeFlag=21 → 3*3 components → length must be 4+18=22
    assert.throws(() => decodeBlurhashToDataUri("LXXXXXX"), /length mismatch/);
  });
});

describe("package.json exports", () => {
  it("publishes `./blurhash` as a public subpath (regression guard for run402-private#414)", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      exports: Record<string, { types?: string; import?: string } | string>;
    };
    const entry = pkg.exports["./blurhash"];
    assert.ok(entry, "package.json `exports` is missing the `./blurhash` subpath");
    assert.equal(
      typeof entry === "object" ? entry.import : entry,
      "./dist/blurhash-decoder.js",
    );
    assert.equal(
      typeof entry === "object" ? entry.types : undefined,
      "./dist/blurhash-decoder.d.ts",
    );
  });
});
