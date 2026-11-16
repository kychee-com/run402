import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let actor, calls;
mock.module('@run402/functions', { namedExports: {
  auth: { requireUser: async () => { if (!actor) throw Error('AUTH_REQUIRED'); return actor; } },
  db: () => ({ from: table => ({
    insert: async value => { calls.push({ table, insert: value }); },
    select: columns => ({ order: order => {
      const run = async limit => { calls.push({ table, columns, order, ...(limit === undefined ? {} : { limit }) }); return [{ id: 1, title: 'Example' }]; };
      return { then: (resolve, reject) => run().then(resolve, reject), limit: count => run(count) };
    } })
  }) })
}});
const { addNote, listNotes, notesForRequest } = await import('./.test-dist/notes.js');
beforeEach(() => { actor = { id: 'user-a' }; calls = []; });
test('anonymous requests fail before any database operation', async () => {
  actor = null;
  await assert.rejects(notesForRequest(new Request('https://app.example/notes')), /AUTH_REQUIRED/);
  await assert.rejects(listNotes(), /AUTH_REQUIRED/);
  await assert.rejects(addNote('A note'), /AUTH_REQUIRED/);
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
test('the list and add helpers behind the API endpoint and its MCP tools keep the same boundaries', async () => {
  assert.deepEqual(await listNotes(5), [{ id: 1, title: 'Example' }]);
  assert.equal(await addNote('  From an assistant  '), true);
  assert.equal(await addNote(''), false);
  assert.equal(await addNote(undefined), false);
  assert.deepEqual(calls, [
    { table: 'private_notes', columns: 'id,title', order: 'id', limit: 5 },
    { table: 'private_notes', insert: { title: 'From an assistant', user_id: 'user-a' } },
  ]);
});
test('Astro build emits a private SSR artifact and a release-slice manifest',()=>{
  const manifest=JSON.parse(readFileSync(new URL('./dist/run402/adapter.json',import.meta.url)));
  assert.ok(manifest.version);assert.ok(readFileSync(new URL('./dist/run402/server/entry.mjs',import.meta.url)).length>0);
  // The API endpoint is server-rendered, so its tools can be carried: an
  // adapter that reads tool declarations lists both in adapter.json.
  assert.ok(manifest.routes.some(route => route.pattern === '/api/notes' && route.prerender === false));
  if (manifest.tools) assert.deepEqual(manifest.tools.map(tool => [tool.name, tool.method, tool.path]), [['list_notes','GET','/api/notes'],['add_note','POST','/api/notes']]);
});
