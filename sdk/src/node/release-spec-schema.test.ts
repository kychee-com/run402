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

  it("documents FunctionSpec schedule and rejects deps by shape", () => {
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
    assert.equal(Object.hasOwn(functionSpec.properties, "deps"), false);
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
});
