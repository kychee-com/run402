#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),check=process.argv.includes('--check');
const sources=[['schemas/release-spec.v1.json','release'],['schemas/run402-app.v1.schema.json','application'],['docs/quality/manifest.v1.json','exposure']];
let page='---\ntitle: Release and application schemas\ndescription: Generated from pinned owning authoring schemas.\n---\n\nUse `run402 up --check` for local validation and `run402 up --plan` for gateway planning. Schema checks cannot prove authorization, capacity or activation. These tables describe authoring JSON; SDK types can use different casing.\n';
function emit(path,text){const full=resolve(root,path);if(check){if(readFileSync(full,'utf8')!==text)throw Error('Stale schema documentation: '+path);}else writeFileSync(full,text);}
for(const [path,id]of sources){const bytes=readFileSync(resolve(root,path),'utf8'),schema=JSON.parse(bytes),name=path.split('/').pop();emit('docs-site/public/schemas/'+name,bytes);page+=`\n## ${schema.title}\n\n[Download schema](/schemas/${name}). ${schema.description??''}\n`;
 const rows=(obj,label)=>{page+=`\n<h3 id="${id}-${label.replace(/[^a-z0-9-]/gi,'-')}">${label}</h3>\n\n`;if(!obj.properties){page+='```json\n'+JSON.stringify(obj,null,2)+'\n```\n';return;}page+='| Property | Shape | Required | Description |\n|---|---|---|---|\n';for(const [key,value]of Object.entries(obj.properties))page+=`| \`${key}\` | \`${value.$ref??value.type??(value.oneOf?'oneOf':value.anyOf?'anyOf':'schema')}\` | ${(obj.required??[]).includes(key)?'yes':'no'} | ${(value.description??'See the downloadable schema for constraints.').replaceAll('|','\\|').replaceAll('\n',' ')} |\n`;};rows(schema,'root');for(const [key,value]of Object.entries(schema.$defs??schema.definitions??{}))rows(value,key);
}
emit('docs-site/src/content/docs/reference/schemas.md',page);console.log('Schema reference '+(check?'verified':'generated'));
