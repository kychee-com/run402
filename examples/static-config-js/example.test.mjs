import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("static-config-js example", () => {
  it("normalizes as a v2 release manifest with the notes table exposed and index.html as the site", () => {
    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import { loadDeployManifest } from "../../sdk/src/node/deploy-manifest.ts";
        const out = await loadDeployManifest("run402.json", { defaultProject: "prj_example" });
        console.log(JSON.stringify({
          migrations: out.spec.database.migrations.map((m) => m.id),
          tables: out.spec.database.expose.tables,
          site: Object.keys(out.spec.site.replace),
          subdomains: out.spec.subdomains ?? null,
        }));
      `,
    ], { cwd: ROOT, encoding: "utf8" });
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed.migrations, ["001_notes", "002_seed_notes"]);
    assert.deepEqual(parsed.tables, [{ name: "notes", expose: true, policy: "public_read_authenticated_write" }]);
    assert.deepEqual(parsed.site, ["index.html"]);
    assert.equal(parsed.subdomains, null, "up --name claims the host; the manifest carries no subdomains block");
  });

  it("reads only the documented window.RUN402 fields and never pastes a key", () => {
    const html = read("index.html");
    assert.match(html, /<script src="\/_run402\/config\.js"><\/script>/);
    assert.match(html, /const \{ project_id, api_base, anon_key \} = window\.RUN402;/);
    assert.match(html, /\$\{api_base\}\/rest\/v1\/notes\?select=\*/);
    assert.match(html, /apikey: anon_key/);
    assert.match(html, /Authorization: `Bearer \$\{anon_key\}`/);
    const fields = [...html.matchAll(/window\.RUN402\.([a-z_]+)/g)].map((m) => m[1]);
    for (const field of fields) assert.ok(["project_id", "api_base", "anon_key"].includes(field), `undocumented field ${field}`);
    assert.doesNotMatch(html, /service_key/);
    assert.doesNotMatch(html, /eyJ[A-Za-z0-9_-]{20,}/, "no pasted JWT");
  });
});
