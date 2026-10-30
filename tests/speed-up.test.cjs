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
function shippedConst(name) {
  const start = source.search(new RegExp('^const ' + name + ' = ', 'm'));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf(';\n', start) + 2).replace(/^const /, 'var ');
}
function el() {
  return { value: '', textContent: '', innerHTML: '', className: '', disabled: false, checked: false, title: '', style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, setSelectionRange() {} };
}
const BYTES = 4893;
function harness(minRate = 20) {
  const elements = {};
  const calls = [];
  const ctx = vm.createContext({
    console, Math, Number, String, JSON, Date, calls,
    feeSupported: true, feeBase: 10, feeMinTx: 1000, feeDefault: { level: 0, custom: 100 },
    historySends: { tx1: { txid: 'tx1', fee: BYTES * 10, total_amount: 2500000000, timestamp: 1, recipients: [{ address: 'a' }] } },
    userData: { sendLabels: {} }, persistUserData() {}, sharedGets: {},
    document: { getElementById: id => (elements[id] = elements[id] || el()), querySelectorAll: () => [], querySelector: () => null },
    escapeHtml: String, formatBNT: String, humanAge: String, abbrAddr: String, contactNameForAddress: () => '',
    normalizeError: e => e.message || String(e), plainError: String, feeLevel: 0,
    loadFeePolicy: async () => {}, loadHistory() {}, loadDashboard() {}, showTxDetail() {},
    freshIdempotencyKey: () => 'key-1', wireFeeExtraInput() {},
    api: async (url, opts) => {
      calls.push({ url, body: opts && opts.body, headers: opts && opts.headers });
      if (ctx.bumpError && opts && opts.body && !opts.body.dry_run) throw new Error(ctx.bumpError);
      const rate = Math.max(minRate, 10 + (opts.body.extra_fee_per_byte || 0));
      return { fee: BYTES * rate, fee_per_byte: rate, old_fee: BYTES * 10, bump_cost: BYTES * (rate - 10), txid: opts.body.dry_run ? undefined : 'tx2' };
    },
  });
  const consts = ['FEE_CRAZY_MULTIPLE', 'FEE_LEVELS'];
  const names = ['feeMultipleFor', 'feeHeatFor', 'sendErrorText', 'speedUpButtonHtml', 'speedUpExtra', 'speedUpRate', 'speedUpLocked',
    'speedUpCrazy', 'speedUpConfirmed', 'speedUpNewFee', 'speedUpChanged', 'closeSpeedUp', 'openSpeedUp', 'renderSpeedUpShell',
    'pickSpeedUpLevel', 'updateSpeedUp', 'speedUpGo', 'finishSpeedUp'];
  vm.runInContext(consts.map(shippedConst).join('\n') + '\nvar SPEEDUP_TIP = "tip";\nvar SPEEDUP_BOLT = "<svg></svg>";\nvar speedUp = null;\n' + names.map(shipped).join('\n'), ctx);
  ctx.elements = elements;
  return ctx;
}

test('the button shows only on pending sends, and only when the core supports fees', () => {
  const h = harness();
  assert.match(h.speedUpButtonHtml({ txid: 't', is_send: true, block_height: 0 }), /data-speedup="t"/);
  assert.equal(h.speedUpButtonHtml({ txid: 't', is_send: true, block_height: 70000 }), '');
  assert.equal(h.speedUpButtonHtml({ txid: 't', is_send: true, block_height: 0, failed: true }), '');
  assert.equal(h.speedUpButtonHtml({ txid: 't', is_send: false, block_height: 0 }), '');
  h.feeSupported = false;
  assert.equal(h.speedUpButtonHtml({ txid: 't', is_send: true, block_height: 0 }), '');
});

test('opening asks the core for the minimum and locks the levels below it', async () => {
  const h = harness(20);
  await h.openSpeedUp('tx1');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), { txid: 'tx1', extra_fee_per_byte: 0, dry_run: true });
  assert.equal(h.speedUp.minRate, 20);
  assert.equal(h.speedUp.bytes, BYTES);
  assert.equal(h.speedUpLocked(0), true);
  assert.equal(h.speedUpLocked(1), false);
  assert.equal(h.speedUp.level, 1);
  h.pickSpeedUpLevel(0);
  assert.equal(h.speedUp.level, 1);

  const high = harness(55);
  await high.openSpeedUp('tx1');
  assert.equal(high.speedUp.level, 3);
  assert.equal(high.speedUp.custom, 100);
  assert.equal(high.speedUpRate(), 110);
  high.speedUp.custom = 30;
  assert.equal(high.speedUpRate(), 55);
});

test('Speed up first gets an exact estimate, then sends with an idempotency key', async () => {
  const h = harness(20);
  await h.openSpeedUp('tx1');
  await h.speedUpGo();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.dry_run, true);
  assert.equal(h.calls[1].body.extra_fee_per_byte, 10);
  assert.ok(h.speedUp.preview);
  await h.speedUpGo();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].body.dry_run, undefined);
  assert.equal(h.calls[2].headers['Idempotency-Key'], 'key-1');
  assert.equal(h.speedUp, null);
});

test('a level change after the estimate needs a new estimate', async () => {
  const h = harness(20);
  await h.openSpeedUp('tx1');
  await h.speedUpGo();
  h.pickSpeedUpLevel(2);
  assert.equal(h.speedUp.preview, null);
  h.speedUp.ack = true;
  await h.speedUpGo();
  assert.equal(h.calls.at(-1).body.dry_run, true);
  assert.equal(h.calls.at(-1).body.extra_fee_per_byte, 40);
});

test('urgent and crazy levels need their checkboxes before anything is sent', async () => {
  const h = harness(20);
  await h.openSpeedUp('tx1');
  h.pickSpeedUpLevel(2);
  await h.speedUpGo();
  assert.equal(h.calls.length, 1);
  h.speedUp.ack = true;
  assert.equal(h.speedUpConfirmed(), true);

  h.pickSpeedUpLevel(3);
  h.speedUp.custom = 5000;
  h.speedUp.ack = true;
  assert.equal(h.speedUpCrazy(), true);
  assert.equal(h.speedUpConfirmed(), false);
  await h.speedUpGo();
  assert.equal(h.calls.length, 1);
  h.speedUp.ackCrazy = true;
  assert.equal(h.speedUpConfirmed(), true);
});

test('a refused bump keeps the popup open with the reason', async () => {
  const h = harness(20);
  await h.openSpeedUp('tx1');
  await h.speedUpGo();
  h.bumpError = 'this send is not in the mempool, so it cannot be sped up';
  await h.speedUpGo();
  assert.ok(h.speedUp);
  assert.equal(h.speedUp.status.type, 'error');
  assert.match(h.speedUp.status.text, /not in the mempool/);
  assert.equal(h.speedUp.preview, null);
});

test('after a speed-up the label and note move to the new txid', () => {
  const h = harness();
  h.userData.sendLabels = { tx1: '$rockstar' };
  h.userData.txNotes = { tx1: 'rent' };
  h.speedUp = { txid: 'tx1' };
  h.finishSpeedUp('tx1', { txid: 'tx2' });
  assert.equal(h.userData.sendLabels.tx2, '$rockstar');
  assert.equal(h.userData.txNotes.tx2, 'rent');
  assert.equal(h.speedUp, null);
});
