import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fundingRecovery, fundingBlocksBootstrap } from './funding-recovery.js';
it('retains authoritative cooldown facts without copying secrets or inferring a scope', () => {
 const r = fundingRecovery({body:{code:'RATE_LIMITED',details:{retry_after:42,retry_at:'2026-09-20T10:00:00Z',limit_scope:'ip',secret:'no'}}})!;
 assert.equal(r.status,'blocked'); assert.equal(r.retry_after,42); assert.equal(r.limit_scope,'ip');
 assert.match(r.next_actions[0]!.why,/2026-09-20T10:00:00Z/); assert.ok(!JSON.stringify(r).includes('secret'));
 assert.equal(fundingRecovery({code:'RATE_LIMITED'})!.limit_scope,undefined);
});
it('pending confirmation recommends balance inspection, never a new drip', () => {
 const r=fundingRecovery({body:{code:'FAUCET_CONFIRMATION_PENDING',details:{transaction_hash:'0x'+'ab'.repeat(32)}}})!;
 assert.equal(r.status,'pending'); assert.equal(r.next_actions[0]!.type,'check_balance'); assert.ok(r.transaction_hash);
});
it('existing tier or independently confirmed funds remain usable despite faucet failure', () => {
 const r=fundingRecovery({code:'RATE_LIMITED'});
 assert.equal(fundingBlocksBootstrap(r,{activeTier:false}),true);
 assert.equal(fundingBlocksBootstrap(r,{activeTier:true}),false);
 assert.equal(fundingBlocksBootstrap(r,{activeTier:false,onChainBalance:250000}),false);
 assert.equal(fundingBlocksBootstrap(r,{activeTier:false,prepaidBalance:250000}),false);
 assert.equal(fundingBlocksBootstrap(r,{activeTier:false,lightningBalance:100}),false);
 assert.equal(fundingBlocksBootstrap(null,{activeTier:false}),false);
});
