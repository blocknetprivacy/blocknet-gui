const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function shipped(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

function outputs(n, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ txid: 'tx' + (from + i), output_index: 0, amount: 1, block_height: 100000 - from - i }));
}

function harness(pages) {
  const calls = [];
  const ctx = vm.createContext({
    HISTORY_FETCH_PAGE: 500, calls,
    api: async (url) => {
      calls.push(url);
      const offset = Number(/offset=(\d+)/.exec(url)[1]);
      const page = pages[offset];
      if (page instanceof Error) throw page;
      return page;
    },
  });
  vm.runInContext(shipped('fetchAllHistoryOutputs'), ctx);
  return ctx;
}

test('history loads every page of 500 until a short page', async () => {
  const all = outputs(1203);
  const h = harness({
    0: { total: 1203, outputs: all.slice(0, 500) },
    500: { total: 1203, outputs: all.slice(500, 1000) },
    1000: { total: 1203, outputs: all.slice(1000) },
  });
  const progress = [];
  const got = await h.fetchAllHistoryOutputs((loaded, total) => progress.push([loaded, total]));
  assert.equal(got.length, 1203);
  assert.deepEqual(h.calls.map(u => /offset=(\d+)/.exec(u)[1]), ['0', '500', '1000']);
  assert.ok(h.calls.every(u => u.includes('limit=500') && u.includes('order=desc')));
  assert.deepEqual(progress, [[500, 1203], [1000, 1203], [1203, 1203]]);
});

test('an output that shifts across a page edge is not listed twice', async () => {
  const all = outputs(600);
  const h = harness({
    0: { total: 601, outputs: all.slice(0, 500) },
    500: { total: 601, outputs: [all[499]].concat(all.slice(500)) },
  });
  const got = await h.fetchAllHistoryOutputs(null);
  assert.equal(got.length, 600);
});

test('a failed page fails the load instead of returning a partial history', async () => {
  const h = harness({ 0: { total: 900, outputs: outputs(500) }, 500: new Error('operation timed out') });
  await assert.rejects(h.fetchAllHistoryOutputs(null), /timed out/);
  const bad = harness({ 0: { total: 1 } });
  await assert.rejects(bad.fetchAllHistoryOutputs(null), /missing outputs/);
});

test('the History view loads every page of sends, not only the newest 500', () => {
  const body = shipped('loadHistory');
  assert.match(body, /fetchSendsCtx\(chainHeight, true\)/);
  assert.match(body, /fetchAllHistoryOutputs\(/);
  assert.doesNotMatch(body, /sharedGet\('\/api\/wallet\/history'\)/);
});

function rowsHarness(dismissed = {}) {
  const ctx = vm.createContext({ userData: { dismissedFailedSends: dismissed }, persistUserData() { ctx.saved = true; } });
  vm.runInContext(['failedSendDismissed', 'dismissFailedSend', 'historySortCmp', 'buildTxRows'].map(shipped).join('\n'), ctx);
  return ctx;
}

test('a send the core reports as not_found becomes a failed row, not a confirmed one', async () => {
  const fetchSrc = shipped('fetchSendsCtx');
  const ctx = vm.createContext({
    sharedGet: async () => ({ sends: [
      { txid: 'gone', chain_state: 'not_found', in_mempool: false, recorded_height: 500, total_amount: 7, recipients: [] },
      { txid: 'ok', chain_state: 'confirmed', in_mempool: false, recorded_height: 400, confirmations: 3, total_amount: 5, recipients: [] },
      { txid: 'wait', chain_state: 'mempool', in_mempool: true, recorded_height: 600, total_amount: 2, recipients: [] },
    ] }),
  });
  vm.runInContext(fetchSrc, ctx);
  const sends = await ctx.fetchSendsCtx(700);
  const byId = Object.fromEntries(sends.sendRows.map(r => [r.txid, r]));
  assert.equal(byId.gone.failed, true);
  assert.equal(byId.ok.failed, false);
  assert.equal(byId.wait.failed, false);
  assert.equal(byId.wait.block_height, 0);
});

test('a dismissed failed send is hidden, but comes back if it later confirms', () => {
  const h = rowsHarness();
  const failed = { sends: { gone: {} }, sendRows: [{ txid: 'gone', is_send: true, failed: true, block_height: 500, amount: 7 }] };
  assert.equal(h.buildTxRows([], failed).length, 1);
  h.dismissFailedSend('gone');
  assert.equal(h.saved, true);
  assert.equal(h.buildTxRows([], failed).length, 0);
  const confirmedLater = { sends: { gone: {} }, sendRows: [{ txid: 'gone', is_send: true, failed: false, block_height: 500, amount: 7 }] };
  assert.equal(h.buildTxRows([], confirmedLater).length, 1);
});
