import { saveProject } from "./keystore.js";

const [, , storePath, id] = process.argv;
if (!storePath || !id) {
  console.error("usage: keystore.test.worker.ts <storePath> <id>");
  process.exit(2);
}
saveProject(id, { anon_key: `ak-${id}`, service_key: `sk-${id}` }, storePath);
