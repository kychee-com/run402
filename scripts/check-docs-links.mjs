#!/usr/bin/env node
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {listAgentFlatFiles} from './build-agent-flat-docs.mjs';
const root=resolve(import.meta.dirname,'..'),dist=join(root,'docs-site/dist');
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}
const served=new Set([...listAgentFlatFiles().map(f=>'/'+f.asset),'/SKILL.md']);
const pages=walk(dist).filter(p=>p.endsWith('.html')&&!p.endsWith('/404.html')),cache=new Map(),failures=[];
for(const path of pages){const text=readFileSync(path,'utf8');cache.set(path,{text,ids:new Set([...text.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]))});}
for(const [path,{text}]of cache){const base='https://docs.run402.com/'+path.slice(dist.length+1).replace(/index\.html$/,'');for(const m of text.matchAll(/\bhref="([^"]+)"/g)){const value=m[1].replaceAll('&amp;','&');if(/^(?:mailto:|tel:|javascript:)/.test(value))continue;let url;try{url=new URL(value,base)}catch{continue;}if(url.origin!=='https://docs.run402.com')continue;if(served.has(url.pathname))continue;const rel=decodeURIComponent(url.pathname);let target=join(dist,rel);if(!/\.[a-z0-9]+$/i.test(rel))target=join(target,'index.html');if(!existsSync(target)){failures.push(`${path.slice(root.length+1)}: missing ${url.pathname}`);continue;}if(url.hash&&target.endsWith('.html')&&!cache.get(target)?.ids.has(decodeURIComponent(url.hash.slice(1))))failures.push(`${path.slice(root.length+1)}: missing anchor ${url.pathname}${url.hash}`);}}
const catalog=JSON.parse(readFileSync(join(root,'docs/quality/error-catalog.json'),'utf8'));for(const r of catalog.records){const url=new URL(r.topic,'https://docs.run402.com');const target=join(dist,url.pathname,'index.html');if(!cache.get(target)?.ids.has(url.hash.slice(1)))failures.push(`${r.code}: missing declared destination ${r.topic}`);}
// Literal destinations emitted by current public clients must resolve locally too.
for (const dir of ['astro/src','sdk/src','core/src']) for (const source of walk(join(root,dir)).filter(p=>/\.(ts|astro)$/.test(p)&&!p.includes('.test.'))) {
  for (const match of readFileSync(source,'utf8').matchAll(/https:\/\/docs\.run402\.com\/[A-Za-z0-9_/#.-]+/g)) {
    const url=new URL(match[0]);const target=join(dist,url.pathname,'index.html');
    if(!existsSync(target)||url.hash&&!cache.get(target)?.ids.has(url.hash.slice(1)))failures.push(source.slice(root.length+1)+': emitted URL unresolved '+url.href);
  }
}
if(failures.length)throw Error([...new Set(failures)].join('\n'));console.log(`${pages.length} built pages: internal links, anchors and ${catalog.records.length} error destinations verified`);
