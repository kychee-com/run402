import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getDeploymentUrl,
  getSubdomainUrl,
  parseDeploymentHost,
  parseManagedSubdomain,
} from "./public-urls.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("public URLs", () => {
  it("returns production URLs by default", () => {
    delete process.env.RUN402_LOCALHOST_PUBLIC_URLS;
    assert.equal(getDeploymentUrl("dpl_123_abc"), "https://dpl-123-abc.sites.run402.com");
    assert.equal(getSubdomainUrl("myapp"), "https://myapp.run402.com");
  });

  it("returns localhost-based URLs in local dev mode", () => {
    process.env.RUN402_LOCALHOST_PUBLIC_URLS = "1";
    process.env.PORT = "7777";
    assert.equal(getDeploymentUrl("dpl_123_abc"), "http://dpl-123-abc.sites.run402.com.localhost:7777");
    assert.equal(getSubdomainUrl("myapp"), "http://myapp.run402.com.localhost:7777");
  });
});

describe("host parsing", () => {
  it("parses deployment hosts for prod and localhost aliases", () => {
    assert.equal(parseDeploymentHost("dpl-123-abc.sites.run402.com"), "dpl_123_abc");
    assert.equal(parseDeploymentHost("dpl-123-abc.sites.run402.com.localhost"), "dpl_123_abc");
  });

  it("parses managed subdomains for prod and localhost aliases", () => {
    assert.equal(parseManagedSubdomain("myapp.run402.com"), "myapp");
    assert.equal(parseManagedSubdomain("myapp.run402.com.localhost"), "myapp");
  });
});
