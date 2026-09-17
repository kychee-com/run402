import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourcePaths} from './build-agent-flat-docs.mjs';
import {policyViolations,classify,unclassifiedSources} from './documentation-inventory.mjs';
it('generic policy rejects SDK-first and MCP assumptions, permits native SDK code',()=>{
 const generic={path:'README.md',purpose:'guide',interface:'cli'};
 assert.equal(policyViolations(generic,'Pick the SDK first').length,1);
 assert.equal(policyViolations(generic,'Assume MCP tools are installed').length,1);
 assert.equal(policyViolations({...generic,...classify('sdk/README.md')},'Pick the SDK first').length,0);
 assert.equal(policyViolations(generic,'Use the SDK for typed scripting.').length,0);
});
it('adding Start pages cannot leak them into the front door',()=>{
 const root=mkdtempSync(join(tmpdir(),'docs-start-'));
 try{mkdirSync(join(root,'start'));writeFileSync(join(root,'start/first-deploy.md'),'canonical');writeFileSync(join(root,'start/harness.md'),'must not leak');
 assert.deepEqual(sourcePaths({section:'start',source:'first-deploy.md'},root).map(p=>readFileSync(p,'utf8')),['canonical']);}finally{rmSync(root,{recursive:true,force:true});}
});
it('splitting native references preserves all previously registered sections',()=>{
 const ledger=JSON.parse(readFileSync(new URL('../docs/quality/reference-sections.json',import.meta.url),'utf8'));
 for(const pages of Object.values(ledger))for(const page of pages){const text=readFileSync(new URL('../'+page.file,import.meta.url),'utf8');for(const section of page.sections)assert.ok(text.includes(section),`${page.file}: lost ${section}`);}
});

it('new sources cannot pass inventory coverage implicitly',()=>{assert.deepEqual(unclassifiedSources(['README.md','new-guide.md'],[{path:'README.md'}]),['new-guide.md']);});

// External inputs are intentionally vendored: the public build needs no private checkout.
it('pinned HTTP reference bytes match their public-safe provenance', async()=>{
 const {createHash}=await import('node:crypto');
 const provenance=JSON.parse(readFileSync(new URL('../docs/quality/openapi-provenance.json',import.meta.url),'utf8'));
 const bytes=readFileSync(new URL('../docs-site/public/openapi.json',import.meta.url));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.sha256);
 const schema=JSON.parse(bytes);assert.ok(schema.openapi);assert.ok(Object.keys(schema.paths).length>0);
});
