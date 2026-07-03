import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleAddCustomDomain } from "./add-custom-domain.js";
import { handleListCustomDomains } from "./list-custom-domains.js";
import { handleCheckDomainStatus } from "./check-domain-status.js";
import { handleRemoveCustomDomain } from "./remove-custom-domain.js";

describe("removed custom-domain MCP compatibility handlers", () => {
  it("reports replacement ProjectDomain tools without network work", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const add = await handleAddCustomDomain({
        domain: "example.com",
        subdomain_name: "myapp",
        project_id: "prj_123",
      });
      const list = await handleListCustomDomains({ project_id: "prj_123" });
      const check = await handleCheckDomainStatus({
        domain: "example.com",
        project_id: "prj_123",
      });
      const remove = await handleRemoveCustomDomain({
        domain: "example.com",
        project_id: "prj_123",
      });

      for (const result of [add, list, check, remove]) {
        assert.equal(result.isError, true);
        assert.match(result.content[0]!.text, /domains_/);
      }
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
