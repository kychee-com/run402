#!/usr/bin/env node
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {COMMAND_MANIFEST} from '../cli/lib/command-manifest.mjs';
const root=resolve(import.meta.dirname,'..'),prefix='docs-site/src/content/docs/';
const read=p=>readFileSync(resolve(root,p),'utf8');
const commands=[...COMMAND_MANIFEST].sort((a,b)=>b.path.length-a.path.length);
export function checkCli(line){const argv=line.trim().split(/\s+/).slice(1);if(argv[0]==='--version')return [];const entry=commands.find(c=>c.path.every((p,i)=>argv[i]===p));if(!entry){if(argv.includes('--help')&&existsSync(resolve(root,`cli/lib/${argv[0]}.mjs`)))return [];return ['unsupported command'];}
 const file=entry.path[0]==='deploy'?'deploy-v2':entry.path[0];const source=read(`cli/lib/${file}.mjs`);const flags=[...line.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*|-[yvh])(?=[\s=]|$)/g)].map(m=>m[1]);return flags.filter(f=>!['--project','--org','--json','--help','-h'].includes(f)&&!source.includes(f)).map(f=>`unsupported flag ${f}`);
}
function walk(dir){return readdirSync(resolve(root,dir),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>e.isDirectory()?walk(`${dir}/${e.name}`):/\.mdx?$/.test(e.name)?[`${dir}/${e.name}`]:[]);}
export function registry(){const records=[];for(const file of walk(prefix)){const text=read(file);for(const m of text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)){const language=m[1].trim(),body=m[2],line=text.slice(0,m.index).split('\n').length;const native=/\/(sdk|mcp|cli)\//.test(file);const kind=/^(ba)?sh$|^shell$/.test(language)?'commands':/^(ts|tsx|typescript|astro|js|html|sql)$/.test(language)?'application-or-sdk':language==='json'?(body.includes('"result"')?'output':'configuration'):'output-or-pseudocode';records.push({file,line,language,kind,sha256:createHash('sha256').update(body).digest('hex'),validation:native?(file.includes('/sdk/')?'sdk-snippets':file.includes('/mcp/')?'tool-schema-and-sync':'cli-help-output-sync'):kind==='commands'?'cli-command-source':kind==='configuration'?'first-deploy-manifest-or-owning-schema':kind==='application-or-sdk'?'runtime-package-or-complete-fixture':'editorial',body});}}return records;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const failures=[],records=registry();for(const r of records){if(r.validation!=='cli-command-source')continue;for(const [i,line]of r.body.split('\n').entries())if(/^run402 /.test(line))for(const failure of checkCli(line.split(' #')[0]))failures.push(`${r.file}:${r.line+i+1}: ${failure}: ${line}`);}
const snapshot=JSON.stringify(records.map(({body,...r})=>r),null,2)+'\n';if(process.argv.includes('--write'))writeFileSync(resolve(root,'docs/quality/examples.json'),snapshot);else if(read('docs/quality/examples.json')!==snapshot)failures.push('Example registry stale; run node scripts/check-doc-examples.mjs --write');
if(failures.length)throw Error(failures.join('\n'));console.log(`${records.length} fenced examples registered; new guide CLI command paths/flags checked against source (no production calls)`);}
