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
const address = '7NJcZ3NqqKzwZoM4YUXLnCdTF3gHxVvxkCx1hPapzYDeHpbeZqS5Q7AdZ9NW9RRyYAcGnQRfTckEvit6Ty6YTnaVmuFAQ';
const TX_BYTES = 4893;

function element(value = '') {
  return { value, textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {} } };
}
function harness(level = 0, custom = 100) {
  const rows = [{ address: element(address), amount: element('25'), memo: element(), resolved: element(), _resolved: null }];
  const elements = { 'send-submit': element(), 'send-confirm': element(), 'send-cancel': element(), 'send-amount': element() };
  const calls = [];
  const statuses = [];
  const context = vm.createContext({
    TextEncoder, console,
    sendArmed: false, pendingSendFingerprint: null, sendArmTimer: null,
    pendingSendIdempotency: null, SEND_IDEMPOTENCY_WINDOW_MS: 600000, SEND_MAX_RETRIES: 0,
    coinControlEnabled: false,
    feeSupported: true, feePolicyState: 'ok', feePolicyTries: 0, feePolicyRetry: null, FEE_POLICY_MAX_TRIES: 20, sendMaxState: null, plainError: String,
    feeBase: 10, feeMinTx: 1000, formatBNTRaw: a => (a / 1e8).toFixed(8),
    feeLevel: level, feeCustomExtra: custom, feeDefault: { level: 0, custom: 100 }, feeTxBytes: 0, feeEstimate: null, feeAck: false, feeAckCrazy: false,
    rows, calls, statuses,
    api: async (url, options) => {
      calls.push({ url, body: options && options.body, headers: options && options.headers });
      if (url === '/api/wallet/balance') return { spendable: 100000000000 };
      if (url === '/api/mempool') {
        if (context.mempoolDown) throw new Error('request failed: error sending request');
        return { count: 3, base_fee_per_byte: 10, min_tx_fee: 1000 };
      }
      if (context.sendError && !options.body.dry_run) throw new Error(context.sendError);
      if (context.estimateError && options.body.dry_run) throw new Error(context.estimateError);
      const rate = context.feeBase + (options.body.extra_fee_per_byte || 0);
      return { fee: TX_BYTES * rate, fee_per_byte: rate, input_total: 3000000000, txid: 'fixture-transaction' };
    },
    document: { getElementById: id => elements[id], querySelectorAll: () => [] },
    invoke: async () => context.daemonVersion || '0.24.0',
    getRecipientRows: () => rows, getFirstRecipientRow: () => rows[0],
    getRowAddressInput: row => row.address, getRowAmountInput: row => row.amount,
    getRowMemoInput: row => row.memo, getRowResolvedEl: row => row.resolved,
    normalizeError: error => error.message || String(error),
    clearSendStatus() {}, showSendStatus: (message, type) => statuses.push({ message, type }),
    parsePaymentRequestUri: () => null, getSelectedInputs: () => [], hideResolved() {},
    isHandlePrefix: c => c === '$' || c === '@', abbrAddr: a => a.slice(0, 8),
    formatBNT: String, freshIdempotencyKey: () => 'key-' + (++context.keys), keys: 0,
    isStaleInputError: () => false, isTransientSendError: () => false,
    renderSendConfirm: (entries, preview) => { context.confirmed = preview; },
    finalizeSend: () => { context.sent = true; },
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
  });
  const consts = ['FEE_PRIORITY_CORE_VERSION', 'FEE_EXTRA_MAX_DIGITS', 'FEE_CRAZY_MULTIPLE', 'FEE_LEVELS'];
  const names = ['feeDigitsOnly', 'clampFeeExtra', 'coreVersionAtLeast', 'feeExtraPerByte', 'feeRatePerByte', 'feeMultipleFor', 'feeMultiple', 'feeHeatFor', 'feeNeedsAck', 'feeIsCrazy', 'feeConfirmed', 'feeHeat',
    'currentFeeAtomic', 'noteFeeEstimate', 'renderFeePriority', 'disarmSend', 'handleSend',
    'feeChanged', 'setFeeLevel', 'resetFeeToDefault', 'sendErrorText', 'refigureSendMax', 'loadFeePolicy'];
  vm.runInContext(consts.map(shippedConst).join('\n') + names.map(shipped).join('\n'), context);
  context.submit = () => context.handleSend({ preventDefault() {} });
  context.sends = () => calls.filter(c => c.url === '/api/wallet/send' && !c.body.dry_run);
  context.estimates = () => calls.filter(c => c.url === '/api/wallet/send' && c.body.dry_run);
  return context;
}

test('each level maps to the agreed extra per byte and multiple', () => {
  const h = harness();
  const want = [[0, 0, 10, '1x'], [1, 10, 20, '2x'], [2, 40, 50, '5x']];
  for (const [level, extra, rate, mult] of want) {
    h.feeLevel = level;
    assert.equal(h.feeExtraPerByte(), extra);
    assert.equal(h.feeRatePerByte(), rate);
    assert.equal(h.feeMultiple(), mult);
  }
  h.feeLevel = 3;
  h.feeCustomExtra = 5;
  assert.equal(h.feeRatePerByte(), 15);
  assert.equal(h.feeMultiple(), '1.5x');
  assert.equal(h.clampFeeExtra('5000'), 5000);
  assert.equal(h.clampFeeExtra('-3'), 3);
  assert.equal(h.clampFeeExtra('abc'), 0);
});

test('one estimate gives the size, and slider moves recompute the fee locally', () => {
  const h = harness();
  h.feeLevel = 2;
  h.noteFeeEstimate([{ atomic: 2500000000 }], { fee: TX_BYTES * 10, fee_per_byte: 10, input_total: 3000000000 });
  assert.equal(h.feeTxBytes, TX_BYTES);
  h.feeLevel = 2;
  assert.equal(h.currentFeeAtomic(), TX_BYTES * 50);
  h.feeLevel = 3;
  h.feeCustomExtra = 1000;
  assert.equal(h.currentFeeAtomic(), TX_BYTES * 1010);
  h.feeTxBytes = 50;
  h.feeLevel = 0;
  assert.equal(h.currentFeeAtomic(), 1000);
});

test('normal and fast send their extra on the estimate and the send, with no checkbox', async () => {
  for (const [level, extra] of [[0, 0], [1, 10]]) {
    const h = harness(level);
    await h.submit();
    assert.equal(h.sendArmed, true);
    assert.equal(h.estimates()[0].body.extra_fee_per_byte, extra);
    assert.equal(h.confirmed.fee, TX_BYTES * (10 + extra));
    await h.submit();
    assert.equal(h.sent, true);
    assert.equal(h.sends()[0].body.extra_fee_per_byte, extra);
  }
});

test('urgent and custom refuse to send until the checkbox is ticked', async () => {
  for (const [level, custom, extra] of [[2, 100, 40], [3, 250, 250]]) {
    const h = harness(level, custom);
    await h.submit();
    assert.equal(h.sendArmed, true);
    await h.submit();
    assert.equal(h.sent, undefined);
    assert.equal(h.sends().length, 0);
    assert.match(h.statuses.at(-1).message, /Tick the box/);
    assert.equal(h.sendArmed, true);
    h.feeAck = true;
    await h.submit();
    assert.equal(h.sent, true);
    assert.equal(h.sends()[0].body.extra_fee_per_byte, extra);
  }
});

test('a fee change after the estimate needs a new estimate before Send works', async () => {
  const h = harness(2);
  await h.submit();
  h.feeAck = true;
  h.setFeeLevel(1);
  assert.equal(h.sendArmed, false);
  assert.equal(h.feeAck, false);
  assert.equal(h.feeTxBytes, TX_BYTES);
  await h.submit();
  assert.equal(h.sends().length, 0);
  assert.equal(h.estimates().length, 2);
  assert.equal(h.estimates()[1].body.extra_fee_per_byte, 10);
  await h.submit();
  assert.equal(h.sends()[0].body.extra_fee_per_byte, 10);
});

test('a retry with a new fee reuses the idempotency key, so it cannot send twice', async () => {
  const h = harness(0);
  await h.submit();
  h.sendError = 'request failed: timed out';
  h.resolveTimedOutSend = async () => false;
  await h.submit();
  const firstKey = h.sends()[0].headers['Idempotency-Key'];
  h.sendError = 'idempotency key reuse with different request';
  h.setFeeLevel(1);
  await h.submit();
  await h.submit();
  const retry = h.sends()[1];
  assert.equal(retry.body.extra_fee_per_byte, 10);
  assert.equal(retry.headers['Idempotency-Key'], firstKey);
  assert.match(h.statuses.at(-1).message, /may still go through/);
  assert.notEqual(h.pendingSendIdempotency, null);
});

test('after a send the slider returns to the default', () => {
  const h = harness(2, 700);
  h.feeDefault = { level: 1, custom: 55 };
  h.feeAck = true;
  h.resetFeeToDefault();
  assert.equal(h.feeLevel, 1);
  assert.equal(h.feeCustomExtra, 55);
  assert.equal(h.feeAck, false);
});

test('the base fee and multiple come from the core, not a copy', () => {
  const h = harness(1);
  h.feeBase = 20;
  assert.equal(h.feeRatePerByte(), 30);
  assert.equal(h.feeMultiple(), '1.5x');
  h.feeMinTx = 999999;
  h.feeTxBytes = 10;
  assert.equal(h.currentFeeAtomic(), 999999);
});

test('fee priority needs core v0.24.0 or newer', () => {
  const h = harness();
  const want = { '0.24.0': true, '0.24.1': true, '1.0.0': true, 'v0.25.0': true, '0.23.0': false, '0.23.9': false, '': false, 'garbage': false };
  for (const [version, ok] of Object.entries(want)) {
    assert.equal(h.coreVersionAtLeast(version, h.FEE_PRIORITY_CORE_VERSION), ok, version);
  }
});

test('without core support the send carries no extra fee and needs no checkbox', async () => {
  const h = harness(2);
  h.feeSupported = false;
  await h.submit();
  assert.equal(h.estimates()[0].body.extra_fee_per_byte, 0);
  await h.submit();
  assert.equal(h.sent, true);
  assert.equal('extra_fee_per_byte' in h.sends()[0].body, false);
});

test('the custom field keeps only whole, positive digits', () => {
  const h = harness();
  const want = {
    '100': '100', '1.5': '15', '1e5': '15', '-40': '40', '+7': '7', ' 12 ': '12', 'abc': '', '': '',
    '007': '7', '0': '0', '000': '0', '12abc34': '1234', '９': '', '99999999999999999': '9999999999999',
  };
  for (const [input, out] of Object.entries(want)) {
    assert.equal(h.feeDigitsOnly(input), out, JSON.stringify(input));
  }
  assert.equal(h.clampFeeExtra(''), 0);
  assert.equal(h.clampFeeExtra('99999999999999999'), 9999999999999);
  assert.ok(h.clampFeeExtra('9'.repeat(40)) <= Number.MAX_SAFE_INTEGER);
});

test('a custom rate of 100x the base or more is crazy and needs a second checkbox', async () => {
  const h = harness(3, 989);
  assert.equal(h.feeIsCrazy(), false);
  h.feeCustomExtra = 990;
  assert.equal(h.feeIsCrazy(), true);
  h.feeBase = 20;
  assert.equal(h.feeIsCrazy(), false);
  h.feeBase = 10;
  h.feeLevel = 2;
  assert.equal(h.feeIsCrazy(), false);

  const c = harness(3, 5000);
  await c.submit();
  c.feeAck = true;
  await c.submit();
  assert.equal(c.sent, undefined);
  assert.match(c.statuses.at(-1).message, /both boxes/);
  c.feeAckCrazy = true;
  await c.submit();
  assert.equal(c.sent, true);
  assert.equal(c.sends()[0].body.extra_fee_per_byte, 5000);
});

test('changing the custom fee or level clears both checkboxes', () => {
  const h = harness(3, 5000);
  h.feeAck = true;
  h.feeAckCrazy = true;
  h.disarmSend();
  assert.equal(h.feeAck, false);
  assert.equal(h.feeAckCrazy, false);
});

test('the confirm step is tied to the fee it was estimated at', async () => {
  const h = harness(0);
  await h.submit();
  h.feeLevel = 1;
  await h.submit();
  assert.equal(h.sends().length, 0);
  assert.equal(h.estimates()[1].body.extra_fee_per_byte, 10);
});

test('a funds error at a raised priority says to lower it', async () => {
  const h = harness(2);
  h.estimateError = 'insufficient funds: 25 BNT to send plus a fee of about 0.0025 BNT (50 per byte) needs 25.0025 BNT, and 25 BNT is spendable';
  await h.submit();
  assert.match(h.statuses.at(-1).message, /Lower the fee priority or the amount\.$/);
  const n = harness(0);
  n.estimateError = h.estimateError;
  await n.submit();
  assert.doesNotMatch(n.statuses.at(-1).message, /Lower the fee priority/);
});

test('the fee policy retries while the core is starting, then shows the slider', async () => {
  const h = harness(0);
  h.feeSupported = false;
  h.feePolicyState = 'unknown';
  h.mempoolDown = true;
  const timers = [];
  h.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  await h.loadFeePolicy();
  assert.equal(h.feePolicyState, 'retry');
  assert.equal(h.feeSupported, false);
  assert.equal(timers.length, 1);
  h.mempoolDown = false;
  await timers[0]();
  assert.equal(h.feePolicyState, 'ok');
  assert.equal(h.feeSupported, true);
  assert.equal(h.feeBase, 10);
});

test('the fee policy stops retrying after a cap, and an old core is not retried', async () => {
  const h = harness(0);
  h.mempoolDown = true;
  let scheduled = 0;
  h.setTimeout = () => { scheduled++; return scheduled; };
  for (let i = 0; i < 30; i++) await h.loadFeePolicy();
  assert.equal(scheduled, h.FEE_POLICY_MAX_TRIES - 1);
  const old = harness(0);
  old.daemonVersion = '0.23.0';
  let oldScheduled = 0;
  old.setTimeout = () => { oldScheduled++; };
  await old.loadFeePolicy();
  assert.equal(old.feePolicyState, 'unsupported');
  assert.equal(oldScheduled, 0);
});

test('Send loads a missing fee policy before the estimate', async () => {
  const h = harness(1);
  h.feeSupported = false;
  h.feePolicyState = 'retry';
  await h.submit();
  assert.equal(h.feeSupported, true);
  assert.equal(h.estimates()[0].body.extra_fee_per_byte, 10);
});

test('after Max, a fee change refigures the amount from the same estimate', () => {
  const h = harness(0);
  const amount = h.document.getElementById('send-amount');
  amount.value = h.formatBNTRaw(100000000 - TX_BYTES * 10);
  h.sendMaxState = { bytes: TX_BYTES, spendable: 100000000, value: amount.value };
  h.setFeeLevel(2);
  assert.equal(amount.value, h.formatBNTRaw(100000000 - TX_BYTES * 50));
  h.setFeeLevel(0);
  assert.equal(amount.value, h.formatBNTRaw(100000000 - TX_BYTES * 10));
  assert.equal(h.calls.length, 0);
});

test('after Max, an edited amount is left alone', () => {
  const h = harness(0);
  const amount = h.document.getElementById('send-amount');
  h.sendMaxState = { bytes: TX_BYTES, spendable: 100000000, value: '0.99951070' };
  amount.value = '0.5';
  h.setFeeLevel(2);
  assert.equal(amount.value, '0.5');
  assert.equal(h.sendMaxState, null);
});

test('after Max, a fee the balance cannot cover clears the amount and says why', () => {
  const h = harness(0);
  const amount = h.document.getElementById('send-amount');
  amount.value = '0.00050000';
  h.sendMaxState = { bytes: TX_BYTES, spendable: 100000, value: amount.value };
  h.setFeeLevel(2);
  assert.equal(amount.value, '');
  assert.match(h.statuses.at(-1).message, /cannot cover this fee/);
});

test('a detailed funds error keeps its numbers, an old one gets the plain text', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  const start = src.indexOf('var PLAIN_ERRORS = [');
  assert.notEqual(start, -1);
  const ctx = require('node:vm').createContext({});
  require('node:vm').runInContext(src.slice(start, src.indexOf('];', start) + 2) + '\n' + shipped('plainError'), ctx);
  const detailed = 'insufficient funds: 25 BNT to send plus a fee of about 0.0025 BNT (50 per byte) needs 25.0025 BNT, and 25 BNT is spendable';
  assert.equal(ctx.plainError(detailed), 'I' + detailed.slice(1));
  assert.equal(ctx.plainError('insufficient funds: insufficient funds'), 'Not enough funds for this amount plus the network fee.');
});
