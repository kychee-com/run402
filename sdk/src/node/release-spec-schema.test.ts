import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "../../../schemas/release-spec.v1.json");

function readSchema(): Record<string, any> {
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

describe("ReleaseSpec JSON Schema", () => {
  it("is published at the canonical schema URL", () => {
    const schema = readSchema();

    assert.equal(schema.$id, "https://run402.com/schemas/release-spec.v1.json");
    assert.equal(schema.properties.$schema.type, "string");
    assert.ok(schema.properties.project);
    assert.ok(schema.properties.project_id);
  });

  it("documents FunctionSpec scheduling, deps, gates, and rejects unknown fields", () => {
    const schema = readSchema();
    const functionSpec = schema.$defs.functionSpec;

    assert.ok(functionSpec.properties.runtime);
    assert.ok(functionSpec.properties.source);
    assert.ok(functionSpec.properties.files);
    assert.ok(functionSpec.properties.entrypoint);
    assert.ok(functionSpec.properties.config.properties.timeoutSeconds);
    assert.ok(functionSpec.properties.config.properties.memoryMb);
    assert.ok(functionSpec.properties.schedule);
    assert.equal(functionSpec.additionalProperties, false);
    assert.equal(functionSpec.properties.deps.items.type, "string");
    assert.ok(functionSpec.properties.triggers.items.$ref);
    assert.equal(functionSpec.properties.requireAuth.type, "boolean");
    assert.equal(functionSpec.properties.require_auth.type, "boolean");
    assert.ok(functionSpec.properties.requireRole.oneOf);
    assert.ok(functionSpec.properties.require_role.oneOf);
    assert.deepEqual(functionSpec.properties.class.enum, ["ssr", "standard"]);
    assert.equal(functionSpec.properties.capabilities.items.type, "string");
  });

  it("covers public paths, routes, subdomains, and known cache class documentation", () => {
    const schema = readSchema();

    assert.ok(schema.$defs.sitePublicPaths);
    assert.ok(schema.$defs.routes);
    assert.ok(schema.$defs.route.properties.target);
    assert.ok(schema.$defs.subdomains.properties.set);
    assert.ok(schema.$defs.subdomains.properties.add);
    assert.ok(schema.$defs.subdomains.properties.remove);
    assert.match(schema.$defs.staticCacheClass.description, /html/);
    assert.match(schema.$defs.staticCacheClass.description, /immutable_versioned/);
    assert.match(schema.$defs.staticCacheClass.description, /revalidating_asset/);
  });

  it("declares routed-locale-context i18n slice with the platform's tag/cookie rules", () => {
    const schema = readSchema();
    assert.ok(schema.properties.i18n, "i18n is a top-level property");

    const i18n = schema.$defs.i18n;
    assert.ok(i18n, "$defs.i18n is defined");
    assert.equal(i18n.additionalProperties, false);
    assert.deepEqual(i18n.required, ["defaultLocale", "locales"]);
    assert.equal(i18n.properties.defaultLocale.pattern, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    assert.equal(i18n.properties.locales.minItems, 1);
    assert.equal(i18n.properties.locales.maxItems, 50);
    assert.equal(i18n.properties.locales.items.pattern, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    assert.equal(i18n.properties.detect.maxItems, 10);
    assert.equal(
      i18n.properties.detect.items.pattern,
      "^(accept-language|cookie:[!#$%&'*+\\-.^_`|~0-9A-Za-z]+)$",
    );

    // Top-level i18n accepts null (clear-the-slice) per the carry-forward
    // semantics shipped with v2.5.
    const oneOf = schema.properties.i18n.oneOf;
    assert.ok(Array.isArray(oneOf));
    assert.ok(oneOf.some((entry: { type?: string }) => entry.type === "null"));
  });
});
