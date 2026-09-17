import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let actor, calls;
mock.module('@run402/functions', { namedExports: {
  auth: { requireUser: async () => { if (!actor) throw Error('AUTH_REQUIRED'); return actor; } },
  db: () => ({ from: table => ({
    insert: async value => { calls.push({ table, insert: value }); },
    select: columns => ({ order: async order => { calls.push({ table, columns, order }); return [{ id: 1, title: 'Example' }]; } })
  }) })
}});
const { notesForRequest } = await import('./.test-dist/notes.js');
beforeEach(() => { actor = { id: 'user-a' }; calls = []; });
test('anonymous requests fail before any database operation', async () => {
  actor = null;
  await assert.rejects(notesForRequest(new Request('https://app.example/notes')), /AUTH_REQUIRED/);
  assert.deepEqual(calls, []);
});
test('personal read uses caller database without a redundant user filter', async () => {
  const result = await notesForRequest(new Request('https://app.example/notes'));
  assert.equal(result.rows.length, 1);
  assert.deepEqual(calls, [{ table: 'private_notes', columns: 'id,title', order: 'id' }]);
});
test('valid form write attributes the row to the authenticated actor', async () => {
  await notesForRequest(new Request('https://app.example/notes', { method: 'POST', body: new URLSearchParams({title:'  My note  ', user_id:'attacker-choice'}) }));
  assert.deepEqual(calls[0], { table:'private_notes', insert:{title:'My note',user_id:'user-a'} });
});
test('invalid input returns a recoverable validation result without a write', async () => {
  const result = await notesForRequest(new Request('https://app.example/notes',{method:'POST',body:new URLSearchParams({title:'x'.repeat(201)})}));
  assert.equal(result.invalid,true);assert.deepEqual(calls,[]);
});
test('Astro build emits a private SSR artifact and a release-slice manifest',()=>{
  const manifest=JSON.parse(readFileSync(new URL('./dist/run402/adapter.json',import.meta.url)));
  assert.ok(manifest.version);assert.ok(readFileSync(new URL('./dist/run402/server/entry.mjs',import.meta.url)).length>0);
});
