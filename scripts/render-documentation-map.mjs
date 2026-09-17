#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const inventory=JSON.parse(readFileSync(resolve(root,'docs/quality/documentation-inventory.json'),'utf8'));
let text=readFileSync(resolve(root,'docs/quality/documentation-policy.md'),'utf8').trim()+'\n\n## Per-file sources\n\n| Repo | Source | Purpose / interface | Editorial | Publication |\n|---|---|---|---|---|\n';
for(const e of [...inventory.entries,...inventory.external])text+=`| ${e.repository} | ${e.repository==='public'?`[${e.path}](${e.path})`:`\`${e.path}\``} | ${e.purpose} / ${e.interface} | ${e.evidence.editorial} | ${e.evidence.publication} |\n`;
const output=resolve(root,'documentation.md');if(process.argv.includes('--check')){if(readFileSync(output,'utf8')!==text)throw Error('documentation.md is stale; run node scripts/render-documentation-map.mjs');}else writeFileSync(output,text);
