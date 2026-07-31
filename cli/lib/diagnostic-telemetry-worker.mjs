import { flushDiagnosticTelemetryQueue } from "./diagnostic-telemetry.mjs";

const [, , path, apiOrigin] = process.argv;
await flushDiagnosticTelemetryQueue({ path, apiOrigin });
