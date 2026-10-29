const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the shipped functions without starting Tauri or a real wallet.
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function shipped(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const keys = generateKeyPairSync('ed25519');
const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const address = '7NJcZ3NqqKzwZoM4YUXLnCdTF3gHxVvxkCx1hPapzYDeHpbeZqS5Q7AdZ9NW9RRyYAcGnQRfTckEvit6Ty6YTnaVmuFAQ';
function signedResponse(fields = {}) {
  const signed = { handle: 'alice', address, updated_at_unix: 1772163162, ...fields };
  const payload = JSON.stringify(signed);
  return { handle: signed.handle, address: signed.address, updated_at: signed.updated_at_unix,
    payload, sig: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') };
}
function element(value = '') {
  return { value, textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {} } };
}
function harness(response = signedResponse(), recipients = ['$alice']) {
  const rows = recipients.map(value => ({ address: element(value), amount: element('1'), memo: element(), resolved: element(), _resolved: null }));
  const elements = { 'send-submit': element(), 'send-confirm': element(), 'send-cancel': element() };
  const calls = [];
  const statuses = [];
  const timers = [];
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, atob, Uint8Array, console,
    blocknetIdPubKey: null, sendArmed: false, pendingSendFingerprint: null, sendArmTimer: null,
    pendingSendIdempotency: null, SEND_IDEMPOTENCY_WINDOW_MS: 600000, SEND_MAX_RETRIES: 0,
    coinControlEnabled: false, receiveAddress: address,
    response, keyResponse: publicKey, rows, calls, statuses, timers,
    invoke: async (cmd, args) => {
      calls.push({ cmd, ...args });
      return JSON.stringify(args.url.includes('.well-known') ? { signing_pubkey: context.keyResponse } : context.response);
    },
    api: async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/wallet/balance') return { spendable: 1000000000 };
      return { fee: 1000, txid: 'fixture-transaction' };
    },
    document: { getElementById: id => elements[id] },
    getRecipientRows: () => rows, getFirstRecipientRow: () => rows[0],
    getRowAddressInput: row => row.address, getRowAmountInput: row => row.amount,
    getRowMemoInput: row => row.memo, getRowResolvedEl: row => row.resolved,
    normalizeError: error => error.message || String(error),
    escapeHtml: text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    copyable: (addr, label) => label, wireCopyable() {},
    clearSendStatus() {}, showSendStatus: (message, type) => statuses.push({ message, type }),
    parsePaymentRequestUri: () => null, getSelectedInputs: () => [],
    formatBNT: String, freshIdempotencyKey: () => 'fixture-key',
    renderSendConfirm: entries => { context.confirmed = entries; },
    finalizeSend: () => { context.sent = true; },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {}, clearInterval() {},
    setReceiveShortnameStatus: html => { context.receiveStatus = html; },
    saveReceivePrefs: prefs => { context.receivePrefs = prefs; }, renderReceiveAddressAndQr() {}, clearPaymentLink() {},
  });
  const names = ['getBlocknetIdPubKey', 'b64ToBytes', 'verifyResolveSig', 'resolveHandle', 'isHandlePrefix',
    'abbrAddr', 'humanAge', 'showResolved', 'hideResolved', 'showResolveError', 'debouncedResolve',
    'disarmSend', 'handleSend', 'verifyReceiveShortname'];
  vm.runInContext(names.map(shipped).join('\n'), context);
  context.submit = () => context.handleSend({ preventDefault() {} });
  context.elements = elements;
  return context;
}

test('valid binding is normalized, returned from the signed payload, and displayed as verified', async () => {
  const h = harness({ ...signedResponse(), verified: false, unrelated: 'unsigned' });
  const result = await h.resolveHandle(' ALICE ');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { handle: 'alice', address, updated_at: 1772163162, verified: true });
  assert.match(h.calls[0].url, /\/alice$/);
  h.showResolved(h.rows[0], '$', 'alice', result.address, result.verified, result.updated_at);
  assert.match(h.rows[0].resolved.innerHTML, /✓ verified/);
});

const invalid = {
  'unsigned address replaced': () => ({ ...signedResponse(), address: 'attacker-address' }),
  'unsigned handle replaced': () => ({ ...signedResponse(), handle: 'bob' }),
  'unsigned timestamp replaced': () => ({ ...signedResponse(), updated_at: 123 }),
  'timestamp missing': () => ({ ...signedResponse(), updated_at: undefined }),
  'timestamp coerced to string': () => ({ ...signedResponse(), updated_at: '1772163162' }),
  'signed timestamp is a string': () => signedResponse({ updated_at_unix: '1772163162' }),
  'signed timestamp is negative': () => signedResponse({ updated_at_unix: -1 }),
  'signed timestamp is unsafe': () => signedResponse({ updated_at_unix: Number.MAX_SAFE_INTEGER + 1 }),
  'signed timestamp is missing': () => signedResponse({ updated_at_unix: undefined }),
  'signed handle is wrong': () => signedResponse({ handle: 'bob' }),
  'signed handle is not a string': () => signedResponse({ handle: 7 }),
  'signed address is missing': () => signedResponse({ address: undefined }),
  'signed address is empty': () => signedResponse({ address: '' }),
  'signed address is not a string': () => signedResponse({ address: 7 }),
  'signed address contains surrounding whitespace': () => signedResponse({ address: ' ' + address }),
  'signature missing': () => ({ ...signedResponse(), sig: undefined }),
  'signature malformed': () => ({ ...signedResponse(), sig: '!' }),
  'signature wrong': () => ({ ...signedResponse(), sig: Buffer.alloc(64).toString('base64') }),
  'payload changed after signing': () => ({ ...signedResponse(), payload: signedResponse().payload + ' ' }),
  'null response': () => null,
};
for (const [name, response] of Object.entries(invalid)) {
  test(name + ' is rejected before display or sending, including an armed send', async () => {
    const h = harness(response());
    await assert.rejects(h.resolveHandle('alice'), /Couldn't verify/);
    h.sendArmed = true;
    h.pendingSendFingerprint = 'previous confirmation';
    h.rows[0]._resolved = { handle: 'alice', address: 'attacker-address', verified: false };
    await h.submit();
    assert.equal(h.sendArmed, false);
    assert.equal(h.pendingSendFingerprint, null);
    assert.equal(h.rows[0]._resolved, null);
    assert.equal(h.sent, undefined);
    assert.equal(h.confirmed, undefined);
    assert.equal(h.calls.filter(call => call.url.startsWith('/api/wallet/')).length, 0);
    assert.equal(h.elements['send-submit'].disabled, false);
    assert.match(h.rows[0].resolved.innerHTML, /Couldn't verify/);
  });
}

test('signed non-JSON, null, and array payloads are rejected', async () => {
  for (const payload of ['not-json', 'null', '[]']) {
    const h = harness({ ...signedResponse(), payload, sig: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') });
    await assert.rejects(h.resolveHandle('alice'), /Couldn't verify/);
  }
});

test('invalid or unavailable signing keys fail closed', async () => {
  for (const key of [null, '!', Buffer.alloc(32).toString('base64')]) {
    const h = harness();
    h.keyResponse = key;
    await assert.rejects(h.resolveHandle('alice'), /Couldn't verify/);
  }
  const h = harness();
  h.crypto = { subtle: { importKey: async () => { throw new Error('Ed25519 unsupported'); } } };
  await assert.rejects(h.resolveHandle('alice'), /Couldn't verify/);
});

test('normal and coin-control sends keep two-step confirmation and the verified destination', async () => {
  for (const advanced of [false, true]) {
    const h = harness();
    h.coinControlEnabled = advanced;
    h.getSelectedInputs = () => advanced ? ['fixture-input'] : [];
    await h.submit();
    assert.equal(h.sent, undefined);
    assert.equal(h.sendArmed, true);
    assert.equal(h.confirmed[0].address, address);
    await h.submit();
    assert.equal(h.sent, true);
    const payments = h.calls.filter(call => call.options);
    assert.equal(payments.length, 2);
    assert.equal(payments[0].options.body.dry_run, true);
    assert.equal(payments[1].options.body.dry_run, undefined);
    for (const call of payments) {
      assert.equal(call.url, advanced ? '/api/wallet/send/advanced' : '/api/wallet/send');
      assert.equal(call.options.body.recipients[0].address, address);
    }
  }
});

test('raw-address payments do not use the resolver', async () => {
  const h = harness(null, [address]);
  await h.submit();
  await h.submit();
  assert.equal(h.sent, true);
  assert.equal(h.calls.some(call => call.cmd === 'fetch_url'), false);
});

test('one invalid handle blocks the entire multi-recipient send', async () => {
  const h = harness(signedResponse(), [address, '$bob']);
  await h.submit();
  assert.equal(h.calls.some(call => call.options), false);
  assert.equal(h.confirmed, undefined);
  assert.match(h.statuses.at(-1).message, /Recipient #2/);
});

test('receive handle cannot be saved using a substituted address', async () => {
  const h = harness({ ...signedResponse({ address: 'another-wallet' }), address });
  assert.equal(await h.verifyReceiveShortname('alice', true), false);
  assert.equal(h.receivePrefs, undefined);
  assert.match(h.receiveStatus, /Couldn't verify/);
  h.response = signedResponse();
  assert.equal(await h.verifyReceiveShortname('alice', true), true);
  assert.equal(h.receivePrefs.handle, 'alice');
});

test('a missing receive shortname explains registration without saving the preference', async () => {
  const h = harness();
  h.invoke = async () => { throw 'HTTP 404 Not Found'; };
  assert.equal(await h.verifyReceiveShortname('ghoul', true), false);
  assert.match(h.receiveStatus, /Shortname not found/);
  assert.match(h.receiveStatus, /\$ghoul was not found on blocknet.id/);
  assert.match(h.receiveStatus, /register it there and link it to this wallet address/);
  assert.doesNotMatch(h.receiveStatus, /HTTP 404/);
  assert.equal(h.receivePrefs, undefined);
});

test('other lookup failures and missing signing keys are not reported as unregistered names', async () => {
  for (const failure of ['HTTP 500 Internal Server Error', 'fetch failed: timed out', 'HTTP 4040']) {
    const h = harness();
    h.invoke = async () => { throw failure; };
    assert.equal(await h.verifyReceiveShortname('alice', true), false);
    assert.match(h.receiveStatus, /Could not resolve/);
    assert.doesNotMatch(h.receiveStatus, /Shortname not found|register it/);
    assert.equal(h.receivePrefs, undefined);
  }
  const h = harness();
  const invoke = h.invoke;
  h.invoke = async (cmd, args) => {
    if (args.url.includes('.well-known')) throw 'HTTP 404 Not Found';
    return invoke(cmd, args);
  };
  assert.equal(await h.verifyReceiveShortname('alice', true), false);
  assert.match(h.receiveStatus, /Couldn't verify/);
  assert.doesNotMatch(h.receiveStatus, /Shortname not found|register it/);
  assert.equal(h.receivePrefs, undefined);
});

test('editing the handle clears the old badge immediately and stale lookup results are ignored', async () => {
  const h = harness();
  let finish;
  h.resolveHandle = () => new Promise(resolve => { finish = resolve; });
  h.rows[0]._resolved = { handle: 'bob', address, verified: true };
  h.debouncedResolve(h.rows[0]);
  assert.equal(h.rows[0]._resolved, null);
  h.timers.pop()();
  h.rows[0].address.value = '$carol';
  finish({ address, verified: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.rows[0]._resolved, null);
});

test('editing the recipient during submit-time lookup cannot arm or send the previous destination', async () => {
  const h = harness();
  let finish;
  h.resolveHandle = () => new Promise(resolve => { finish = resolve; });
  const pending = h.submit();
  h.rows[0].address.value = '$bob';
  finish({ address, verified: true });
  await pending;
  assert.equal(h.sendArmed, false);
  assert.equal(h.rows[0]._resolved, null);
  assert.equal(h.calls.some(call => call.options), false);
});

test('a failed background lookup clears its destination and cancels confirmation', async () => {
  const h = harness({ ...signedResponse(), address: 'attacker-address' });
  h.sendArmed = true;
  h.pendingSendFingerprint = 'previous confirmation';
  h.debouncedResolve(h.rows[0]);
  const failed = new Promise(resolve => {
    const showError = h.showResolveError;
    h.showResolveError = (...args) => { showError(...args); resolve(); };
  });
  h.timers.pop()();
  await failed;
  assert.equal(h.rows[0]._resolved, null);
  assert.equal(h.sendArmed, false);
  assert.equal(h.pendingSendFingerprint, null);
  assert.match(h.rows[0].resolved.innerHTML, /Couldn't verify/);
});

test('resolver transport and JSON failures block sending and allow a later valid retry', async () => {
  for (const failure of [async () => { throw new Error('Resolver unavailable'); }, async () => '{broken-json']) {
    const h = harness();
    const invoke = h.invoke;
    h.invoke = failure;
    h.sendArmed = true;
    await h.submit();
    assert.equal(h.sendArmed, false);
    assert.equal(h.rows[0]._resolved, null);
    assert.equal(h.confirmed, undefined);
    assert.equal(h.elements['send-submit'].disabled, false);
    h.invoke = invoke;
    await h.submit();
    assert.equal(h.sendArmed, true);
    assert.equal(h.confirmed[0].address, address);
  }
});
