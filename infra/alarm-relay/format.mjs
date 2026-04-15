export function formatMessage(alarm, region = "us-east-1") {
  const icon = alarm.NewStateValue === "OK" ? "✅" : "🚨";
  const encoded = encodeURIComponent(alarm.AlarmName);
  const dash = `https://console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encoded}`;
  const threshold = alarm.Trigger
    ? `${alarm.Trigger.MetricName ?? "?"} ${alarm.Trigger.ComparisonOperator ?? ""} ${alarm.Trigger.Threshold ?? ""}`
    : "(threshold unavailable)";
  return [
    `${icon} run402-alarms`,
    `Alarm: ${alarm.AlarmName}`,
    `State: ${alarm.NewStateValue}  (was ${alarm.OldStateValue})`,
    `Reason: ${alarm.NewStateReason}`,
    `Metric: ${threshold}`,
    `Time: ${alarm.StateChangeTime}`,
    `Dashboard: ${dash}`,
  ].join("\n");
}
