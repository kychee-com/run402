import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DIAGNOSTIC_TELEMETRY_FIELDS,
  DIAGNOSTIC_TELEMETRY_MAX_EVENTS,
  buildDiagnosticTelemetryEvent,
  flushDiagnosticTelemetryQueue,
  queueBuzzDoctorTelemetry,
  readDiagnosticTelemetryQueue,
  writeDiagnosticTelemetryQueue,
} from "./diagnostic-telemetry.mjs";

function report({ ok = false } = {}) {
  return {
    ok,
    mode: "buzz",
    binding: {
      expected_subject_hex: "a".repeat(64),
      wallet_profile: "buzz-fizz",
      relay_origin: "wss://relay.private.example",
    },
    checks: [
      { name: "node_runtime", status: "ok", value: { major: 22, executable: "/private/node" } },
      { name: "run402_cli", status: "ok", value: { install_context: "global_npm", executable: "/private/run402" } },
      ...(ok ? [] : [{ name: "run402_api", status: "blocked", code: "BUZZ_PREFLIGHT_API_UNREACHABLE", message: "secret output" }]),
    ],
  };
}

function queueFile() {
  return join(mkdtempSync(join(tmpdir(), "run402-diag-")), "queue.json");
}

function eventId(index) {
  return `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`;
}

describe("Buzz diagnostic telemetry", () => {
  it("builds an exact allowlisted event and ignores sensitive report fields", () => {
    const event = buildDiagnosticTelemetryEvent({
      report: report(),
      event: "preflight_blocked",
      eventAt: "2026-07-31T12:00:00.000Z",
      eventId: eventId(1),
      platform: "darwin",
      run402Version: "4.16.1",
    });
    assert.deepEqual(Object.keys(event), DIAGNOSTIC_TELEMETRY_FIELDS);
    assert.deepEqual(event, {
      event_id: eventId(1),
      event_at: "2026-07-31T12:00:00.000Z",
      schema_version: 1,
      flow_version: "run402.buzz-doctor.v1",
      event: "preflight_blocked",
      check_name: "run402_api",
      code: "BUZZ_PREFLIGHT_API_UNREACHABLE",
      os_family: "macos",
      node_major: 22,
      run402_major: 4,
      run402_minor: 16,
      buzz_fixture_id: "buzz-cli-v0.5.2-capabilities",
      install_context: "user_global_npm",
    });
    const json = JSON.stringify(event);
    for (const forbidden of ["buzz-fizz", "relay.private.example", "/private/node", "/private/run402", "secret output", "a".repeat(64)]) {
      assert.equal(json.includes(forbidden), false);
    }
  });

  it("queues start plus final state without mutating the doctor verdict", () => {
    const path = queueFile();
    const original = report();
    const before = structuredClone(original);
    let launched = 0;
    let ids = 0;
    const disposition = queueBuzzDoctorTelemetry(original, {
      path,
      startedAt: Date.parse("2026-07-31T12:00:00.000Z"),
      finishedAt: Date.parse("2026-07-31T12:00:01.000Z"),
      createEventId: () => eventId(++ids),
      launchWorker: () => { launched += 1; },
      platform: "linux",
      run402Version: "4.16.1",
    });
    assert.deepEqual(disposition, { status: "queued", queued: true });
    assert.deepEqual(original, before);
    assert.equal(launched, 1);
    assert.deepEqual(readDiagnosticTelemetryQueue({ path, now: Date.parse("2026-07-31T12:00:02.000Z") }).map((entry) => entry.event), [
      "preflight_started",
      "preflight_blocked",
    ]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("opt-out sends nothing, queues nothing, and removes an old redacted queue", () => {
    const path = queueFile();
    writeFileSync(path, "old queue");
    let launched = 0;
    const disposition = queueBuzzDoctorTelemetry(report({ ok: true }), {
      env: { RUN402_TELEMETRY: "0" },
      path,
      launchWorker: () => { launched += 1; },
    });
    assert.deepEqual(disposition, { status: "disabled", queued: false });
    assert.equal(launched, 0);
    assert.deepEqual(readDiagnosticTelemetryQueue({ path }), []);
  });

  it("drops corrupt or unwritable queue state without changing diagnostics", () => {
    const path = queueFile();
    writeFileSync(path, "{not json");
    let ids = 0;
    const recovered = queueBuzzDoctorTelemetry(report({ ok: true }), {
      path,
      createEventId: () => eventId(++ids),
      launchWorker: () => { throw new Error("spawn denied"); },
    });
    assert.deepEqual(recovered, { status: "queued", queued: true });
    assert.equal(readDiagnosticTelemetryQueue({ path }).length, 2);

    const dropped = queueBuzzDoctorTelemetry(report(), {
      path: "/dev/null/not-writable.json",
      createEventId: () => eventId(++ids),
      launchWorker: () => {},
    });
    assert.deepEqual(dropped, { status: "dropped", queued: false });
  });

  it("bounds retained redacted events by age, count, and bytes", () => {
    const path = queueFile();
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const events = Array.from({ length: 48 }, (_, index) => buildDiagnosticTelemetryEvent({
      report: report({ ok: true }),
      event: "preflight_passed",
      eventAt: new Date(now - index * 1_000).toISOString(),
      eventId: eventId(index),
      run402Version: "4.16.1",
    }));
    assert.equal(writeDiagnosticTelemetryQueue(events, { path, now }), true);
    const retained = readDiagnosticTelemetryQueue({ path, now });
    assert.ok(retained.length <= DIAGNOSTIC_TELEMETRY_MAX_EVENTS);
    assert.ok(Buffer.byteLength(readFileSync(path)) <= 16 * 1024);
  });

  it("flushes without credentials and retains only retryable failures", async () => {
    const path = queueFile();
    const now = Date.now();
    const events = [1, 2].map((index) => buildDiagnosticTelemetryEvent({
      report: report({ ok: true }),
      event: "preflight_passed",
      eventAt: new Date(now).toISOString(),
      eventId: eventId(index),
      run402Version: "4.16.1",
    }));
    writeDiagnosticTelemetryQueue(events, { path, now });
    const requests = [];
    const first = await flushDiagnosticTelemetryQueue({
      path,
      apiOrigin: "https://api.run402.test",
      now,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return { status: requests.length === 1 ? 204 : 503 };
      },
    });
    assert.deepEqual(first, { sent: 1, retained: 1, status: "queued" });
    assert.equal(requests[0].url, "https://api.run402.test/client-diagnostic-events/v1");
    assert.deepEqual(requests[0].init.headers, { "content-type": "application/json" });
    assert.equal(Object.keys(JSON.parse(requests[0].init.body)).length, DIAGNOSTIC_TELEMETRY_FIELDS.length);

    const second = await flushDiagnosticTelemetryQueue({
      path,
      apiOrigin: "https://api.run402.test",
      fetchImpl: async () => ({ status: 204 }),
    });
    assert.deepEqual(second, { sent: 1, retained: 0, status: "flushed" });
  });
});
