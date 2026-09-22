import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {upSchema} from '../src/tools/up.js';
import {loadDeployManifest,findMissingLocalFileReferences} from '../sdk/src/node/deploy-manifest.js';
import {checkCli} from './check-doc-examples.mjs';
it('MCP quickstart arguments match the exported up schema',()=>{
 const doc=readFileSync(new URL('../docs-site/src/content/docs/mcp/reference.md',import.meta.url),'utf8');
 const body=doc.match(/<!-- example: mcp-up -->\s*```json\n([\s\S]*?)```/)?.[1];assert.ok(body);
 const parsed=z.object(upSchema).strict().parse(JSON.parse(body));assert.equal(parsed.yes,true);assert.equal(parsed.manifest,'run402.json');
 assert.equal(z.object(upSchema).strict().safeParse({approval:true}).success,false);
});
it('invented command paths and flags fail without executing a mutation',()=>{
 assert.deepEqual(checkCli('run402 up --check'),[]);
 assert.ok(checkCli('run402 invented-command').length);
 assert.ok(checkCli('run402 up --invented-doc-flag').length);
});
it('first-deploy files load together and a missing HTML file fails preflight',async()=>{
 const doc=readFileSync(new URL('../docs-site/src/content/docs/start/first-deploy.md',import.meta.url),'utf8');
 const manifest=doc.match(/```json\n([\s\S]*?)```/)?.[1];const html=doc.match(/```html\n([\s\S]*?)```/)?.[1];assert.ok(manifest&&html);
 const dir=mkdtempSync(join(tmpdir(),'docs-first-app-'));
 try{writeFileSync(join(dir,'run402.json'),manifest);writeFileSync(join(dir,'index.html'),html);
 const result=await loadDeployManifest(join(dir,'run402.json'),{project:'prj_docs_fixture'});
 assert.deepEqual(await findMissingLocalFileReferences(result.spec),[]);
 rmSync(join(dir,'index.html'));
 assert.ok((await findMissingLocalFileReferences(result.spec)).some(x=>x.path.endsWith('index.html')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('first-deploy manifest and exposure validate against owning schemas',async()=>{
 const {default:Ajv2020}=await import('ajv/dist/2020.js');
 const {default:Ajv}=await import('ajv');
 const doc=readFileSync(new URL('../docs-site/src/content/docs/start/first-deploy.md',import.meta.url),'utf8');
 const manifest=JSON.parse(doc.match(/```json\n([\s\S]*?)```/)![1]!);
 const schema=JSON.parse(readFileSync(new URL('../schemas/release-spec.v1.json',import.meta.url),'utf8'));
 const validate=new Ajv2020({strict:false,validateFormats:false}).compile(schema);
 assert.equal(validate(manifest),true,JSON.stringify(validate.errors));
 const expose=JSON.parse(readFileSync(new URL('../docs/quality/manifest.v1.json',import.meta.url),'utf8'));
 const validateExpose=new Ajv({strict:false,validateFormats:false}).compile(expose);
 assert.equal(validateExpose(manifest.database.expose),true,JSON.stringify(validateExpose.errors));
 assert.equal(validate({...manifest,site:{replace:{'index.html':{invented:true}}}}),false);
});

it('current schema snapshots preserve embedding and live-table fields', async()=>{
 const {default:Ajv2020}=await import('ajv/dist/2020.js');
 const {default:Ajv}=await import('ajv');
 const release=JSON.parse(readFileSync(new URL('../schemas/release-spec.v1.json',import.meta.url),'utf8'));
 const validate=new Ajv2020({strict:false,validateFormats:false}).compile(release);
 assert.equal(validate({site:{embedding:{frame_ancestors:['localhost']}}}),true,JSON.stringify(validate.errors));
 assert.equal(validate({site:{embedding:null}}),true);
 assert.equal(validate({site:{embedding:{frame_ancestors:['https://untrusted.example']}}}),false);
 const exposure=JSON.parse(readFileSync(new URL('../docs/quality/manifest.v1.json',import.meta.url),'utf8'));
 const expose=new Ajv({strict:false,validateFormats:false}).compile(exposure);
 assert.equal(expose({version:'1',tables:[{name:'notes',expose:true,policy:'user_owns_rows',owner_column:'user_id',live:true}]}),true,JSON.stringify(expose.errors));
});
