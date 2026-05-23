#!/usr/bin/env node
import { run } from "../../cli/lib/logs.mjs";
await run(process.argv.slice(2));
