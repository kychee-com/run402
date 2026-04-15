import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessage } from "./format.mjs";

const cwAlarm = {
  AlarmName: "Run402GatewayMemoryHigh",
  NewStateValue: "ALARM",
  OldStateValue: "OK",
  NewStateReason: "Threshold Crossed: 1 datapoint [92.5] was greater than the threshold (80.0)",
  StateChangeTime: "2026-04-15T07:23:00.000+0000",
  Trigger: {
    MetricName: "MemoryUtilization",
    ComparisonOperator: "GreaterThanThreshold",
    Threshold: 80,
  },
};

test("formats ALARM state with 🚨 prefix and all fields", () => {
  const text = formatMessage(cwAlarm, "us-east-1");
  assert.match(text, /^🚨 run402-alarms$/m);
  assert.match(text, /^Alarm: Run402GatewayMemoryHigh$/m);
  assert.match(text, /^State: ALARM {2}\(was OK\)$/m);
  assert.match(text, /^Reason: Threshold Crossed/m);
  assert.match(text, /^Metric: MemoryUtilization GreaterThanThreshold 80$/m);
  assert.match(text, /^Time: 2026-04-15T07:23:00\.000\+0000$/m);
  assert.match(
    text,
    /https:\/\/console\.aws\.amazon\.com\/cloudwatch\/home\?region=us-east-1#alarmsV2:alarm\/Run402GatewayMemoryHigh/,
  );
  assert.equal(text.split("\n").length, 7);
});

test("formats OK recovery with ✅ prefix", () => {
  const ok = { ...cwAlarm, NewStateValue: "OK", OldStateValue: "ALARM" };
  const text = formatMessage(ok, "us-east-1");
  assert.match(text, /^✅ run402-alarms$/m);
  assert.match(text, /^State: OK {2}\(was ALARM\)$/m);
});

test("URL-encodes alarm names with special characters in dashboard link", () => {
  const weird = { ...cwAlarm, AlarmName: "Run402 Test Alarm/5xx" };
  const text = formatMessage(weird, "eu-west-1");
  assert.match(text, /alarmsV2:alarm\/Run402%20Test%20Alarm%2F5xx/);
  assert.match(text, /region=eu-west-1/);
});

test("degrades gracefully when Trigger is missing", () => {
  const partial = { ...cwAlarm, Trigger: undefined };
  const text = formatMessage(partial, "us-east-1");
  assert.match(text, /^Metric: \(threshold unavailable\)$/m);
});
