/**
 * Unit tests for the v1.50 client-side validators in
 * {@link ./assets-validation.ts}. Every rejection must surface with the
 * same `code` the gateway returns for the equivalent server-side
 * rejection so consumers can branch on `e.code` regardless of where the
 * rejection happened.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LocalError } from "../errors.js";
import { ASSET_FILTER_KEYS } from "./assets.types.js";
import {
  ASSET_METADATA_MAX_BYTES,
  appendAssetFilterTo,
  assertAssetFilter,
  assertAssetMetadata,
  assertAssetSortKey,
  assertExifPolicy,
} from "./assets-validation.js";

function catchLocal(fn: () => void): LocalError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LocalError) return e;
    throw new Error(`Expected LocalError, got ${e}`);
  }
  throw new Error("Expected LocalError, got no throw");
}

describe("assertAssetMetadata", () => {
  it("accepts a flat object with string / number / boolean / string[] leaves", () => {
    assert.doesNotThrow(() =>
      assertAssetMetadata(
        {
          uploaded_by: "agent_abc",
          version: 3,
          published: true,
          tags: ["hero", "banner"],
        },
        "uploading asset",
      ),
    );
  });

  it("throws INVALID_ASSET_METADATA when value is null", () => {
    const e = catchLocal(() => assertAssetMetadata(null, "uploading asset"));
    assert.equal(e.code, "INVALID_ASSET_METADATA");
  });

  it("throws INVALID_ASSET_METADATA when value is an array", () => {
    const e = catchLocal(() => assertAssetMetadata([1, 2, 3], "uploading asset"));
    assert.equal(e.code, "INVALID_ASSET_METADATA");
  });

  it("throws INVALID_ASSET_METADATA when a leaf is a nested object", () => {
    const e = catchLocal(() =>
      assertAssetMetadata({ nested: { not: "allowed" } }, "uploading asset"),
    );
    assert.equal(e.code, "INVALID_ASSET_METADATA");
  });

  it("throws INVALID_ASSET_METADATA when a leaf is null", () => {
    const e = catchLocal(() =>
      assertAssetMetadata({ tags: null as unknown as string[] }, "uploading asset"),
    );
    assert.equal(e.code, "INVALID_ASSET_METADATA");
  });

  it("throws INVALID_ASSET_METADATA when a leaf is undefined", () => {
    const e = catchLocal(() =>
      assertAssetMetadata({ x: undefined as unknown as string }, "uploading asset"),
    );
    assert.equal(e.code, "INVALID_ASSET_METADATA");
  });

  it("throws INVALID_ASSET_METADATA when a string[] leaf contains a non-string", () => {
    const e = catchLocal(() =>
      assertAssetMetadata({ tags: ["ok", 7 as unknown as string] }, "uploading asset"),
    );
    assert.equal(e.code, "INVALID_ASSET_METADATA");
  });

  it("throws INVALID_ASSET_METADATA when serialized size > 4 KB", () => {
    const big = "x".repeat(ASSET_METADATA_MAX_BYTES + 1);
    const e = catchLocal(() =>
      assertAssetMetadata({ huge: big }, "uploading asset"),
    );
    assert.equal(e.code, "INVALID_ASSET_METADATA");
  });

  it("accepts empty object", () => {
    assert.doesNotThrow(() => assertAssetMetadata({}, "uploading asset"));
  });
});

describe("assertExifPolicy", () => {
  it("accepts 'keep' and 'strip'", () => {
    assert.doesNotThrow(() => assertExifPolicy("keep", "uploading asset"));
    assert.doesNotThrow(() => assertExifPolicy("strip", "uploading asset"));
  });

  it("rejects unknown values with INVALID_EXIF_POLICY", () => {
    for (const bad of ["", "drop", "KEEP", null, undefined, 0, true]) {
      const e = catchLocal(() =>
        assertExifPolicy(bad as unknown, "uploading asset"),
      );
      assert.equal(e.code, "INVALID_EXIF_POLICY");
    }
  });
});

describe("assertAssetSortKey", () => {
  it("accepts the three documented sort keys", () => {
    assert.doesNotThrow(() => assertAssetSortKey("key:asc", "listing assets"));
    assert.doesNotThrow(() => assertAssetSortKey("createdAt:asc", "listing assets"));
    assert.doesNotThrow(() => assertAssetSortKey("createdAt:desc", "listing assets"));
  });

  it("rejects unknown sort keys with INVALID_SORT", () => {
    for (const bad of ["", "size", "key:desc", "name:asc", null, undefined]) {
      const e = catchLocal(() =>
        assertAssetSortKey(bad as unknown, "listing assets"),
      );
      assert.equal(e.code, "INVALID_SORT");
    }
  });
});

describe("assertAssetFilter", () => {
  it("accepts the 8 documented filter keys with correct value types", () => {
    assert.doesNotThrow(() =>
      assertAssetFilter(
        {
          uploaded_by: "agent_abc",
          tag: "hero",
          format: "webp",
          is_image: true,
          min_width: 100,
          max_width: 4096,
          min_height: 100,
          max_height: 4096,
        },
        "listing assets",
      ),
    );
  });

  it("documents exactly 8 filter keys", () => {
    assert.equal(ASSET_FILTER_KEYS.size, 8);
  });

  it("rejects unknown filter keys with INVALID_FILTER_KEY", () => {
    const e = catchLocal(() =>
      assertAssetFilter({ uploadedBy: "x" }, "listing assets"),
    );
    assert.equal(e.code, "INVALID_FILTER_KEY");
  });

  it("rejects boolean filter with non-boolean value", () => {
    const e = catchLocal(() =>
      assertAssetFilter({ is_image: "yes" as unknown as boolean }, "listing assets"),
    );
    assert.equal(e.code, "INVALID_FILTER_KEY");
  });

  it("rejects width/height filter with non-integer or negative value", () => {
    const e1 = catchLocal(() =>
      assertAssetFilter(
        { min_width: 1.5 as unknown as number },
        "listing assets",
      ),
    );
    assert.equal(e1.code, "INVALID_FILTER_KEY");
    const e2 = catchLocal(() =>
      assertAssetFilter({ max_height: -1 }, "listing assets"),
    );
    assert.equal(e2.code, "INVALID_FILTER_KEY");
  });

  it("rejects empty-string string filter values", () => {
    const e = catchLocal(() =>
      assertAssetFilter({ uploaded_by: "" }, "listing assets"),
    );
    assert.equal(e.code, "INVALID_FILTER_KEY");
  });

  it("accepts empty filter object", () => {
    assert.doesNotThrow(() => assertAssetFilter({}, "listing assets"));
  });
});

describe("appendAssetFilterTo", () => {
  it("serializes filters as filter[<key>] query params", () => {
    const qs = new URLSearchParams();
    appendAssetFilterTo(qs, {
      uploaded_by: "agent_abc",
      tag: "hero",
      is_image: true,
      min_width: 320,
    });
    assert.equal(qs.get("filter[uploaded_by]"), "agent_abc");
    assert.equal(qs.get("filter[tag]"), "hero");
    assert.equal(qs.get("filter[is_image]"), "true");
    assert.equal(qs.get("filter[min_width]"), "320");
  });

  it("renders booleans as 'true' / 'false'", () => {
    const qs = new URLSearchParams();
    appendAssetFilterTo(qs, { is_image: false });
    assert.equal(qs.get("filter[is_image]"), "false");
  });

  it("skips undefined values", () => {
    const qs = new URLSearchParams();
    appendAssetFilterTo(qs, { tag: undefined });
    assert.equal(qs.toString(), "");
  });
});
