import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ROOT, "..");
const SKILL = readFileSync(join(ROOT, "SKILL.md"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

function files(directory = ROOT) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [path];
    if (entry.isDirectory() && [".git", ".claude", ".codex", "node_modules", "dist"].includes(entry.name)) return [];
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe("run402-buzz distributable package", () => {
  it("has valid external-name frontmatter and bounded discovery triggers", () => {
    const frontmatter = SKILL.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter);
    assert.match(frontmatter[1], /^name: run402-buzz$/m);
    assert.match(frontmatter[1], /install the run402\.com skill/);
    assert.match(frontmatter[1], /install, initialize, set up, or connect Run402/);
    assert.match(frontmatter[1], /later asks.*build, deploy, update, verify, or operate/);
  });

  it("documents first-party, runtime-specific installation and bounded fallback", () => {
    const installation = readFileSync(join(ROOT, "references", "installation.md"), "utf8");
    const docs = `${README}\n${installation}`;
    assert.match(docs, /working_directory: <user-home>\/\.buzz/);
    assert.match(docs, /environment: \{ "DO_NOT_TRACK": "1" \}/);
    assert.match(docs, /command: npx --yes skills@latest add https:\/\/run402\.com -s run402-buzz -a <target\.\.\.> -y/);
    assert.match(docs, /POSIX `sh`\/Bash\/zsh/);
    assert.match(docs, /DO_NOT_TRACK=1 npx --yes skills@latest add https:\/\/run402\.com -s run402-buzz -a <target> -y/);
    assert.match(docs, /Windows PowerShell/);
    assert.match(docs, /\$env:DO_NOT_TRACK = '1'/);
    assert.match(docs, /Windows `cmd\.exe`/);
    assert.match(docs, /set "DO_NOT_TRACK=1"/);
    assert.match(docs, /Do not paste a POSIX `NAME=value command` prefix into an unknown shell/);
    assert.match(docs, /-a claude-code codex/);
    assert.match(docs, /Claude Code \| `claude-code` \| `\.claude\/skills\/run402-buzz`/);
    assert.match(docs, /Goose \| `goose` \| `\.goose\/skills\/run402-buzz`/);
    assert.match(docs, /`universal`.*`\.agents\/skills`/s);
    assert.match(docs, /GitHub.*only after a classified availability failure/s);
    assert.match(docs, /Never fall back after an integrity failure/);
    assert.match(docs, /Please install the run402\.com skill/);
    assert.match(docs, /https:\/\/run402\.com\/install\.txt/);
    assert.match(docs, /Never describe `kychee-com\/run402\/buzz` as the first-party artifact origin/);
    assert.match(docs, /Never report a user-global runtime directory/);
    assert.match(docs, /mutation_state: \"not_started\"/);
    assert.doesNotMatch(docs, /^DO_NOT_TRACK=.*-a claude(?:\s|$)/m);
  });

  it("contains only bounded regular Markdown, JSON, and JavaScript files", () => {
    const all = files();
    assert.ok(all.length >= 8);
    for (const file of all) {
      const stat = lstatSync(file);
      assert.ok(stat.isFile(), `${file} must be a regular file`);
      assert.ok(stat.size <= 128 * 1024, `${file} exceeds package size bound`);
      assert.ok([".md", ".json", ".mjs"].includes(extname(file)), `${file} has an unsupported type`);
    }
  });

  it("keeps every local Markdown reference inside the installed package", () => {
    for (const match of SKILL.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = resolve(ROOT, match[1]);
      assert.equal(relative(ROOT, target).startsWith(".."), false, match[1]);
      assert.ok(existsSync(target), match[1]);
    }
    assert.doesNotMatch(SKILL, /integrations\/run402-for-buzz|\.\.\//);
    assert.match(SKILL, /node <skill-directory>\/scripts\/setup\.mjs/);
    assert.match(SKILL, /--wallet <profile>/);
    for (const dependency of [
      "scripts/setup.mjs",
      "scripts/buzz-publish-proof.mjs",
      "scripts/doctor-report.mjs",
      "scripts/strict-json.mjs",
      "fixtures/buzz-v0.5.2-cli-capabilities.json",
      "fixtures/buzz-v0.5.2-browser-fragment-v1.json",
      "fixtures/run402-buzz-doctor-v1-contract.json",
      "references/identity-and-security.md",
      "references/preflight.md",
      "references/community-control-plane.md",
      "references/conversations.md",
      "references/receipts.md",
      "references/installation.md",
    ]) assert.ok(existsSync(join(ROOT, dependency)), dependency);
  });

  it("has one canonical Buzz skill and cannot collide with the generic root skill", () => {
    assert.equal(existsSync(join(REPO, "integrations/run402-for-buzz/.agents/skills/run402/SKILL.md")), false);
    const rootSkill = readFileSync(join(REPO, "SKILL.md"), "utf8");
    assert.match(rootSkill, /^name: run402$/m);
    assert.match(SKILL, /^name: run402-buzz$/m);
    assert.notEqual(rootSkill.match(/^name: (.+)$/m)?.[1], SKILL.match(/^name: (.+)$/m)?.[1]);
    const buzzSkills = files(REPO)
      .filter((file) => file.endsWith("SKILL.md"))
      .filter((file) => lstatSync(file).isFile())
      .filter((file) => /^name: run402-buzz$/m.test(readFileSync(file, "utf8")));
    assert.deepEqual(buzzSkills.map((file) => normalize(file)), [normalize(join(ROOT, "SKILL.md"))]);
  });

  it("keeps file installation inert while canonical Buzz onboarding continues to the real approval boundary", () => {
    const disclosure = SKILL.indexOf("## Public-link disclosure");
    const setup = SKILL.indexOf("## Set up Run402");
    const ready = SKILL.indexOf("## Offer one contextual test");
    const approved = SKILL.indexOf("## Build and deploy only after approval");
    assert.ok(disclosure < setup && setup < ready && ready < approved);
    assert.match(SKILL, /Copying, updating, or discovering the skill files performs no setup/);
    assert.match(SKILL, /canonical request `Please install the run402\.com skill` is nevertheless a goal-shaped request/);
    assert.match(SKILL, /continue with the setup workflow below in the current turn/);
    assert.match(SKILL, /Do not say that the skill will be available on the next turn/);
    assert.match(SKILL, /do not ask a separate setup question/);
    assert.match(SKILL, /Do not build anything until the user affirmatively agrees/);
    assert.match(SKILL, /plan\/rehearsal path before apply/);
    assert.match(SKILL, /Independently request the live endpoint/);
    assert.match(SKILL, /run402 wallets new <profile>/);
    assert.match(SKILL, /selection_source: explicit_argument/);
    assert.match(SKILL, /do not rely on ambient selection/);
    assert.match(SKILL, /doctor --buzz --buzz-agent/);
    assert.match(SKILL, /environment readiness only/);
  });

  it("freezes the demo-first and explicit early-adoption conversations", () => {
    const conversations = readFileSync(join(ROOT, "references", "conversations.md"), "utf8");
    const demoFirst = conversations.slice(
      conversations.indexOf("## Canonical demo-first conversation"),
      conversations.indexOf("## Explicit early-adoption conversation"),
    );
    assert.ok(demoFirst.indexOf("Would you like me to build and deploy") < demoFirst.indexOf("verified it at https://church.run402.com"));
    assert.ok(demoFirst.indexOf("verified it at https://church.run402.com") < demoFirst.indexOf("\[Become an owner\]\(https://console.run402.com"));
    assert.match(demoFirst, /I remain the founder-agent owner/);
    assert.doesNotMatch(demoFirst, /Would you like me to set up Run402|available on (the )?next turn|Installed from run402\.com/i);
    assert.doesNotMatch(demoFirst, /\$0\.10|price|cost|purchase|terminal|buzz:\/\//i);

    const early = conversations.slice(conversations.indexOf("## Explicit early-adoption conversation"));
    assert.ok(early.indexOf("Before the demo") < early.indexOf("Become an owner: https://console.run402.com"));
    assert.match(early, /I remain an owner/);
    assert.doesNotMatch(early, /\$0\.10|price|cost|purchase|terminal|buzz:\/\//i);
  });

  it("bootstraps shell, Node 22+, npm, and Run402 before setup mutation", () => {
    const preflight = readFileSync(join(ROOT, "references", "preflight.md"), "utf8");
    assert.match(preflight, /first executable setup stage/);
    assert.match(preflight, /Node must be 22 or newer/);
    assert.match(preflight, /Run402 \*\*4\.17\.2 or newer\*\*/);
    assert.match(preflight, /npm install -g run402@latest/);
    assert.match(preflight, /Do not run an older doctor's relay repair or present it to the human/);
    assert.match(preflight, /rerun the entire bootstrap and doctor in the same turn/);
    assert.match(preflight, /BUZZ_PREFLIGHT_SHELL_UNAVAILABLE/);
    assert.match(preflight, /BUZZ_PREFLIGHT_NODE_UNAVAILABLE/);
    assert.match(preflight, /BUZZ_PREFLIGHT_NODE_INCOMPATIBLE/);
    assert.match(preflight, /BUZZ_PREFLIGHT_RUN402_UNAVAILABLE/);
    assert.match(preflight, /mutation_state: "not_started"/);
    assert.match(preflight, /human is not asked to paste it/);
    assert.match(preflight, /BUZZ_PREFLIGHT_RELAY_UNSAFE.*blocking/s);
    assert.match(preflight, /BUZZ_PREFLIGHT_RELAY_UNREACHABLE.*warning/s);
    assert.match(preflight, /tls_handshake_failed/);
    assert.match(preflight, /do not tell the human to reconnect/);
    assert.doesNotMatch(preflight, /brew install|cargo install|curl .*buzz/i);
  });

  it("contains no embedded secret values or secret-export instructions", () => {
    const content = files()
      .filter((file) => !file.endsWith(".test.mjs"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    assert.doesNotMatch(content, /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/i);
    assert.doesNotMatch(content, /(?:private[_ -]?key|mnemonic|seed)\s*[:=]\s*["'][^"']{8,}["']/i);
    assert.match(SKILL, /Never request, read, locate, export, transform, derive, print, log, or post/);
  });

  it("has balanced Markdown fences", () => {
    assert.equal((SKILL.match(/^```/gm) ?? []).length % 2, 0);
  });

  it("freezes the unchanged Buzz v0.5.2 community-authority boundary", () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, "fixtures/buzz-v0.5.2-community-authority.json"), "utf8"));
    const eventId = (event) => createHash("sha256")
      .update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
      .digest("hex");
    const verifies = (event) => event.id === eventId(event)
      && schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex"));
    assert.equal(fixture.buzz.version, "0.5.2");
    assert.equal(fixture.buzz.release_tag_commit, "3e48f1b2365d326ee1c9582448d86a99b44ecd5d");
    assert.equal(fixture.buzz.custom_run402_capability_required, false);
    assert.equal(fixture.relay.normalized_community_subject, "buzz:community:acme.communities.buzz.xyz");
    assert.ok(fixture.relay.nip11.supported_nips.includes(43));
    assert.equal(fixture.relay.nip11.self, fixture.membership_event.pubkey);
    assert.equal(fixture.approval_event.kind, 1);
    assert.equal(fixture.approval_event.content, fixture.approval_content);
    assert.equal(fixture.approval_event.pubkey, fixture.authority.pubkey);
    assert.equal(fixture.membership_event.kind, 13534);
    assert.deepEqual(fixture.membership_event.tags[0], ["-"]);
    assert.deepEqual(fixture.membership_event.tags[1], ["member", fixture.authority.pubkey, "owner"]);
    assert.equal(verifies(fixture.approval_event), true);
    assert.equal(verifies(fixture.membership_event), true);
    assert.deepEqual(fixture.forbidden_custom_dependencies, {
      event_kinds: [],
      nip11_extensions: [],
      deep_links: [],
      desktop_surfaces: [],
      buzz_release_required: false,
    });
  });

  it("freezes the unchanged Buzz v0.5.2 browser-fragment owner-consent boundary", () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, "fixtures/buzz-v0.5.2-browser-fragment-v1.json"), "utf8"));
    const signed = JSON.parse(readFileSync(join(ROOT, "fixtures/buzz-v0.4.26-desktop-owner-negative.json"), "utf8")).event;
    assert.equal(fixture.buzz_release.version, "0.5.2");
    assert.equal(fixture.buzz_release.release_tag_commit, "3e48f1b2365d326ee1c9582448d86a99b44ecd5d");
    assert.equal(fixture.buzz_release.run402_change_required, false);
    assert.equal(fixture.deep_link.return_mode, "browser_fragment_v1");
    assert.equal(fixture.deep_link.verification_code_pattern, "^[0-9]{6}$");
    assert.equal(fixture.deep_link.callback_requirements.same_scheme_host_effective_port_as_origin, true);
    assert.equal(fixture.signed_event.signing_principal, "desktop_owner");
    assert.equal(fixture.signed_event.expected_kind, 24243);
    assert.equal(fixture.expiry.expired_link_reaches_consent_surface, true);
    assert.equal(fixture.expiry.expired_request_signing_rejected, true);
    assert.equal(fixture.browser_callback.fragment_key, "buzz_bind");
    assert.equal(fixture.browser_callback.payload_version, "v1");
    const example = fixture.browser_callback.encoding_example;
    const callback = new URL(example.callback_url);
    callback.hash = `buzz_bind=v1.${Buffer.from(JSON.stringify(signed), "utf8").toString("base64url")}`;
    assert.equal(callback.origin, example.expected_origin);
    assert.equal(callback.pathname, example.expected_path);
    assert.equal(callback.search, example.expected_query);
    assert.equal(callback.hash, example.expected_fragment);
    const encoded = callback.hash.slice("#buzz_bind=v1.".length);
    assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), signed);
    assert.equal(fixture.browser_callback.manual_fallback.available_after_browser_open_failure, true);
    assert.deepEqual(fixture.forbidden_run402_dependencies, {
      buzz_code_change: false,
      custom_event_kind: false,
      custom_desktop_route: false,
      relay_handler: false,
      runtime_flag: false,
      new_buzz_release: false,
    });
  });
});
