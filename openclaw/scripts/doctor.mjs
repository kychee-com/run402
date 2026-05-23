#!/usr/bin/env node
import { run } from "../../cli/lib/doctor.mjs";
await run(process.argv.slice(2));
