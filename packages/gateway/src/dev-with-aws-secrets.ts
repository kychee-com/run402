import { loadDevSecretsFromAws } from "./dev-secrets.js";

await loadDevSecretsFromAws();
await import("./server.js");
