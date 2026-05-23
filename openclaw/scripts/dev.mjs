#!/usr/bin/env node
import { run } from "../../cli/lib/dev.mjs";
await run(process.argv.slice(2));
