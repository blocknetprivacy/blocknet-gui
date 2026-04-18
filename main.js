let currentView = 'dashboard';
let pollInterval = null;
let realtimeUnlisten = null;
let isNewWallet = false;
let daemonStartPromise = null;
let sessionPassword = '';
let resetChainArmed = false;
let resetChainArmTimer = null;
let viewSeedArmed = false;
let viewSeedArmTimer = null;
let isMining = false;
let threadDebounce = null;
let threadUpdatePending = false;
const MINING_DIFFICULTY_WINDOW = 60;
const MINING_DIFFICULTY_REFRESH_MS = 15000;
let miningDifficultySeries = [];
let miningDifficultyTipHeight = -1;
let miningDifficultyLastRefresh = 0;
let miningDifficultyLoading = false;
let qrDismissTimer = null;
let sendArmed = false;
let sendArmTimer = null;
let pendingSendIdempotency = null;
const SEND_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
let pendingDeepLink = null;
let dashLastHeight = -1;
let dashLastTxCount = -1;
let dashForceRefresh = false;
let peerDetailActiveId = '';
let peerDetailLiveTimer = null;
let navGeneration = 0;

function getPendingSends() {
  try { return JSON.parse(localStorage.getItem(walletKey('pendingSends')) || '[]'); } catch (_) { return []; }
}
function savePendingSends(list) {
  localStorage.setItem(walletKey('pendingSends'), JSON.stringify(list));
}
function addPendingSend(txid, amount, memo) {
  var list = getPendingSends();
  if (list.some(function (p) { return p.txid === txid; })) return;
  list.push({ txid: txid, amount: amount, block_height: 0, spent: true, is_coinbase: false, memo_hex: memo || undefined });
  savePendingSends(list);
}
function prunePendingSends(confirmedOutputs) {
  var list = getPendingSends();
  if (!list.length) return;
  var confirmedTxids = {};
  confirmedOutputs.forEach(function (o) { confirmedTxids[o.txid] = true; });
  var pruned = list.filter(function (p) { return !confirmedTxids[p.txid]; });
  if (pruned.length !== list.length) savePendingSends(pruned);
  return pruned;
}
function mergeWithPending(outputs) {
  var pending = prunePendingSends(outputs);
  if (!pending || !pending.length) return outputs;
  return pending.concat(outputs);
}
let activeWalletName = 'wallet.dat';

function walletKey(base) {
  return base + ':' + activeWalletName;
}

function setActiveWalletName(name) {
  if (typeof name === 'string' && name.trim()) {
    activeWalletName = name.trim();
  }
}

function migrateLocalStorageKeys() {
  // One-time migration: move unnamespaced txCache/addressBook to the active wallet's namespace
  try {
    var oldTx = localStorage.getItem('txCache');
    if (oldTx && !localStorage.getItem(walletKey('txCache'))) {
      localStorage.setItem(walletKey('txCache'), oldTx);
    }
    localStorage.removeItem('txCache');
  } catch (_) {}
  try {
    var oldBook = localStorage.getItem('addressBook');
    if (oldBook && !localStorage.getItem(walletKey('addressBook'))) {
      localStorage.setItem(walletKey('addressBook'), oldBook);
    }
    localStorage.removeItem('addressBook');
  } catch (_) {}
}

// --- Sound Engine ---

var audioCtx = null;
var masterGain = null;
var soundVolume = 0.8;
var soundMuted = false;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.connect(audioCtx.destination);
  loadSoundPrefs();
  applyVolume();
}

function loadSoundPrefs() {
  try {
    var v = localStorage.getItem('soundVolume');
    if (v !== null) soundVolume = parseFloat(v);
    var m = localStorage.getItem('soundMuted');
    if (m !== null) soundMuted = m === 'true';
  } catch (_) {}
}

function saveSoundPrefs() {
  try {
    localStorage.setItem('soundVolume', soundVolume.toString());
    localStorage.setItem('soundMuted', soundMuted.toString());
  } catch (_) {}
}

function applyVolume() {
  if (!masterGain) return;
  masterGain.gain.setValueAtTime(soundMuted ? 0 : soundVolume, audioCtx.currentTime);
}

function playNote(freq, start, dur, type, vol) {
  if (!audioCtx || !masterGain) return;
  var osc = audioCtx.createOscillator();
  var g = audioCtx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime + start);
  g.gain.setValueAtTime(0, audioCtx.currentTime + start);
  g.gain.linearRampToValueAtTime(vol || 0.3, audioCtx.currentTime + start + 0.02);
  g.gain.linearRampToValueAtTime(0, audioCtx.currentTime + start + dur);
  osc.connect(g);
  g.connect(masterGain);
  osc.start(audioCtx.currentTime + start);
  osc.stop(audioCtx.currentTime + start + dur + 0.05);
}

// Intro: gentle ascending arpeggio, C major bright, short and warm
function playIntro() {
  initAudio();
  // C5 E5 G5 C6 ; soft triangle wave, staggered
  playNote(523.25, 0.0,  0.25, 'triangle', 0.18);
  playNote(659.25, 0.1,  0.25, 'triangle', 0.16);
  playNote(783.99, 0.2,  0.25, 'triangle', 0.14);
  playNote(1046.5, 0.3,  0.35, 'sine',     0.12);
}

// Lock: descending, fading, minor feel
function playLock() {
  initAudio();
  // G5 Eb5 C5 G4 ; descending minor, sine, fading out
  playNote(783.99, 0.0,  0.2,  'sine', 0.16);
  playNote(622.25, 0.12, 0.2,  'sine', 0.13);
  playNote(523.25, 0.24, 0.22, 'sine', 0.10);
  playNote(392.00, 0.36, 0.3,  'sine', 0.06);
}

// Unlock / Inbound: bright happy tada ; two quick notes then a resolve
function playTada() {
  initAudio();
  // G5 C6 E6 ; quick ascending major, triangle+sine layered
  playNote(783.99, 0.0,  0.12, 'triangle', 0.2);
  playNote(1046.5, 0.08, 0.12, 'triangle', 0.2);
  playNote(1318.5, 0.16, 0.3,  'sine',     0.18);
  // subtle octave shimmer
  playNote(2637.0, 0.18, 0.25, 'sine',     0.04);
}

function invoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

// --- API Client (proxied through Rust, no CORS) ---

async function api(path, opts = {}) {
  const result = await invoke('api_call', {
    method: opts.method || 'GET',
    path: path,
    body: opts.body ? JSON.stringify(opts.body) : null,
    headers: opts.headers || null,
  });
  return JSON.parse(result);
}

function normalizeError(error) {
  const raw = String(error || '').replace(/^Error:\s*/, '').trim();
  if (!raw) return 'Request failed';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === 'string') return parsed.error;
  } catch (_) {
    // Not JSON, keep original text
  }
  return raw;
}

async function loadOrUnlockWallet(password) {
  try {
    await api('/api/wallet/load', {
      method: 'POST',
      body: { password },
    });
    return;
  } catch (e) {
    const msg = normalizeError(e).toLowerCase();
    if (msg.includes('wallet already loaded')) {
      await api('/api/wallet/unlock', {
        method: 'POST',
        body: { password },
      });
      return;
    }
    throw e;
  }
}

// --- Formatting ---

function formatBNT(atomic) {
  return (atomic / 100000000).toFixed(8);
}

function formatBNTShort(atomic) {
  const val = atomic / 100000000;
  if (val === 0) return '0.00';
  if (val < 0.01) return val.toFixed(8);
  return val.toFixed(2);
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// --- Navigation ---

var viewStack = [];

function navigate(view) {
  if (currentView && currentView !== view) viewStack.push(currentView);
  if (viewStack.length > 20) viewStack.splice(0, viewStack.length - 20);
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById('view-' + view);
  const navEl = document.querySelector('[data-view="' + view + '"]');
  if (viewEl) viewEl.classList.add('active');
  if (navEl) navEl.classList.add('active');

  currentView = view;
  navGeneration++;
  loadView(view, navGeneration);
}

function navigateBack() {
  var prev = viewStack.pop() || 'dashboard';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  var viewEl = document.getElementById('view-' + prev);
  var navEl = document.querySelector('[data-view="' + prev + '"]');
  if (viewEl) viewEl.classList.add('active');
  if (navEl) navEl.classList.add('active');
  currentView = prev;
  navGeneration++;
  loadView(prev, navGeneration);
}

async function loadView(view, gen) {
  try {
    if (gen !== navGeneration) return;
    switch (view) {
      case 'dashboard': await loadDashboard(); break;
      case 'send': renderAddressBook(); break;
      case 'receive': await loadReceive(); break;
      case 'history': await loadHistory(); break;
      case 'mining': await loadMining(); break;
      case 'network': await loadNetwork(); break;
      case 'settings': await loadWalletList(); if (gen !== navGeneration) return; await loadVersions(); break;
    }
  } catch (e) {
    if (gen !== navGeneration) return;
    console.error('Error loading ' + view + ':', e);
  }
}

async function loadVersions() {
  var walletEl = document.getElementById('wallet-version-value');
  var daemonEl = document.getElementById('daemon-version-value');

  if (walletEl) walletEl.textContent = '--';
  if (daemonEl) daemonEl.textContent = '--';

  try {
    var walletVersion = await invoke('get_wallet_version');
    if (walletEl) walletEl.textContent = walletVersion ? String(walletVersion).trim() : '--';
  } catch (_) {}

  try {
    var daemonVersion = await invoke('get_daemon_version');
    if (daemonEl) daemonEl.textContent = daemonVersion ? String(daemonVersion).trim() : '--';
  } catch (_) {
    if (daemonEl) daemonEl.textContent = 'unavailable';
  }
}

// --- Dashboard ---

async function loadDashboard() {
  try {
    var walletTitle = String(activeWalletName || 'wallet.dat').replace(/\.dat$/i, '');
    var walletNameEl = document.getElementById('dash-wallet-name');
    if (walletNameEl) walletNameEl.textContent = walletTitle;

    var shortname = '';
    try {
      var receivePrefsRaw = localStorage.getItem(walletKey('receivePrefs')) || '{}';
      var receivePrefs = JSON.parse(receivePrefsRaw);
      if (receivePrefs && receivePrefs.handle) shortname = '$' + String(receivePrefs.handle);
    } catch (_) {}

    var shortEl = document.getElementById('dash-shortname');
    if (shortEl) {
      if (shortname) {
        shortEl.textContent = shortname;
        shortEl.dataset.copy = shortname;
        delete shortEl.dataset.copyWired;
        shortEl.style.display = '';
        wireCopyable(shortEl.parentNode || shortEl);
      } else {
        shortEl.style.display = 'none';
        shortEl.textContent = '';
        delete shortEl.dataset.copy;
      }
    }
  } catch (_) {}

  try {
    const status = await api('/api/status');
    const heightLabel = status.chain_height.toLocaleString();
    document.getElementById('dash-height').textContent = heightLabel;
    document.getElementById('dash-peers').textContent = status.peers;
    document.getElementById('dash-mempool').textContent = status.mempool_size;
    document.getElementById('dash-syncing').textContent = status.syncing ? 'Syncing' : 'Synced';
    const dot = document.getElementById('status-dot');
    if (dot) {
      dot.className = 'status-dot' + (status.syncing ? ' syncing' : '');
      dot.title = 'height: ' + heightLabel;
      dot.setAttribute('name', 'height: ' + heightLabel);
    }
  } catch (e) {
    console.error('Status error:', e);
  }

  try {
    const balance = await api('/api/wallet/balance');
    document.getElementById('dash-balance').textContent = formatBNTShort(balance.spendable);
    document.getElementById('dash-pending').textContent = formatBNTShort(balance.pending);
    document.getElementById('dash-total').textContent = formatBNTShort(balance.total);
    document.getElementById('pending-label').classList.toggle('has-pending', balance.pending > 0);
  } catch (e) {
    // balance may fail during sync, that's ok
  }

  try {
    var statusHeight = parseInt(document.getElementById('dash-height').textContent.replace(/,/g, '')) || 0;
    if (statusHeight !== dashLastHeight || dashForceRefresh) {
      dashLastHeight = statusHeight;
      dashForceRefresh = false;
      var data = await api('/api/wallet/history');
      var container = document.getElementById('dash-recent-tx');
      var hasOutputsArray = data && Array.isArray(data.outputs);
      var outputs = hasOutputsArray ? data.outputs : null;
      var fromCache = false;
      if (hasOutputsArray) {
        try { localStorage.setItem(walletKey('txCache'), JSON.stringify(outputs)); } catch (_) {}
      } else {
        try { outputs = JSON.parse(localStorage.getItem(walletKey('txCache')) || 'null'); fromCache = true; } catch (_) {}
      }
      if (outputs) outputs = mergeWithPending(outputs);
      if (!outputs || outputs.length === 0) {
        container.innerHTML = '<div class="empty">No transactions yet</div>';
        dashLastTxCount = 0;
      } else {
        // Detect new inbound transactions
        if (!fromCache) {
          var inboundCount = outputs.filter(function (o) { return !o.spent; }).length;
          if (dashLastTxCount >= 0 && inboundCount > dashLastTxCount) {
            playTada();
          }
          dashLastTxCount = inboundCount;
        }

        var sorted = outputs.slice().sort(function (a, b) {
          if (!a.block_height && b.block_height) return -1;
          if (a.block_height && !b.block_height) return 1;
          return b.block_height - a.block_height;
        });
        var limit = window.innerHeight < 720 ? 3 : 5;
        var recent = sorted.slice(0, limit);
        container.innerHTML = recent.map(function (o) {
          var typeLabel = o.is_coinbase ? 'mining reward' : (o.spent ? 'sent' : 'received');
          var memoText = o.memo_hex ? hexToUtf8(o.memo_hex) : '';
          return '<div class="recent-tx-row' + (o.spent ? ' spent' : '') + (fromCache ? ' cached' : '') + '" data-txid="' + o.txid + '">' +
            '<span class="recent-tx-amount ' + (o.spent ? 'r' : 'g') + '">' +
              (o.spent ? '-' : '+') + formatBNTShort(o.amount) + ' BNT' +
            '</span>' +
            '<span class="recent-tx-type ' + (o.spent ? 'r' : 'g') + '">' + typeLabel + '</span>' +
            (memoText ? '<span class="recent-tx-memo d">"' + escapeHtml(memoText) + '"</span>' : '') +
            '<span class="recent-tx-block d">' + (o.block_height ? 'Block ' + o.block_height : 'Pending') + '</span>' +
          '</div>';
        }).join('');
        container.querySelectorAll('.recent-tx-row[data-txid]').forEach(function (row) {
          row.addEventListener('click', function () { showTxDetail(row.dataset.txid); });
        });
        if (fromCache) {
          container.insertAdjacentHTML('beforeend', '<div class="tx-cache-note d">Cached ; resyncing blockchain</div>');
        }
      }
    }
  } catch (e) {
    // history may fail during sync
  }
}

// --- Receive ---

var receiveAddress = '';
var receivePreferredHandle = null;
var receiveHandleResolveTimer = null;
var requestLinkMode = 'blocknet';

function getReceivePrefs() {
  try {
    return JSON.parse(localStorage.getItem(walletKey('receivePrefs')) || '{}');
  } catch (_) {
    return {};
  }
}

function saveReceivePrefs(prefs) {
  localStorage.setItem(walletKey('receivePrefs'), JSON.stringify(prefs || {}));
}

function normalizeHandleInput(raw) {
  var v = String(raw || '').trim();
  if (!v) return '';
  if (isHandlePrefix(v.charAt(0))) v = v.slice(1).trim();
  return v;
}

function getReceiveHandleUriTarget() {
  return receivePreferredHandle ? ('$' + receivePreferredHandle) : receiveAddress;
}

function setRequestLinkMode(mode) {
  requestLinkMode = mode === 'bntpay' ? 'bntpay' : 'blocknet';
  var blockBtn = document.getElementById('request-link-mode-blocknet');
  var webBtn = document.getElementById('request-link-mode-bntpay');
  if (blockBtn) blockBtn.classList.toggle('active', requestLinkMode === 'blocknet');
  if (webBtn) webBtn.classList.toggle('active', requestLinkMode === 'bntpay');

  var group = document.getElementById('request-link-group');
  if (group && group.style.display !== 'none') {
    generatePaymentLink();
  }
}

function setReceiveShortnameStatus(html, cls) {
  var el = document.getElementById('receive-shortname-status');
  if (!el) return;
  if (!html) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.className = 'send-resolved' + (cls ? ' ' + cls : '');
  el.innerHTML = html;
  el.style.display = 'block';
}

function renderReceiveAddressAndQr() {
  var target = getReceiveHandleUriTarget();
  var addrEl = document.getElementById('receive-address');
  if (addrEl) {
    if (receivePreferredHandle) {
      addrEl.innerHTML = '<span class="g">$' + escapeHtml(receivePreferredHandle) + '</span> <span class="d">(resolves to this wallet)</span>';
      addrEl.dataset.copy = '$' + receivePreferredHandle;
    } else {
      addrEl.textContent = receiveAddress || 'Loading...';
      addrEl.dataset.copy = receiveAddress || '';
    }
    delete addrEl.dataset.copyWired;
    wireCopyable();
  }
  if (target && typeof qrcode === 'function') {
    var svgHtml = renderQRSvg(target);
    document.getElementById('qr-container').innerHTML = svgHtml;
    document.getElementById('qr-overlay-inner').innerHTML = svgHtml;
  }
}

async function verifyReceiveShortname(handle, persist) {
  if (!handle) {
    setReceiveShortnameStatus('', '');
    return false;
  }
  setReceiveShortnameStatus('<span class="d">Resolving $' + escapeHtml(handle) + '...</span>');
  try {
    var data = await resolveHandle(handle);
    var sameAddress = String(data.address || '') === String(receiveAddress || '');
    if (!data.verified) {
      setReceiveShortnameStatus('<span class="resolve-fail">✗ Not verified</span> <span class="d">$' + escapeHtml(handle) + '</span>');
      return false;
    }
    if (!sameAddress) {
      setReceiveShortnameStatus(
        '<span class="resolve-fail">✗ Resolves elsewhere</span> ' +
        '<span class="d">$' + escapeHtml(handle) + ' → ' + escapeHtml(abbrAddr(String(data.address || ''))) + '</span>'
      );
      return false;
    }
    setReceiveShortnameStatus('<span class="resolve-ok">✓ $' + escapeHtml(handle) + ' verified for this wallet</span>');
    if (persist) {
      receivePreferredHandle = handle;
      saveReceivePrefs({ handle: handle });
      renderReceiveAddressAndQr();
      clearPaymentLink();
    }
    return true;
  } catch (e) {
    setReceiveShortnameStatus('<span class="resolve-fail">✗ Could not resolve</span> <span class="d">' + escapeHtml(normalizeError(e)) + '</span>');
    return false;
  }
}

function debouncedVerifyReceiveShortname() {
  if (receiveHandleResolveTimer) clearTimeout(receiveHandleResolveTimer);
  var input = document.getElementById('receive-shortname');
  if (!input) return;
  var handle = normalizeHandleInput(input.value);
  if (!handle) {
    setReceiveShortnameStatus('', '');
    return;
  }
  receiveHandleResolveTimer = setTimeout(function () {
    var current = normalizeHandleInput((document.getElementById('receive-shortname').value || ''));
    if (current !== handle) return;
    verifyReceiveShortname(handle, false);
  }, 1800);
}

async function loadReceive() {
  const data = await api('/api/wallet/address');
  receiveAddress = data.address;
  receivePreferredHandle = null;

  var prefs = getReceivePrefs();
  var input = document.getElementById('receive-shortname');
  if (input) input.value = prefs && prefs.handle ? ('$' + prefs.handle) : '';
  setReceiveShortnameStatus('', '');
  if (prefs && prefs.handle) {
    await verifyReceiveShortname(String(prefs.handle), true);
  } else {
    renderReceiveAddressAndQr();
  }

  document.getElementById('request-amount').value = '';
  document.getElementById('request-memo').value = '';
  document.getElementById('request-link-group').style.display = 'none';
  setRequestLinkMode(requestLinkMode || 'blocknet');
}

function generatePaymentLink() {
  if (!receiveAddress) return;
  var amount = (document.getElementById('request-amount').value || '').trim();
  var memo = (document.getElementById('request-memo').value || '').trim();
  var target = getReceiveHandleUriTarget();

  var uri = 'blocknet://' + target;
  var params = [];
  if (amount && parseFloat(amount) > 0) params.push('amount=' + encodeURIComponent(amount));
  if (memo) params.push('memo=' + encodeURIComponent(memo));
  if (params.length) uri += '?' + params.join('&');

  var webUri = 'https://bntpay.com/' + target;
  if (params.length) webUri += '?' + params.join('&');
  var shownUri = requestLinkMode === 'bntpay' ? webUri : uri;

  var group = document.getElementById('request-link-group');
  var linkEl = document.getElementById('request-link');
  linkEl.textContent = shownUri;
  linkEl.dataset.copy = shownUri;
  delete linkEl.dataset.copyWired;
  group.style.display = '';

  wireCopyable();

  if (typeof qrcode === 'function') {
    var svgHtml = renderQRSvg(shownUri);
    document.getElementById('qr-container').innerHTML = svgHtml;
    document.getElementById('qr-overlay-inner').innerHTML = svgHtml;
  }
}

function clearPaymentLink() {
  var group = document.getElementById('request-link-group');
  if (group) group.style.display = 'none';
  var target = getReceiveHandleUriTarget();
  if (!target) return;
  if (typeof qrcode === 'function') {
    var svgHtml = renderQRSvg(target);
    document.getElementById('qr-container').innerHTML = svgHtml;
    document.getElementById('qr-overlay-inner').innerHTML = svgHtml;
  }
}

async function saveReceiveShortname() {
  var input = document.getElementById('receive-shortname');
  if (!input) return;
  var handle = normalizeHandleInput(input.value);
  if (!handle) {
    setReceiveShortnameStatus('<span class="d">Enter a shortname first</span>');
    return;
  }
  await verifyReceiveShortname(handle, true);
}

function clearReceiveShortname() {
  receivePreferredHandle = null;
  saveReceivePrefs({});
  var input = document.getElementById('receive-shortname');
  if (input) input.value = '';
  setReceiveShortnameStatus('', '');
  renderReceiveAddressAndQr();
  clearPaymentLink();
}

function renderQRSvg(text) {
  var qr = qrcode(0, 'H');
  qr.addData(text);
  qr.make();
  var n = qr.getModuleCount();
  var cell = 10;
  var quiet = 4 * cell;
  var size = n * cell + quiet * 2;
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">';
  svg += '<rect width="' + size + '" height="' + size + '" fill="#af0" rx="6"/>';
  for (var r = 0; r < n; r++)
    for (var c = 0; c < n; c++)
      if (qr.isDark(r, c))
        svg += '<rect x="' + (quiet + c * cell) + '" y="' + (quiet + r * cell) + '" width="' + cell + '" height="' + cell + '"/>';
  var cx = size / 2, cy = size / 2;
  var maxCover = Math.floor(n * 0.18);
  var logoR = Math.floor(maxCover / 2) * cell;
  var pad = cell;
  var boxR = logoR + pad;
  svg += '<rect x="' + (cx - boxR) + '" y="' + (cy - boxR) + '" width="' + (boxR * 2) + '" height="' + (boxR * 2) + '" rx="' + (cell * 1.5) + '" fill="#af0"/>';
  svg += '<image href="blocknet.svg" x="' + (cx - logoR) + '" y="' + (cy - logoR) + '" width="' + (logoR * 2) + '" height="' + (logoR * 2) + '"/>';
  svg += '</svg>';
  return svg;
}

function showQROverlay() {
  var overlay = document.getElementById('qr-overlay');
  overlay.classList.add('visible');
  if (qrDismissTimer) clearTimeout(qrDismissTimer);
  qrDismissTimer = setTimeout(dismissQROverlay, 10000);
}

function dismissQROverlay() {
  var overlay = document.getElementById('qr-overlay');
  overlay.classList.remove('visible');
  if (qrDismissTimer) { clearTimeout(qrDismissTimer); qrDismissTimer = null; }
}

// --- History ---

async function loadHistory() {
  const data = await api('/api/wallet/history');
  const container = document.getElementById('history-list');

  var hasOutputsArray = data && Array.isArray(data.outputs);
  var outputs = hasOutputsArray ? data.outputs : null;
  var fromCache = false;
  if (hasOutputsArray) {
    try { localStorage.setItem(walletKey('txCache'), JSON.stringify(outputs)); } catch (_) {}
  } else {
    try { outputs = JSON.parse(localStorage.getItem(walletKey('txCache')) || 'null'); fromCache = true; } catch (_) {}
  }

  if (outputs) outputs = mergeWithPending(outputs);

  if (!outputs || outputs.length === 0) {
    renderHistoryBalanceSparkline([]);
    container.innerHTML = '<div class="empty">No transactions yet</div>';
    return;
  }

  renderHistoryBalanceSparkline(outputs);

  // Show newest first
  const sorted = outputs.slice().sort(function (a, b) {
    if (!a.block_height && b.block_height) return -1;
    if (a.block_height && !b.block_height) return 1;
    return b.block_height - a.block_height;
  });

  container.innerHTML = sorted.map(o => {
    const typeLabel = o.is_coinbase ? 'mining reward' : (o.spent ? 'sent' : 'received');
    return '<div class="history-row' + (o.spent ? ' spent' : '') + '" data-txid="' + o.txid + '">' +
      '<div class="history-amount ' + (o.spent ? 'r' : 'g') + '">' +
        (o.spent ? '-' : '+') + formatBNT(o.amount) + ' BNT' +
      '</div>' +
      '<div class="history-meta">' +
        (o.block_height
          ? '<a class="detail-link d" data-block="' + o.block_height + '">Block ' + o.block_height + '</a>'
          : '<span class="d">Pending</span>') +
        '<span class="' + (o.spent ? 'r' : 'g') + '">' + typeLabel + '</span>' +
      '</div>' +
      memoHtml(o) +
      '<div class="history-tx d">' + copyable(o.txid, o.txid.substring(0, 24) + '...') + '</div>' +
    '</div>';
  }).join('');

  if (fromCache) {
    container.insertAdjacentHTML('afterbegin', '<div class="tx-cache-note d">Showing cached history ; resyncing blockchain</div>');
  }

  wireCopyable(container);
  container.querySelectorAll('.history-row[data-txid]').forEach(row => {
    row.addEventListener('click', function () { showTxDetail(row.dataset.txid); });
  });
  container.querySelectorAll('[data-block]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.stopPropagation(); showBlockDetail(el.dataset.block); });
  });
}

async function exportHistoryCSV() {
  var btn = document.getElementById('export-csv-btn');
  if (btn.dataset.openPath) {
    invoke('open_file', { path: btn.dataset.openPath });
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    var data = await api('/api/wallet/history');
    var hasOutputsArray = data && Array.isArray(data.outputs);
    var outputs = hasOutputsArray ? data.outputs : null;
    if (!hasOutputsArray) {
      try { outputs = JSON.parse(localStorage.getItem(walletKey('txCache')) || 'null'); } catch (_) {}
    }
    if (!outputs || outputs.length === 0) {
      btn.textContent = 'No data';
      setTimeout(function () { btn.disabled = false; btn.textContent = 'Export CSV'; }, 2000);
      return;
    }
    var sorted = outputs.slice().sort(function (a, b) { return b.block_height - a.block_height; });
    var lines = ['txid,output_index,amount_bnt,block_height,type,spent,spent_height'];
    for (var i = 0; i < sorted.length; i++) {
      var o = sorted[i];
      var type = o.is_coinbase ? 'mining_reward' : (o.spent ? 'sent' : 'received');
      lines.push(
        o.txid + ',' +
        o.output_index + ',' +
        formatBNT(o.amount) + ',' +
        o.block_height + ',' +
        type + ',' +
        o.spent + ',' +
        (o.spent_height || '')
      );
    }
    var csv = lines.join('\n');
    var now = new Date();
    var ts = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    var savedPath = await invoke('save_file', {
      filename: 'blocknet-history-' + ts + '.csv',
      contents: csv,
    });
    btn.textContent = 'Saved to ' + savedPath;
    btn.disabled = false;
    btn.dataset.openPath = savedPath;
    setTimeout(function () {
      btn.textContent = 'Export CSV';
      delete btn.dataset.openPath;
    }, 5000);
  } catch (e) {
    console.error('CSV export error:', e);
    btn.textContent = 'Export failed';
    setTimeout(function () { btn.disabled = false; btn.textContent = 'Export CSV'; }, 3000);
  }
}

function renderHistoryBalanceSparkline(outputs) {
  const root = document.getElementById('history-balance-sparkline');
  if (!root) return;
  if (!outputs || outputs.length < 2) {
    root.innerHTML = '';
    return;
  }

  const sorted = outputs.slice().sort((a, b) => {
    const ah = Number(a.block_height || 0);
    const bh = Number(b.block_height || 0);
    if (ah !== bh) return ah - bh;
    return Number(a.output_index || 0) - Number(b.output_index || 0);
  });

  const series = [{ height: Number(sorted[0].block_height || 0) - 1, value: 0 }];
  let running = 0;
  for (const out of sorted) {
    const amount = Number(out.amount || 0);
    running += out.spent ? -amount : amount;
    series.push({
      height: Number(out.block_height || 0),
      value: running,
    });
  }

  if (series.length < 2) {
    root.innerHTML = '';
    return;
  }

  const width = 1200;
  const height = 280;
  const padX = 6;
  const padTop = 20;
  const padBottom = 12;
  const plotWidth = width - (padX * 2);
  const plotHeight = height - padTop - padBottom;
  const values = series.map(item => item.value);
  const min = Math.min(0, Math.min.apply(null, values));
  const max = Math.max(0, Math.max.apply(null, values));
  const span = max - min || 1;
  const baselineY = padTop + ((max - 0) / span) * plotHeight;

  const points = series.map((item, i) => {
    const x = padX + ((plotWidth * i) / (series.length - 1));
    const y = padTop + ((max - item.value) / span) * plotHeight;
    return { x, y };
  });

  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ');
  const areaToBaselinePath = linePath +
    ' L' + points[points.length - 1].x.toFixed(2) + ',' + baselineY.toFixed(2) +
    ' L' + points[0].x.toFixed(2) + ',' + baselineY.toFixed(2) + ' Z';

  root.innerHTML =
    '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" role="img" aria-label="Balance trend">' +
      '<defs>' +
        '<clipPath id="history-over-clip"><rect x="0" y="0" width="' + width + '" height="' + baselineY.toFixed(2) + '" /></clipPath>' +
        '<clipPath id="history-under-clip"><rect x="0" y="' + baselineY.toFixed(2) + '" width="' + width + '" height="' + (height - baselineY).toFixed(2) + '" /></clipPath>' +
        '<linearGradient id="history-over-fill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#AF0" stop-opacity="0.22" />' +
          '<stop offset="100%" stop-color="#AF0" stop-opacity="0" />' +
        '</linearGradient>' +
        '<linearGradient id="history-under-fill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="orangered" stop-opacity="0" />' +
          '<stop offset="100%" stop-color="orangered" stop-opacity="0.22" />' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="' + areaToBaselinePath + '" fill="url(#history-over-fill)" clip-path="url(#history-over-clip)" />' +
      '<path d="' + areaToBaselinePath + '" fill="url(#history-under-fill)" clip-path="url(#history-under-clip)" />' +
      '<path d="' + linePath + '" fill="none" stroke="#AF0" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#history-over-clip)" />' +
      '<path d="' + linePath + '" fill="none" stroke="orangered" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#history-under-clip)" />' +
    '</svg>';
}

// --- Mining ---

async function loadMining() {
  // Skip UI refresh while a toggle or thread change is in progress
  if (miningToggleBusy) return;

  const data = await api('/api/mining');
  isMining = data.running;

  const indicator = document.getElementById('mining-indicator');
  indicator.className = 'mining-indicator' + (data.running ? ' active' : '');
  document.getElementById('mining-status').textContent = data.running ? 'Running' : 'Stopped';

  if (!threadUpdatePending) {
    updateStepperState(data.threads);
  }

  document.getElementById('mining-hashrate').textContent = data.running
    ? (data.hashrate || 0).toFixed(2) + ' H/s' : '--';
  document.getElementById('mining-blocks').textContent = data.running
    ? (data.blocks_found || 0) : '--';

  const btn = document.getElementById('mining-toggle');
  if (!btn.disabled) {
    btn.textContent = data.running ? 'Stop Mining' : 'Start Mining';
    btn.className = 'mining-toggle-btn' + (data.running ? ' running' : '');
  }

  await refreshMiningDifficultySparkline();
  await loadMiningMempool();
}

async function fetchDifficultyByHeights(heights) {
  const results = await Promise.all(heights.map(async (height) => {
    try {
      const block = await api('/api/block/' + height);
      return {
        height: Number(block.height),
        difficulty: Number(block.difficulty),
      };
    } catch (_) {
      return null;
    }
  }));

  return results
    .filter(Boolean)
    .filter(item => Number.isFinite(item.height) && Number.isFinite(item.difficulty))
    .sort((a, b) => a.height - b.height);
}

function renderMiningDifficultySparkline(series) {
  const root = document.getElementById('mining-difficulty-sparkline');
  if (!root) return;

  if (!series || series.length < 2) {
    root.innerHTML = '';
    return;
  }

  const width = 1200;
  const height = 280;
  const padX = 6;
  const padTop = 20;
  const padBottom = 12;
  const plotWidth = width - (padX * 2);
  const plotHeight = height - padTop - padBottom;
  const values = series.map(item => item.difficulty);
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = max - min;

  const points = series.map((item, i) => {
    const x = padX + ((plotWidth * i) / (series.length - 1));
    const normalized = span === 0 ? 0.5 : ((item.difficulty - min) / span);
    const y = padTop + ((1 - normalized) * plotHeight);
    return { x, y };
  });

  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ');
  const areaPath = linePath +
    ' L' + points[points.length - 1].x.toFixed(2) + ',' + (height - 1) +
    ' L' + points[0].x.toFixed(2) + ',' + (height - 1) + ' Z';

  root.innerHTML =
    '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" role="img" aria-label="Mining difficulty trend">' +
      '<defs>' +
        '<linearGradient id="difficulty-fill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#AF0" stop-opacity="0.24" />' +
          '<stop offset="100%" stop-color="#000" stop-opacity="0" />' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="' + areaPath + '" fill="url(#difficulty-fill)" />' +
      '<path d="' + linePath + '" fill="none" stroke="#AF0" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />' +
    '</svg>';
}

async function refreshMiningDifficultySparkline() {
  const root = document.getElementById('mining-difficulty-sparkline');
  if (!root || miningDifficultyLoading) return;

  const now = Date.now();
  if (miningDifficultySeries.length > 1 && (now - miningDifficultyLastRefresh) < MINING_DIFFICULTY_REFRESH_MS) {
    return;
  }

  miningDifficultyLoading = true;
  try {
    const status = await api('/api/status');
    const tip = Number(status.chain_height || 0);
    if (!Number.isFinite(tip) || tip < 0) return;

    if (tip === miningDifficultyTipHeight && miningDifficultySeries.length > 1) {
      miningDifficultyLastRefresh = now;
      renderMiningDifficultySparkline(miningDifficultySeries);
      return;
    }

    let nextSeries = miningDifficultySeries.slice();
    if (nextSeries.length > 0 && tip > miningDifficultyTipHeight && (tip - miningDifficultyTipHeight) <= 4) {
      const missingHeights = [];
      for (let h = miningDifficultyTipHeight + 1; h <= tip; h++) missingHeights.push(h);
      const incoming = await fetchDifficultyByHeights(missingHeights);
      nextSeries = nextSeries.concat(incoming);
      if (nextSeries.length > MINING_DIFFICULTY_WINDOW) {
        nextSeries = nextSeries.slice(nextSeries.length - MINING_DIFFICULTY_WINDOW);
      }
    } else {
      const start = Math.max(0, tip - MINING_DIFFICULTY_WINDOW + 1);
      const heights = [];
      for (let h = start; h <= tip; h++) heights.push(h);
      nextSeries = await fetchDifficultyByHeights(heights);
    }

    if (nextSeries.length > 1) {
      miningDifficultySeries = nextSeries;
      miningDifficultyTipHeight = tip;
      miningDifficultyLastRefresh = now;
      renderMiningDifficultySparkline(miningDifficultySeries);
    }
  } catch (_) {
    // Keep current sparkline on transient API failures.
  } finally {
    miningDifficultyLoading = false;
  }
}

async function loadMiningMempool() {
  const listEl = document.getElementById('mining-mempool-list');
  const metaEl = document.getElementById('mining-mempool-meta');
  if (!listEl || !metaEl) return;

  let stats;
  try {
    stats = await api('/api/mempool');
  } catch (e) {
    metaEl.textContent = 'Unavailable';
    listEl.innerHTML = '<div class="empty">Unable to load mempool data</div>';
    return;
  }

  const count = Number(stats.count || 0);
  const sizeBytes = Number(stats.size_bytes || 0);
  const minFee = Number(stats.min_fee || 0);
  const maxFee = Number(stats.max_fee || 0);
  const avgFee = Number(stats.avg_fee || 0);

  metaEl.textContent = count.toLocaleString() + ' tx • ' + formatBytes(sizeBytes);

  const nextBlockClass = count === 0 ? 'mempool-next-block zero' : 'mempool-next-block';
  listEl.innerHTML =
    '<div class="' + nextBlockClass + '">' +
      '<span class="label">Next block candidate</span>' +
      '<span class="value">' + count.toLocaleString() + ' pending tx</span>' +
    '</div>' +
    '<div class="mempool-stats-grid">' +
      '<div class="mempool-stat-item"><span class="label">Total Size</span><span class="value">' + formatBytes(sizeBytes) + '</span></div>' +
      '<div class="mempool-stat-item"><span class="label">Min Fee</span><span class="value">' + formatBNT(minFee) + ' BNT</span></div>' +
      '<div class="mempool-stat-item"><span class="label">Avg Fee</span><span class="value">' + formatBNT(Math.round(avgFee)) + ' BNT</span></div>' +
      '<div class="mempool-stat-item"><span class="label">Max Fee</span><span class="value">' + formatBNT(maxFee) + ' BNT</span></div>' +
    '</div>';
}

let miningToggleBusy = false;

async function toggleMining() {
  if (miningToggleBusy) return;
  miningToggleBusy = true;
  const btn = document.getElementById('mining-toggle');
  btn.disabled = true;
  document.getElementById('threads-dec').disabled = true;
  document.getElementById('threads-inc').disabled = true;
  const wasRunning = isMining;
  btn.textContent = wasRunning ? 'Stopping...' : 'Starting...';
  try {
    if (wasRunning) {
      await api('/api/mining/stop', { method: 'POST' });
    } else {
      await api('/api/mining/start', { method: 'POST' });
    }
    // Poll until the daemon reflects the expected state (up to 10s)
    var expected = !wasRunning;
    for (var attempt = 0; attempt < 20; attempt++) {
      await new Promise(function (r) { setTimeout(r, 500); });
      try {
        var status = await api('/api/mining');
        if (status.running === expected) {
          isMining = status.running;
          break;
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error('Mining toggle error:', e);
  }
  miningToggleBusy = false;
  btn.disabled = false;
  await loadMining();
}

function updateStepperState(count) {
  document.getElementById('mining-threads').textContent = count;
  document.getElementById('threads-dec').disabled = count <= 1;
  var max = navigator.hardwareConcurrency || 16;
  document.getElementById('threads-inc').disabled = count >= max;
  var hint = document.getElementById('thread-hint');
  if (hint) hint.textContent = '~' + (count * 2) + ' GB RAM';
}

function changeThreads(delta) {
  if (miningToggleBusy) return;
  var el = document.getElementById('mining-threads');
  var current = parseInt(el.textContent) || 1;
  var max = navigator.hardwareConcurrency || 16;
  var next = Math.max(1, Math.min(max, current + delta));
  if (next === current) return;

  threadUpdatePending = true;
  updateStepperState(next);

  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');

  if (threadDebounce) clearTimeout(threadDebounce);
  threadDebounce = setTimeout(async function () {
    try {
      await api('/api/mining/threads', { method: 'POST', body: { threads: next } });
    } catch (e) {
      console.error('Set threads error:', e);
    }
    threadUpdatePending = false;
    threadDebounce = null;
    // If mining is running, give the daemon time to restart with new thread count
    if (isMining) {
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    await loadMining();
  }, 300);
}

// --- Network ---

function normalizePeerEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(function (entry) {
    if (typeof entry === 'string') {
      return { peer_id: entry, addrs: [] };
    }
    if (entry && typeof entry === 'object') {
      return {
        peer_id: String(entry.peer_id || ''),
        addrs: Array.isArray(entry.addrs) ? entry.addrs.map(function (a) { return String(a); }) : [],
        reason: entry.reason,
        ban_count: entry.ban_count,
        permanent: entry.permanent,
        expires_at: entry.expires_at,
      };
    }
    return { peer_id: '', addrs: [] };
  }).filter(function (p) { return !!p.peer_id; });
}

function classifyAddrScope(addr) {
  var s = String(addr || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.indexOf('/p2p-circuit') >= 0) return 'relay';
  if (s.indexOf('/onion') >= 0 || s.indexOf('/tor') >= 0) return 'tor';
  if (s.indexOf('/garlic') >= 0 || s.indexOf('/i2p') >= 0) return 'i2p';
  if (s.indexOf('/dns') >= 0) return 'dns';
  if (s.indexOf('/ip4/127.') >= 0 || s.indexOf('/ip6/::1') >= 0) return 'loopback';
  if (s.indexOf('/ip4/10.') >= 0 || s.indexOf('/ip4/192.168.') >= 0 || /\/ip4\/172\.(1[6-9]|2\d|3[0-1])\./.test(s)) return 'private';
  if (s.indexOf('/ip4/') >= 0 || s.indexOf('/ip6/') >= 0) return 'public';
  return 'unknown';
}

function summarizePeerAddressHints(addrs) {
  var types = {};
  (Array.isArray(addrs) ? addrs : []).forEach(function (a) { types[classifyAddrScope(a)] = true; });
  if (types.tor) return 'tor';
  if (types.i2p) return 'i2p';
  if (types.relay) return 'relay';
  if (types.public) return 'public ip';
  if (types.private) return 'private ip';
  if (types.dns) return 'dns';
  if (types.loopback) return 'loopback';
  return 'unknown';
}

function inferMultiaddrTraits(addrs) {
  var list = Array.isArray(addrs) ? addrs : [];
  var ipFamilies = {};
  var hostForms = {};
  var transports = {};
  var overlays = {};
  var scopes = {};
  var tcpPorts = {};
  var udpPorts = {};
  var publicCount = 0;
  var privateLikeCount = 0;

  list.forEach(function (addr) {
    var s = String(addr || '');
    var parts = s.split('/').filter(Boolean);
    var scope = classifyAddrScope(s);
    scopes[scope] = true;
    if (scope === 'public') publicCount += 1;
    if (scope === 'private' || scope === 'loopback') privateLikeCount += 1;

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].toLowerCase();
      var next = parts[i + 1] || '';
      if (p === 'ip4') { ipFamilies.ipv4 = true; hostForms.ip4 = true; }
      if (p === 'ip6') { ipFamilies.ipv6 = true; hostForms.ip6 = true; }
      if (p === 'dns') hostForms.dns = true;
      if (p === 'dns4') hostForms.dns4 = true;
      if (p === 'dns6') hostForms.dns6 = true;
      if (p === 'dnsaddr') hostForms.dnsaddr = true;
      if (p === 'tcp') { transports.tcp = true; if (next) tcpPorts[next] = true; }
      if (p === 'udp') { transports.udp = true; if (next) udpPorts[next] = true; }
      if (p === 'quic' || p === 'quic-v1') transports.quic = true;
      if (p === 'ws') transports.ws = true;
      if (p === 'wss') transports.wss = true;
      if (p === 'webtransport') transports.webtransport = true;
      if (p === 'webrtc') transports.webrtc = true;
      if (p === 'p2p-circuit') overlays.relay = true;
      if (p === 'onion' || p === 'onion3' || p === 'tor') overlays.tor = true;
      if (p === 'garlic64' || p === 'i2p') overlays.i2p = true;
    }
  });

  function keys(obj) { return Object.keys(obj); }
  function csv(arr, fallback) { return arr.length ? arr.join(', ') : fallback; }

  return {
    ipFamily: csv(keys(ipFamilies), 'none'),
    hostForms: csv(keys(hostForms), 'unknown'),
    transports: csv(keys(transports), 'unknown'),
    overlays: csv(keys(overlays), 'none'),
    scopeMix: csv(keys(scopes), 'unknown'),
    tcpPorts: csv(keys(tcpPorts), 'none'),
    udpPorts: csv(keys(udpPorts), 'none'),
    publicCount: publicCount,
    privateLikeCount: privateLikeCount,
    total: list.length,
  };
}

function extractIpFromMultiaddr(addr) {
  var s = String(addr || '');
  var m4 = s.match(/\/ip4\/([^/]+)/);
  if (m4 && m4[1]) return m4[1];
  var m6 = s.match(/\/ip6\/([^/]+)/);
  if (m6 && m6[1]) return m6[1];
  return '';
}

function isPublicIp(ip) {
  var s = String(ip || '').trim().toLowerCase();
  if (!s) return false;
  if (s.indexOf(':') >= 0) {
    if (s === '::1') return false;
    if (s.indexOf('fc') === 0 || s.indexOf('fd') === 0) return false;
    if (s.indexOf('fe8') === 0 || s.indexOf('fe9') === 0 || s.indexOf('fea') === 0 || s.indexOf('feb') === 0) return false;
    return true;
  }
  var parts = s.split('.').map(function (p) { return parseInt(p, 10); });
  if (parts.length !== 4 || parts.some(function (n) { return isNaN(n) || n < 0 || n > 255; })) return false;
  if (parts[0] === 10) return false;
  if (parts[0] === 127) return false;
  if (parts[0] === 192 && parts[1] === 168) return false;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  return true;
}

function getGeoCache() {
  try {
    return JSON.parse(localStorage.getItem(walletKey('peerGeoCache')) || '{}');
  } catch (_) {
    return {};
  }
}

function saveGeoCache(cache) {
  localStorage.setItem(walletKey('peerGeoCache'), JSON.stringify(cache));
}

async function geolocateIp(ip) {
  var cache = getGeoCache();
  var key = String(ip || '').trim();
  if (!key) return null;
  if (cache[key]) return cache[key];

  try {
    var raw = '';
    try {
      // Prefer Rust-side fetch proxy to avoid webview CORS/connect restrictions.
      raw = await invoke('fetch_url', { url: 'https://ipwho.is/' + encodeURIComponent(key) });
    } catch (_) {
      // Fallback to browser fetch in case invoke path is unavailable.
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 5000);
      var res = await fetch('https://ipwho.is/' + encodeURIComponent(key), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      raw = await res.text();
    }
    var data = JSON.parse(raw);
    if (!data || data.success === false) return null;
    var geo = {
      ip: key,
      country: data.country || '',
      country_code: data.country_code || '',
      continent: data.continent || '',
      region: data.region || '',
      city: data.city || '',
      timezone: data.timezone && data.timezone.id ? String(data.timezone.id) : '',
      lat: typeof data.latitude === 'number' ? data.latitude : null,
      lon: typeof data.longitude === 'number' ? data.longitude : null,
      asn: data.connection && data.connection.asn ? String(data.connection.asn) : '',
      org: data.connection && data.connection.org ? String(data.connection.org) : '',
      isp: data.connection && data.connection.isp ? String(data.connection.isp) : '',
      domain: data.connection && data.connection.domain ? String(data.connection.domain) : '',
      net_type: data.connection && data.connection.type ? String(data.connection.type) : '',
      fetched_at: Date.now(),
    };
    cache[key] = geo;
    saveGeoCache(cache);
    return geo;
  } catch (_) {
    return null;
  }
}

async function loadNetwork() {
  const [peers, banned] = await Promise.all([
    api('/api/peers'),
    api('/api/peers/banned'),
  ]);

  document.getElementById('network-peer-count').textContent = peers.count;
  const peerList = document.getElementById('network-peers');
  var connectedRecords = normalizePeerEntries(peers.peers);
  if (connectedRecords.length > 0) {
    peerList.innerHTML = connectedRecords.map(function (p) {
      var firstAddr = p.addrs && p.addrs.length ? p.addrs[0] : '';
      return '<div class="peer-row peer-row-link" data-peer-id="' + escapeHtml(p.peer_id) + '">' +
        '<div class="mono">' + escapeHtml(p.peer_id) + '</div>' +
        (firstAddr ? '<div class="d mono">' + escapeHtml(firstAddr) + '</div>' : '') +
      '</div>';
    }).join('');
    peerList.querySelectorAll('.peer-row-link[data-peer-id]').forEach(function (row) {
      row.addEventListener('click', function () { showPeerDetail(row.dataset.peerId); });
    });
  } else {
    peerList.innerHTML = '<div class="empty">No peers connected</div>';
  }

  document.getElementById('network-banned-count').textContent = banned.count;
  const bannedList = document.getElementById('network-banned');
  var bannedRecords = normalizePeerEntries(banned.banned);
  if (bannedRecords.length > 0) {
    bannedList.innerHTML = bannedRecords.map(function (b) {
      var firstAddr = b.addrs && b.addrs.length ? b.addrs[0] : '';
      return '<div class="peer-row banned">' +
        '<span class="detail-link mono" data-peer-id="' + escapeHtml(b.peer_id) + '">' + escapeHtml(b.peer_id.substring(0, 24)) + '...</span>' +
        '<span class="d">' + escapeHtml((b.reason || 'banned') + (firstAddr ? ' ; ' + firstAddr : '')) + '</span>' +
      '</div>';
    }).join('');
    bannedList.querySelectorAll('[data-peer-id]').forEach(function (el) {
      el.addEventListener('click', function () { showPeerDetail(el.dataset.peerId); });
    });
  } else {
    bannedList.innerHTML = '<div class="empty">No banned peers</div>';
  }
}

// --- Peer Detail ---

function getPeerObservationCache() {
  try {
    return JSON.parse(localStorage.getItem(walletKey('peerObservationCache')) || '{}');
  } catch (_) {
    return {};
  }
}

function savePeerObservationCache(cache) {
  localStorage.setItem(walletKey('peerObservationCache'), JSON.stringify(cache));
}

function formatAge(ms) {
  if (!ms) return '—';
  var diff = Math.max(0, Date.now() - ms);
  var s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  var d = Math.floor(h / 24);
  return d + 'd ago';
}

function formatRemaining(ms) {
  if (ms <= 0) return 'expired';
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400);
  s -= d * 86400;
  var h = Math.floor(s / 3600);
  s -= h * 3600;
  var m = Math.floor(s / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return Math.max(1, m) + 'm';
}

function classifyBanReason(reason) {
  var r = String(reason || '').toLowerCase();
  if (!r) return 'none';
  if (r.indexOf('invalid block') >= 0 || r.indexOf('bad block') >= 0) return 'invalid-block behavior';
  if (r.indexOf('invalid tx') >= 0 || r.indexOf('transaction') >= 0 || r.indexOf('double spend') >= 0) return 'invalid-transaction behavior';
  if (r.indexOf('excessive') >= 0 || r.indexOf('rate') >= 0 || r.indexOf('spam') >= 0 || r.indexOf('flood') >= 0) return 'rate/spam behavior';
  return 'policy/other';
}

function banSeverity(count) {
  var n = parseInt(count || 0, 10);
  if (n <= 0) return 'none';
  if (n >= 5) return 'high';
  if (n >= 3) return 'medium';
  return 'low';
}

function summarizePeerState(connected, bannedNow) {
  if (connected && bannedNow) return 'connected + banned (transitional)';
  if (connected) return 'connected';
  if (bannedNow) return 'blocked';
  return 'offline';
}

function refreshPeerAgeLabels(container) {
  if (!container) return;
  container.querySelectorAll('.peer-age[data-ts]').forEach(function (el) {
    var ts = parseInt(el.getAttribute('data-ts') || '0', 10);
    if (!ts) return;
    if (el.getAttribute('data-type') === 'remaining') {
      el.textContent = formatRemaining(ts - Date.now());
    } else {
      el.textContent = formatAge(ts);
    }
  });
}

function ensurePeerDetailLiveTimer() {
  if (peerDetailLiveTimer) return;
  peerDetailLiveTimer = setInterval(function () {
    if (currentView !== 'peer-detail') return;
    var container = document.getElementById('peer-detail-content');
    refreshPeerAgeLabels(container);
  }, 1000);
}

function updatePeerObservation(peerId, connectedNow, bannedNow) {
  var cache = getPeerObservationCache();
  var now = Date.now();
  var item = cache[peerId] || {
    first_seen_ms: now,
    reconnect_count: 0,
    state_change_count: 0,
    times_connected_seen: 0,
    times_banned_seen: 0,
    last_state: '',
  };
  var prevState = item.last_state || '';
  var nextState = summarizePeerState(connectedNow, bannedNow);

  if (prevState && prevState !== nextState) {
    item.state_change_count = (item.state_change_count || 0) + 1;
    if (connectedNow && prevState !== 'connected' && prevState !== 'connected + banned (transitional)') {
      item.reconnect_count = (item.reconnect_count || 0) + 1;
    }
    if (!connectedNow && (prevState === 'connected' || prevState === 'connected + banned (transitional)')) {
      item.last_disconnected_ms = now;
    }
  }

  if (connectedNow) {
    if (!item.connected_since_ms || prevState !== 'connected') item.connected_since_ms = now;
    item.last_seen_connected_ms = now;
    item.times_connected_seen = (item.times_connected_seen || 0) + 1;
  } else {
    item.connected_since_ms = null;
  }

  if (bannedNow) {
    item.last_seen_banned_ms = now;
    item.times_banned_seen = (item.times_banned_seen || 0) + 1;
  }

  item.last_seen_ms = now;
  item.last_state = nextState;
  cache[peerId] = item;
  savePeerObservationCache(cache);
  return item;
}

async function showPeerDetail(peerId) {
  peerDetailActiveId = peerId;
  ensurePeerDetailLiveTimer();
  navigate('peer-detail');
  var container = document.getElementById('peer-detail-content');
  if (!container) return;
  container.innerHTML = '<div class="d">Loading...</div>';

  try {
    var results = await Promise.all([
      api('/api/peers'),
      api('/api/peers/banned'),
    ]);
    var peers = results[0];
    var banned = results[1];

    var connectedRecords = normalizePeerEntries(peers.peers);
    var bannedRecords = normalizePeerEntries(banned.banned);
    var connectedPeers = connectedRecords.map(function (p) { return p.peer_id; });
    var bannedPeers = bannedRecords;
    var connectedEntry = connectedRecords.find(function (p) { return p.peer_id === peerId; }) || null;
    var connected = !!connectedEntry;
    var banEntry = bannedRecords.find(function (b) { return b.peer_id === peerId; }) || null;
    var addrList = connectedEntry && connectedEntry.addrs && connectedEntry.addrs.length
      ? connectedEntry.addrs
      : (banEntry && banEntry.addrs ? banEntry.addrs : []);
    var ipCandidates = addrList.map(extractIpFromMultiaddr).filter(Boolean);
    var publicIp = ipCandidates.find(isPublicIp) || '';
    var addressHint = summarizePeerAddressHints(addrList);
    var traits = inferMultiaddrTraits(addrList);
    var geo = null;
    if (publicIp && addressHint !== 'tor' && addressHint !== 'i2p' && addressHint !== 'relay') {
      geo = await geolocateIp(publicIp);
    }
    var hasPoint = !!(geo && typeof geo.lat === 'number' && typeof geo.lon === 'number');
    var mapLeft = hasPoint ? (((geo.lon + 180) / 360) * 100).toFixed(2) : '50.00';
    var mapTop = hasPoint ? (((90 - geo.lat) / 180) * 100).toFixed(2) : '50.00';
    var geoTitle = [geo && geo.city, geo && geo.region, geo && geo.country].filter(Boolean).join(', ');
    function isDisplayable(v) {
      if (v === null || v === undefined) return false;
      var s = String(v).trim().toLowerCase();
      if (!s) return false;
      if (s === 'unknown' || s === 'none' || s === '—') return false;
      return true;
    }
    function detailRow(label, value, mono) {
      return '<div class="detail-label">' + label + '</div><div class="detail-value' + (mono ? ' mono' : '') + '">' + escapeHtml(String(value)) + '</div>';
    }
    var geoRows = '';
    if (geo && hasPoint) {
      var countryRegion = [geo.country, geo.region].filter(Boolean).join(' / ');
      if (isDisplayable(publicIp)) geoRows += detailRow('IP source', publicIp, true);
      if (isDisplayable(addressHint)) geoRows += detailRow('Address hint', addressHint, false);
      if (isDisplayable(countryRegion)) geoRows += detailRow('Country / Region', countryRegion, false);
      if (isDisplayable(geo.country_code)) geoRows += detailRow('Country code', geo.country_code, false);
      if (isDisplayable(geo.continent)) geoRows += detailRow('Continent', geo.continent, false);
      if (isDisplayable(geo.city)) geoRows += detailRow('City', geo.city, false);
      if (isDisplayable(geo.timezone)) geoRows += detailRow('Timezone', geo.timezone, false);
      var asnOrg = [geo.asn, geo.org].filter(Boolean).join(' ');
      if (isDisplayable(asnOrg)) geoRows += detailRow('ASN / Org', asnOrg, false);
      if (isDisplayable(geo.net_type)) geoRows += detailRow('Network type', geo.net_type, false);
      var ispDomain = [geo.isp, geo.domain].filter(Boolean).join(' / ');
      if (isDisplayable(ispDomain)) geoRows += detailRow('ISP / Domain', ispDomain, false);
    }
    var geoSection = (geo && hasPoint && geoRows)
      ? '<h2>Geo</h2>' +
        '<div class="peer-panel peer-geo-panel">' +
          '<div class="peer-geo-map">' +
            '<img class="peer-geo-raster" src="icons/world.svg" alt="Peer location map" loading="lazy" />' +
            '<div class="peer-geo-dot" style="left:' + mapLeft + '%;top:' + mapTop + '%;"></div>' +
            (isDisplayable(geoTitle) ? '<div class="peer-geo-label mono">' + escapeHtml(geoTitle) + '</div>' : '') +
          '</div>' +
          '<div class="detail-grid">' + geoRows + '</div>' +
        '</div>'
      : '';
    var stateSummary = summarizePeerState(connected, !!banEntry);
    var sharePct = connectedPeers.length > 0 ? (100 / connectedPeers.length) : 0;
    var reasonCategory = classifyBanReason(banEntry && banEntry.reason);
    var severity = banSeverity(banEntry && banEntry.ban_count);
    var expiresAtMs = banEntry && banEntry.expires_at ? Date.parse(banEntry.expires_at) : NaN;
    var unbanIn = banEntry
      ? (banEntry.permanent ? 'never (permanent)' : (isNaN(expiresAtMs) ? 'unknown' : formatRemaining(expiresAtMs - Date.now())))
      : '—';
    var observation = updatePeerObservation(peerId, connected, !!banEntry);
    var statusHtml = connected
      ? '<span class="g">Connected</span>'
      : '<span class="d">Not currently connected</span>';
    var banStateHtml = banEntry
      ? '<span class="r">Banned</span>'
      : '<span class="d">Not banned</span>';

    var connectedRows = connectedPeers.length
      ? connectedPeers.map(function (id) {
          var rowClass = id === peerId ? ' peer-row-link-selected' : '';
          var rec = connectedRecords.find(function (p) { return p.peer_id === id; }) || { addrs: [] };
          var firstAddr = rec.addrs && rec.addrs.length ? rec.addrs[0] : '';
          return '<div class="peer-row peer-row-link' + rowClass + '" data-peer-id-link="' + escapeHtml(id) + '">' +
            '<div class="mono">' + escapeHtml(id) + '</div>' +
            (firstAddr ? '<div class="d mono">' + escapeHtml(firstAddr) + '</div>' : '') +
          '</div>';
        }).join('')
      : '<div class="empty">No peers connected</div>';
    var bannedRows = bannedPeers.length
      ? bannedPeers.map(function (b) {
          return '<div class="peer-row banned">' +
            '<span class="mono">' + escapeHtml(String(b.peer_id || '')) + '</span>' +
            '<span class="d">' + escapeHtml(String(b.reason || 'banned')) + '</span>' +
          '</div>';
        }).join('')
      : '<div class="empty">No banned peers</div>';

    container.innerHTML =
      '<div class="peer-detail-head">' +
        '<div class="peer-detail-status">' + statusHtml + ' <span class="d">•</span> ' + banStateHtml + '</div>' +
      '</div>' +
      geoSection +
      '<div class="detail-grid">' +
        '<div class="detail-label">Peer ID</div>' +
        '<div class="detail-value mono">' + copyable(peerId) + '</div>' +
        '<div class="detail-label">Connected now</div>' +
        '<div class="detail-value">' + (connected ? 'yes' : 'no') + '</div>' +
        '<div class="detail-label">Banned now</div>' +
        '<div class="detail-value">' + (banEntry ? 'yes' : 'no') + '</div>' +
        '<div class="detail-label">Connected peer count</div>' +
        '<div class="detail-value">' + connectedPeers.length + '</div>' +
        '<div class="detail-label">Banned peer count</div>' +
        '<div class="detail-value">' + bannedPeers.length + '</div>' +
        (isDisplayable(addressHint) ? '<div class="detail-label">Address hints</div><div class="detail-value">' + escapeHtml(addressHint) + '</div>' : '') +
        '<div class="detail-label">Known addrs</div>' +
        '<div class="detail-value">' + (addrList.length ? String(addrList.length) : '0') + '</div>' +
        (isDisplayable(traits.ipFamily) ? '<div class="detail-label">IP family</div><div class="detail-value">' + escapeHtml(traits.ipFamily) + '</div>' : '') +
        (isDisplayable(traits.hostForms) ? '<div class="detail-label">Host forms</div><div class="detail-value">' + escapeHtml(traits.hostForms) + '</div>' : '') +
        (isDisplayable(traits.transports) ? '<div class="detail-label">Transports</div><div class="detail-value">' + escapeHtml(traits.transports) + '</div>' : '') +
        (isDisplayable(traits.tcpPorts) ? '<div class="detail-label">TCP ports</div><div class="detail-value mono">' + escapeHtml(traits.tcpPorts) + '</div>' : '') +
        (isDisplayable(traits.udpPorts) ? '<div class="detail-label">UDP ports</div><div class="detail-value mono">' + escapeHtml(traits.udpPorts) + '</div>' : '') +
        (isDisplayable(traits.overlays) ? '<div class="detail-label">Overlay routes</div><div class="detail-value">' + escapeHtml(traits.overlays) + '</div>' : '') +
        (isDisplayable(traits.scopeMix) ? '<div class="detail-label">Scope mix</div><div class="detail-value">' + escapeHtml(traits.scopeMix) + '</div>' : '') +
        (addrList.length ? '<div class="detail-label">Routability snapshot</div><div class="detail-value">' + traits.publicCount + ' public / ' + traits.privateLikeCount + ' private-like of ' + traits.total + ' addrs</div>' : '') +
        '<div class="detail-label">State summary</div>' +
        '<div class="detail-value">' + escapeHtml(stateSummary) + '</div>' +
        '<div class="detail-label">Network share</div>' +
        '<div class="detail-value">' + (connected ? sharePct.toFixed(1) + '% of this node\'s current peer set' : 'not in this node\'s current peer set') + '</div>' +
        '<div class="detail-label">Observed first seen</div>' +
        '<div class="detail-value"><span class="peer-age" data-ts="' + String(observation.first_seen_ms || 0) + '">' + escapeHtml(formatAge(observation.first_seen_ms)) + '</span></div>' +
        '<div class="detail-label">Observed last connected</div>' +
        '<div class="detail-value"><span class="peer-age" data-ts="' + String(observation.last_seen_connected_ms || 0) + '">' + escapeHtml(formatAge(observation.last_seen_connected_ms)) + '</span></div>' +
        '<div class="detail-label">Reconnects (session)</div>' +
        '<div class="detail-value">' + String(observation.reconnect_count || 0) + '</div>' +
        '<div class="detail-label">State changes (session)</div>' +
        '<div class="detail-value">' + String(observation.state_change_count || 0) + '</div>' +
      '</div>' +
      (banEntry
        ? '<h2>Ban Details</h2>' +
          '<div class="detail-grid">' +
            '<div class="detail-label">Reason</div>' +
            '<div class="detail-value">' + escapeHtml(String(banEntry.reason || 'banned')) + '</div>' +
            (isDisplayable(reasonCategory) ? '<div class="detail-label">Reason category</div><div class="detail-value">' + escapeHtml(reasonCategory) + '</div>' : '') +
            '<div class="detail-label">Ban count</div>' +
            '<div class="detail-value">' + String(banEntry.ban_count || 0) + '</div>' +
            (isDisplayable(severity) ? '<div class="detail-label">Ban severity</div><div class="detail-value">' + escapeHtml(severity) + '</div>' : '') +
            '<div class="detail-label">Permanent</div>' +
            '<div class="detail-value">' + (banEntry.permanent ? 'yes' : 'no') + '</div>' +
            (banEntry.expires_at ? '<div class="detail-label">Expires at</div><div class="detail-value mono">' + escapeHtml(String(banEntry.expires_at)) + '</div>' : '') +
            (banEntry && !banEntry.permanent && !isNaN(expiresAtMs)
              ? '<div class="detail-label">Time to unban</div><div class="detail-value"><span class="peer-age" data-type="remaining" data-ts="' + String(expiresAtMs) + '">' + escapeHtml(unbanIn) + '</span></div>'
              : '') +
          '</div>'
        : '') +
      (addrList.length
        ? '<h2>Multiaddrs</h2>' +
          '<div class="peer-panel">' + addrList.map(function (a) {
            return '<div class="peer-row mono">' + escapeHtml(a) + '</div>';
          }).join('') + '</div>'
        : '') +
      '<h2>Observations</h2>' +
      '<div class="peer-panel">' +
        '<div class="peer-observation-row">Peer is currently <span class="' + (connected ? 'g' : 'd') + '">' + escapeHtml(stateSummary) + '</span> in this node\'s current peer set.</div>' +
        '<div class="peer-observation-row">Seen connected <span class="mono">' + String(observation.times_connected_seen || 0) + '</span> snapshot(s) and banned <span class="mono">' + String(observation.times_banned_seen || 0) + '</span> snapshot(s) this session.</div>' +
        '<div class="peer-observation-row">Connection state has changed <span class="mono">' + String(observation.state_change_count || 0) + '</span> time(s) in this session view.</div>' +
      '</div>' +
      '<h2>Connected Peers Snapshot</h2>' +
      '<div class="peer-panel">' + connectedRows + '</div>' +
      '<h2>Banned Peers Snapshot</h2>' +
      '<div class="peer-panel">' + bannedRows + '</div>';

    container.querySelectorAll('[data-peer-id-link]').forEach(function (el) {
      el.addEventListener('click', function () { showPeerDetail(el.dataset.peerIdLink); });
    });
    refreshPeerAgeLabels(container);
    wireCopyable(container);
  } catch (e) {
    container.innerHTML = '<div class="status-message error">' + escapeHtml(normalizeError(e)) + '</div>';
  }
}

// --- Address Book ---

function getAddressBook() {
  try {
    return JSON.parse(localStorage.getItem(walletKey('addressBook')) || '[]');
  } catch (_) {
    return [];
  }
}

function saveAddressBook(book) {
  localStorage.setItem(walletKey('addressBook'), JSON.stringify(book));
}

function renderAddressBook() {
  var list = document.getElementById('address-book-list');
  if (!list) return;
  var book = getAddressBook();
  if (book.length === 0) {
    list.innerHTML = '<div class="empty">No saved contacts</div>';
    return;
  }
  list.innerHTML = book.map(function (entry, i) {
    return '<div class="address-book-row" data-idx="' + i + '">' +
      '<div class="ab-info">' +
        '<span class="ab-name">' + escapeHtml(entry.name) + '</span>' +
        '<span class="ab-addr d">' + (isHandlePrefix(entry.address.charAt(0)) ? escapeHtml(entry.address) : entry.address.substring(0, 24) + '...') + '</span>' +
      '</div>' +
      '<div class="ab-actions">' +
        '<button class="ab-use-btn" data-idx="' + i + '">Use</button>' +
        '<button class="ab-edit-btn" data-idx="' + i + '">Edit</button>' +
        '<button class="ab-del-btn" data-idx="' + i + '">Del</button>' +
      '</div>' +
    '</div>';
  }).join('');

  list.querySelectorAll('.ab-use-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var entry = getAddressBook()[parseInt(btn.dataset.idx)];
      if (entry) {
        document.getElementById('send-address').value = entry.address;
        hideAddressSuggestions();
        debouncedResolve();
      }
    });
  });

  list.querySelectorAll('.ab-edit-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = parseInt(btn.dataset.idx);
      var row = btn.closest('.address-book-row');
      if (!row) return;
      var book = getAddressBook();
      var entry = book[idx];
      if (!entry) return;
      var info = row.querySelector('.ab-info');
      var actions = row.querySelector('.ab-actions');
      info.innerHTML = '<input type="text" class="ab-edit-input" value="' + escapeHtml(entry.name) + '">';
      actions.innerHTML =
        '<button class="ab-save-btn">Save</button>' +
        '<button class="ab-cancel-btn">Cancel</button>';
      var input = info.querySelector('.ab-edit-input');
      input.focus();
      input.select();
      function commitEdit() {
        var val = input.value.trim();
        if (val) {
          var fresh = getAddressBook();
          if (fresh[idx]) {
            fresh[idx].name = val;
            saveAddressBook(fresh);
          }
        }
        renderAddressBook();
      }
      actions.querySelector('.ab-save-btn').addEventListener('click', commitEdit);
      actions.querySelector('.ab-cancel-btn').addEventListener('click', function () { renderAddressBook(); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') commitEdit();
        if (ev.key === 'Escape') renderAddressBook();
      });
    });
  });

  list.querySelectorAll('.ab-del-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var idx = parseInt(btn.dataset.idx);
      var book = getAddressBook();
      book.splice(idx, 1);
      saveAddressBook(book);
      renderAddressBook();
    });
  });
}

function handleSaveContact() {
  var address = document.getElementById('send-address').value.trim();
  if (!address) {
    showSendStatus('Enter an address first', 'error');
    return;
  }
  var saveBtn = document.getElementById('save-contact-btn');
  var nameInput = document.getElementById('save-contact-name');

  // If the inline name input isn't showing yet, show it
  if (!nameInput) {
    var wrapper = document.createElement('div');
    wrapper.className = 'save-contact-inline';
    wrapper.innerHTML =
      '<input type="text" id="save-contact-name" class="ab-edit-input" placeholder="Contact name">' +
      '<button type="button" class="ab-save-btn" id="save-contact-confirm">Save</button>' +
      '<button type="button" class="ab-cancel-btn" id="save-contact-cancel">Cancel</button>';
    saveBtn.parentNode.insertBefore(wrapper, saveBtn.nextSibling);
    saveBtn.style.display = 'none';
    var inp = document.getElementById('save-contact-name');
    inp.focus();
    document.getElementById('save-contact-confirm').addEventListener('click', function () { commitSaveContact(); });
    document.getElementById('save-contact-cancel').addEventListener('click', function () { dismissSaveContactInline(); });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') commitSaveContact();
      if (ev.key === 'Escape') dismissSaveContactInline();
    });
    return;
  }
}

function commitSaveContact() {
  var address = document.getElementById('send-address').value.trim();
  var inp = document.getElementById('save-contact-name');
  if (!inp) return;
  var name = inp.value.trim();
  if (!name) {
    inp.focus();
    return;
  }
  var book = getAddressBook();
  var existing = book.findIndex(function (e) { return e.address === address; });
  if (existing >= 0) {
    book[existing].name = name;
  } else {
    book.push({ name: name, address: address });
  }
  saveAddressBook(book);
  dismissSaveContactInline();
  renderAddressBook();
  showSendStatus('Contact saved', 'success');
}

function dismissSaveContactInline() {
  var wrapper = document.querySelector('.save-contact-inline');
  if (wrapper) wrapper.remove();
  var saveBtn = document.getElementById('save-contact-btn');
  if (saveBtn) saveBtn.style.display = '';
}

function showAddressSuggestions(row) {
  row = row || getFirstRecipientRow();
  if (!row) return;
  var input = getRowAddressInput(row);
  var container = getRowSuggestionsEl(row);
  if (!input || !container) return;
  var query = (input.value || '').trim().toLowerCase();
  var book = getAddressBook();

  if (!query || book.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  var searchQuery = (query.length > 1 && isHandlePrefix(query.charAt(0))) ? query.slice(1) : query;
  var matches = book.filter(function (e) {
    return e.name.toLowerCase().indexOf(searchQuery) >= 0 || e.address.toLowerCase().indexOf(searchQuery) >= 0;
  });

  if (matches.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = matches.map(function (e) {
    return '<div class="address-suggestion" data-address="' + e.address + '">' +
      '<span class="as-name">' + escapeHtml(e.name) + '</span>' +
      '<span class="as-addr d">' + (isHandlePrefix(e.address.charAt(0)) ? escapeHtml(e.address) : e.address.substring(0, 20) + '...') + '</span>' +
    '</div>';
  }).join('');

  container.querySelectorAll('.address-suggestion').forEach(function (el) {
    el.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      input.value = el.dataset.address;
      hideAddressSuggestions(row);
      debouncedResolve(row);
      updateSendTotal();
    });
  });
}

function hideAddressSuggestions(row) {
  row = row || getFirstRecipientRow();
  if (!row) return;
  var container = getRowSuggestionsEl(row);
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function copyable(text, display) {
  return '<span class="sv-copyable" data-copy="' + escapeHtml(text) + '">' + (display || escapeHtml(text)) + '</span>';
}

function wireCopyable(container) {
  (container || document).querySelectorAll('.sv-copyable[data-copy]').forEach(function (el) {
    if (el.dataset.copyWired) return;
    el.dataset.copyWired = '1';
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(el.dataset.copy);
      el.classList.add('copied');
      setTimeout(function () { el.classList.remove('copied'); }, 1500);
    });
  });
}

function hexToUtf8(hex) {
  if (!hex) return '';
  try {
    var bytes = new Uint8Array(hex.match(/.{1,2}/g).map(function (b) { return parseInt(b, 16); }));
    return new TextDecoder().decode(bytes);
  } catch (_) { return ''; }
}

function memoHtml(o) {
  if (!o.memo_hex) return '';
  var text = hexToUtf8(o.memo_hex);
  if (!text) return '';
  return '<div class="history-memo">' + escapeHtml(text) + '</div>';
}

// --- Send ---

let blocknetIdPubKey = null;

async function getBlocknetIdPubKey() {
  if (blocknetIdPubKey) return blocknetIdPubKey;
  var raw = await invoke('fetch_url', { url: 'https://blocknet.id/.well-known/blocknet-id.json' });
  var data = JSON.parse(raw);
  if (!data.signing_pubkey) return null;
  blocknetIdPubKey = data.signing_pubkey;
  return blocknetIdPubKey;
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
}

async function verifyResolveSig(data) {
  try {
    var pubKeyB64 = await getBlocknetIdPubKey();
    if (!pubKeyB64 || !data.payload || !data.sig) return false;
    var msg = new TextEncoder().encode(data.payload);
    var sig = b64ToBytes(data.sig);
    var pubBytes = b64ToBytes(pubKeyB64);
    if (sig.length !== 64 || pubBytes.length !== 32) return false;
    var key = await crypto.subtle.importKey('raw', pubBytes, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sig, msg);
  } catch (_) {
    return false;
  }
}

async function resolveHandle(handle) {
  var raw = await invoke('fetch_url', { url: 'https://blocknet.id/api/v1/resolve/' + encodeURIComponent(handle) });
  var data = JSON.parse(raw);
  if (!data.address) throw new Error('No address for handle');
  data.verified = await verifyResolveSig(data);
  return data;
}

function isHandlePrefix(ch) { return ch === '$' || ch === '@'; }

function abbrAddr(addr) {
  if (!addr || addr.length < 12) return addr;
  return addr.substring(0, 4) + '...' + addr.substring(addr.length - 4);
}

function showResolved(row, prefix, handle, address, verified, updatedAt) {
  row = row || getFirstRecipientRow();
  if (!row) return;
  var el = getRowResolvedEl(row);
  if (!el) return;
  var parts = '';
  if (verified) {
    parts += ' <span class="resolve-ok">✓ verified</span>';
  } else {
    parts += ' <span class="resolve-fail">✗ unverified</span>';
  }
  if (updatedAt) {
    var ageSec = Math.floor(Date.now() / 1000) - updatedAt;
    if (ageSec < 86400) {
      parts += ' <span class="resolve-new-24h">⚠ changed ' + humanAge(ageSec) + ' ago</span>';
    } else if (ageSec < 604800) {
      parts += ' <span class="resolve-new-7d">changed ' + humanAge(ageSec) + ' ago</span>';
    }
  }
  el.innerHTML = '<span class="g">' + prefix + escapeHtml(handle) + '</span> → ' +
    copyable(address, escapeHtml(abbrAddr(address))) + parts;
  el.style.display = 'block';
  wireCopyable(el);
}

function humanAge(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
}

function hideResolved(row) {
  row = row || getFirstRecipientRow();
  if (!row) return;
  row._resolved = null;
  var el = getRowResolvedEl(row);
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

function debouncedResolve(row) {
  row = row || getFirstRecipientRow();
  if (!row) return;
  if (row._resolveTimer) clearTimeout(row._resolveTimer);
  var addrInput = getRowAddressInput(row);
  if (!addrInput) return;
  var val = (addrInput.value || '').trim();
  if (!val || !isHandlePrefix(val.charAt(0)) || val.length < 2) {
    hideResolved(row);
    return;
  }
  row._resolveTimer = setTimeout(function () {
    var current = (addrInput.value || '').trim();
    if (current !== val) return;
    var prefix = val.charAt(0);
    var handle = val.slice(1);
    if (row._resolved && row._resolved.handle === handle) return;
    var el = getRowResolvedEl(row);
    if (el) {
      el.textContent = 'Resolving ' + prefix + handle + '...';
      el.style.display = 'block';
    }
    resolveHandle(handle).then(function (data) {
      if ((addrInput.value || '').trim() !== val) return;
      row._resolved = { handle: handle, address: data.address, verified: data.verified, updatedAt: data.updated_at };
      showResolved(row, prefix, handle, data.address, data.verified, data.updated_at);
    }).catch(function () {
      if ((addrInput.value || '').trim() !== val) return;
      hideResolved(row);
    });
  }, 2000);
}

// --- Recipient row helpers (multi-recipient send) ---

function getRecipientRows() {
  var container = document.getElementById('send-recipients');
  if (!container) return [];
  return Array.prototype.slice.call(container.querySelectorAll('.recipient-row'));
}

function getFirstRecipientRow() {
  var container = document.getElementById('send-recipients');
  return container ? container.querySelector('.recipient-row') : null;
}

function getRowAddressInput(row) { return row ? row.querySelector('[data-role="address"]') : null; }
function getRowAmountInput(row) { return row ? row.querySelector('[data-role="amount"]') : null; }
function getRowMemoInput(row) { return row ? row.querySelector('[data-role="memo"]') : null; }
function getRowSuggestionsEl(row) { return row ? row.querySelector('[data-role="suggestions"]') : null; }
function getRowResolvedEl(row) { return row ? row.querySelector('[data-role="resolved"]') : null; }

function createRecipientRow() {
  var row = document.createElement('div');
  row.className = 'recipient-row extra-recipient';
  row.innerHTML =
    '<div class="recipient-row-header">' +
      '<span class="recipient-row-label"></span>' +
      '<button type="button" class="recipient-remove-btn">Remove</button>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Recipient</label>' +
      '<input type="text" data-role="address" placeholder="Address, $handle, or @handle" autocorrect="off" autocapitalize="off" spellcheck="false">' +
      '<div class="address-suggestions" data-role="suggestions"></div>' +
      '<div class="send-resolved" data-role="resolved" style="display: none;"></div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Amount (BNT)</label>' +
      '<input type="number" data-role="amount" step="0.00000001" min="0" placeholder="0.00">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Memo <span class="d">(optional, max 124 bytes)</span></label>' +
      '<input type="text" data-role="memo" placeholder="" maxlength="124" autocorrect="off" autocapitalize="off" spellcheck="false">' +
    '</div>';
  return row;
}

function addRecipientRow() {
  var container = document.getElementById('send-recipients');
  if (!container) return null;
  var row = createRecipientRow();
  container.appendChild(row);
  wireRecipientRow(row);
  renumberRecipientRows();
  updateSendTotal();
  var addrInput = getRowAddressInput(row);
  if (addrInput) addrInput.focus();
  return row;
}

function removeRecipientRow(row) {
  if (!row) return;
  var rows = getRecipientRows();
  if (rows.length <= 1) return;
  if (row._resolveTimer) { clearTimeout(row._resolveTimer); row._resolveTimer = null; }
  row.parentNode.removeChild(row);
  renumberRecipientRows();
  updateSendTotal();
}

function renumberRecipientRows() {
  var rows = getRecipientRows();
  rows.forEach(function (row, idx) {
    row.setAttribute('data-recipient-index', String(idx));
    var header = row.querySelector('.recipient-row-header');
    if (header) header.style.display = rows.length > 1 ? '' : 'none';
    var label = row.querySelector('.recipient-row-label');
    if (label) label.textContent = 'Recipient #' + (idx + 1);
    var removeBtn = row.querySelector('.recipient-remove-btn');
    if (removeBtn) removeBtn.style.display = rows.length > 1 ? '' : 'none';
  });
}

function updateSendTotal() {
  var rows = getRecipientRows();
  var total = 0;
  rows.forEach(function (row) {
    var amountInput = getRowAmountInput(row);
    if (!amountInput) return;
    var v = parseFloat(amountInput.value);
    if (!isNaN(v) && v > 0) total += v;
  });
  var totalEl = document.getElementById('send-total');
  var totalValEl = document.getElementById('send-total-value');
  if (!totalEl || !totalValEl) return;
  if (rows.length <= 1) {
    totalEl.style.display = 'none';
  } else {
    totalEl.style.display = '';
    totalValEl.textContent = formatBNT(Math.round(total * 100000000)) + ' BNT';
  }
}

function resetSendForm() {
  var rows = getRecipientRows();
  rows.forEach(function (row, idx) {
    if (idx === 0) {
      var addr = getRowAddressInput(row);
      var amount = getRowAmountInput(row);
      var memo = getRowMemoInput(row);
      if (addr) addr.value = '';
      if (amount) amount.value = '';
      if (memo) memo.value = '';
      hideResolved(row);
      hideAddressSuggestions(row);
    } else {
      if (row._resolveTimer) { clearTimeout(row._resolveTimer); row._resolveTimer = null; }
      row.parentNode.removeChild(row);
    }
  });
  renumberRecipientRows();
  updateSendTotal();
}

function wireRecipientRow(row) {
  if (!row) return;
  var addr = getRowAddressInput(row);
  var amount = getRowAmountInput(row);
  if (addr) {
    addr.addEventListener('input', function () { showAddressSuggestions(row); debouncedResolve(row); });
    addr.addEventListener('paste', function (ev) {
      var cd = ev.clipboardData || window.clipboardData;
      var text = cd && typeof cd.getData === 'function' ? cd.getData('text') : '';
      if (applyPaymentRequestToRow(row, text, false)) ev.preventDefault();
    });
    addr.addEventListener('focus', function () { showAddressSuggestions(row); });
    addr.addEventListener('blur', function () { setTimeout(function () { hideAddressSuggestions(row); }, 150); });
  }
  if (amount) {
    amount.addEventListener('input', updateSendTotal);
  }
  var removeBtn = row.querySelector('.recipient-remove-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', function () { removeRecipientRow(row); });
  }
}

function applyPaymentRequestToRow(row, raw, silent) {
  row = row || getFirstRecipientRow();
  var parsed = parsePaymentRequestUri(raw);
  if (!parsed || !row) return false;
  var addrEl = getRowAddressInput(row);
  var amountEl = getRowAmountInput(row);
  var memoEl = getRowMemoInput(row);
  if (!addrEl || !amountEl || !memoEl) return false;

  addrEl.value = parsed.address;
  if (parsed.amount) amountEl.value = parsed.amount;
  if (parsed.memo) memoEl.value = parsed.memo;
  hideAddressSuggestions(row);
  if (isHandlePrefix(parsed.address.charAt(0))) debouncedResolve(row);
  else hideResolved(row);
  updateSendTotal();
  if (!silent) showSendStatus('Pre-filled from payment link. Review and confirm.', 'info');
  return true;
}

async function handleSend(e) {
  e.preventDefault();
  const btn = document.getElementById('send-submit');
  const rows = getRecipientRows();
  if (!rows.length) {
    showSendStatus('Add at least one recipient', 'error');
    return;
  }

  // Phase 1: validate each row (and parse payment-link paste on row 0)
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var addrInput = getRowAddressInput(row);
    var amountInput = getRowAmountInput(row);
    var memoInput = getRowMemoInput(row);
    if (!addrInput || !amountInput || !memoInput) continue;
    var rawAddress = (addrInput.value || '').trim();
    if (i === 0) {
      var parsedLink = parsePaymentRequestUri(rawAddress);
      if (parsedLink) {
        applyPaymentRequestToRow(row, rawAddress, true);
        rawAddress = parsedLink.address;
      }
    }
    var labelPrefix = rows.length > 1 ? ('Recipient #' + (i + 1) + ': ') : '';
    if (!rawAddress) {
      showSendStatus(labelPrefix + 'enter an address or $handle', 'error');
      return;
    }
    var amountBNT = parseFloat(amountInput.value);
    if (!amountBNT || amountBNT <= 0) {
      showSendStatus(labelPrefix + 'enter a valid amount', 'error');
      return;
    }
    entries.push({
      row: row,
      index: i,
      rawAddress: rawAddress,
      amountBNT: amountBNT,
      memo: (memoInput.value || '').trim(),
      labelPrefix: labelPrefix,
    });
  }

  // Phase 2: resolve handles for each row
  btn.disabled = true;
  var resolvingAny = entries.some(function (e) { return isHandlePrefix(e.rawAddress.charAt(0)); });
  if (resolvingAny) btn.textContent = 'Resolving...';
  try {
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      var prefix = entry.rawAddress.charAt(0);
      if (isHandlePrefix(prefix)) {
        var handle = entry.rawAddress.slice(1);
        if (!handle) {
          showSendStatus(entry.labelPrefix + 'enter a handle after ' + prefix, 'error');
          return;
        }
        var existing = entry.row._resolved;
        if (!existing || existing.handle !== handle) {
          showSendStatus('Resolving ' + prefix + handle + '...', 'info');
          try {
            var resolved = await resolveHandle(handle);
            entry.row._resolved = { handle: handle, address: resolved.address, verified: resolved.verified, updatedAt: resolved.updated_at };
            showResolved(entry.row, prefix, handle, resolved.address, resolved.verified, resolved.updated_at);
          } catch (err) {
            hideResolved(entry.row);
            showSendStatus(entry.labelPrefix + 'could not resolve ' + prefix + handle + ': ' + normalizeError(err), 'error');
            return;
          }
        }
        entry.address = entry.row._resolved.address;
        entry.displayRecipient = prefix + handle;
      } else {
        hideResolved(entry.row);
        entry.address = entry.rawAddress;
        entry.displayRecipient = entry.rawAddress.substring(0, 16) + '...';
      }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = sendArmed ? 'Confirm Send' : 'Send';
  }

  // Phase 3: arm then confirm
  if (!sendArmed) {
    sendArmed = true;
    if (sendArmTimer) clearTimeout(sendArmTimer);
    sendArmTimer = setTimeout(() => {
      sendArmed = false;
      sendArmTimer = null;
      btn.textContent = 'Send';
      btn.classList.remove('armed');
      document.getElementById('send-status').style.display = 'none';
    }, 10000);
    btn.textContent = 'Confirm Send';
    btn.classList.add('armed');
    var totalBNT = entries.reduce(function (s, e) { return s + e.amountBNT; }, 0);
    var confirmMsg;
    if (entries.length === 1) {
      confirmMsg = 'Send ' + entries[0].amountBNT + ' BNT to ' + entries[0].displayRecipient + '?';
      if (entries[0].memo) confirmMsg += '  Memo: "' + entries[0].memo + '"';
    } else {
      confirmMsg = 'Send ' + formatBNT(Math.round(totalBNT * 100000000)) + ' BNT total to ' + entries.length + ' recipients?';
    }
    confirmMsg += '  Press again within 10s to confirm.';
    showSendStatus(confirmMsg, 'info');
    return;
  }

  sendArmed = false;
  if (sendArmTimer) { clearTimeout(sendArmTimer); sendArmTimer = null; }
  btn.classList.remove('armed');

  var recipientsPayload = entries.map(function (e) {
    var r = { address: e.address, amount: Math.round(e.amountBNT * 100000000) };
    if (e.memo) r.memo_text = e.memo;
    return r;
  });
  const sendPayload = { recipients: recipientsPayload };
  const payloadKey = JSON.stringify(sendPayload);
  const now = Date.now();
  let idempotencyKey = null;
  if (
    pendingSendIdempotency &&
    pendingSendIdempotency.payloadKey === payloadKey &&
    (now - pendingSendIdempotency.createdAt) < SEND_IDEMPOTENCY_WINDOW_MS
  ) {
    idempotencyKey = pendingSendIdempotency.key;
  } else {
    idempotencyKey = (
      (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : ('send-' + now + '-' + Math.random().toString(16).slice(2))
    );
    pendingSendIdempotency = {
      payloadKey: payloadKey,
      key: idempotencyKey,
      createdAt: now,
    };
  }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  showSendStatus('Building transaction...', 'info');

  try {
    const result = await api('/api/wallet/send', {
      method: 'POST',
      body: sendPayload,
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    });
    var totalAtomic = recipientsPayload.reduce(function (s, r) { return s + r.amount; }, 0);
    var firstRecipient = (result.recipients && result.recipients[0]) || {};
    showSendStatus('Sent! TX: ' + result.txid.substring(0, 24) + '... Fee: ' + formatBNT(result.fee) + ' BNT', 'success');
    addPendingSend(result.txid, totalAtomic + result.fee, firstRecipient.memo_hex);
    entries.forEach(function (ent) {
      if (ent.row._resolved && ent.row._resolved.handle) {
        var book = getAddressBook();
        var h = ent.row._resolved.handle;
        var handleAddr = '$' + h;
        var idx = book.findIndex(function (e) { return e.name.toLowerCase() === h.toLowerCase(); });
        if (idx < 0) {
          book.push({ name: h, address: handleAddr });
          saveAddressBook(book);
          renderAddressBook();
        }
      }
    });
    pendingSendIdempotency = null;
    resetSendForm();
    dashForceRefresh = true;
  } catch (e) {
    const msg = normalizeError(e);
    showSendStatus(msg, 'error');
    if (!msg.toLowerCase().includes('request failed:')) {
      pendingSendIdempotency = null;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

function showSendStatus(msg, type) {
  const el = document.getElementById('send-status');
  el.textContent = msg || 'Request failed';
  el.className = 'status-message ' + type;
  el.style.display = 'block';
}

// --- Wallet Management ---

async function loadWalletList() {
  var wallets = await invoke('list_wallets');
  var active = await invoke('get_active_wallet');
  setActiveWalletName(active);
  var activeEl = document.getElementById('wallet-active-display');
  var listEl = document.getElementById('wallet-list');

  var walletPath = '';
  try { walletPath = await invoke('get_wallet_path_cmd'); } catch (_) {}

  activeEl.innerHTML =
    '<span class="wallet-active-label">Active</span>' +
    '<span class="wallet-active-name">' + escapeHtml(active.replace(/\.dat$/, '')) + '</span>' +
    (walletPath ? '<span class="wallet-active-path d">' + escapeHtml(walletPath) + '</span>' : '');

  listEl.innerHTML = wallets.map(function (name) {
    var isActive = name === active;
    var display = name.replace(/\.dat$/, '');
    return '<div class="wallet-row' + (isActive ? ' active' : '') + '" data-name="' + escapeHtml(name) + '">' +
      '<span class="wallet-row-name">' + escapeHtml(display) + '</span>' +
      '<div class="wallet-row-actions">' +
        (isActive ? '<span class="wallet-row-badge">current</span>' : '') +
        '<button class="wallet-edit-btn" data-name="' + escapeHtml(name) + '">Rename</button>' +
        (isActive
          ? ''
          : '<button class="wallet-del-btn" data-name="' + escapeHtml(name) + '">Del</button>' +
            '<button class="wallet-switch-btn" data-name="' + escapeHtml(name) + '">Switch</button>') +
      '</div>' +
    '</div>';
  }).join('');

  listEl.querySelectorAll('.wallet-switch-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { handleSwitchWallet(btn.dataset.name); });
  });
  listEl.querySelectorAll('.wallet-edit-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { startWalletRename(btn.dataset.name); });
  });
  listEl.querySelectorAll('.wallet-del-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { handleDeleteWallet(btn.dataset.name); });
  });
}

async function handleSwitchWallet(name) {
  showSettingsStatus('Switching wallet...', 'info');
  try {
    stopPolling();
    await invoke('switch_wallet', { name: name });
    setActiveWalletName(name);
    sessionPassword = '';
    dashLastHeight = -1;
    dashLastTxCount = -1;
    // Clear stale DOM so old wallet data doesn't flash on next load
    var recentEl = document.getElementById('dash-recent-tx');
    if (recentEl) recentEl.innerHTML = '';
    var histEl = document.getElementById('history-list');
    if (histEl) histEl.innerHTML = '';
    showUnlockScreen();
    showStatus('Switched to ' + name.replace(/\.dat$/, '') + '. Enter password to unlock.', 'info');
  } catch (e) {
    showSettingsStatus(normalizeError(e), 'error');
  }
}

function startWalletRename(name) {
  var row = document.querySelector('.wallet-row[data-name="' + name + '"]');
  if (!row) return;
  var display = name.replace(/\.dat$/, '');
  var nameEl = row.querySelector('.wallet-row-name');
  var actionsEl = row.querySelector('.wallet-row-actions');

  nameEl.innerHTML = '<input type="text" class="ab-edit-input wallet-rename-input" value="' + escapeHtml(display) + '">';
  actionsEl.innerHTML =
    '<button class="ab-save-btn">Save</button>' +
    '<button class="ab-cancel-btn">Cancel</button>';

  var input = nameEl.querySelector('input');
  input.focus();
  input.select();

  function commitRename() {
    var val = input.value.trim();
    if (!val) { loadWalletList(); return; }
    var newName = val.endsWith('.dat') ? val : val + '.dat';
    if (newName === name) { loadWalletList(); return; }
    invoke('rename_wallet', { oldName: name, newName: newName })
      .then(function () { loadWalletList(); })
      .catch(function (e) { showSettingsStatus(normalizeError(e), 'error'); loadWalletList(); });
  }

  actionsEl.querySelector('.ab-save-btn').addEventListener('click', commitRename);
  actionsEl.querySelector('.ab-cancel-btn').addEventListener('click', function () { loadWalletList(); });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') commitRename();
    if (ev.key === 'Escape') loadWalletList();
  });
}

function handleDeleteWallet(name) {
  var row = document.querySelector('.wallet-row[data-name="' + name + '"]');
  if (!row) return;
  var actionsEl = row.querySelector('.wallet-row-actions');
  var display = name.replace(/\.dat$/, '');

  // Replace actions with confirm/cancel
  actionsEl.innerHTML =
    '<span class="wallet-del-confirm-label">Delete ' + escapeHtml(display) + '?</span>' +
    '<button class="ab-del-btn wallet-del-yes">Yes</button>' +
    '<button class="ab-cancel-btn">No</button>';

  actionsEl.querySelector('.wallet-del-yes').addEventListener('click', function () {
    invoke('delete_wallet', { name: name })
      .then(function () { loadWalletList(); })
      .catch(function (e) { showSettingsStatus(normalizeError(e), 'error'); loadWalletList(); });
  });
  actionsEl.querySelector('.ab-cancel-btn').addEventListener('click', function () { loadWalletList(); });
}

async function handleImportWalletFile() {
  var btn = document.getElementById('import-file-btn');
  btn.disabled = true;
  btn.textContent = 'Selecting...';
  try {
    var filename = await invoke('import_wallet_file');
    showSettingsStatus('Loaded ' + filename.replace(/\.dat$/, ''), 'success');
    await loadWalletList();
  } catch (e) {
    var msg = normalizeError(e);
    if (msg !== 'No file selected' && msg !== 'Dialog cancelled') {
      showSettingsStatus(msg, 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load from File';
  }
}

function showImportForm() {
  document.getElementById('import-seed-form').style.display = 'block';
  document.getElementById('import-seed-btn').style.display = 'none';
  document.getElementById('import-seed-input').value = '';
  document.getElementById('import-seed-password').value = '';
  document.getElementById('import-seed-filename').value = '';
  document.getElementById('import-seed-status').style.display = 'none';
  document.getElementById('import-seed-input').focus();
}

function hideImportForm() {
  document.getElementById('import-seed-form').style.display = 'none';
  document.getElementById('import-seed-btn').style.display = '';
}

function showImportStatus(msg, type) {
  var el = document.getElementById('import-seed-status');
  el.textContent = msg;
  el.className = 'status-message ' + type;
  el.style.display = 'block';
}

async function handleImportSeed() {
  var mnemonic = document.getElementById('import-seed-input').value.trim();
  var password = document.getElementById('import-seed-password').value;
  var filename = document.getElementById('import-seed-filename').value.trim();
  var btn = document.getElementById('import-seed-submit');

  if (!mnemonic) {
    showImportStatus('Enter your 12-word recovery phrase', 'error');
    return;
  }
  var words = mnemonic.split(/\s+/);
  if (words.length !== 12) {
    showImportStatus('Recovery phrase must be exactly 12 words', 'error');
    return;
  }
  if (password.length < 3) {
    showImportStatus('Password must be at least 3 characters', 'error');
    return;
  }
  if (filename && !filename.endsWith('.dat')) {
    filename = filename + '.dat';
  }

  btn.disabled = true;
  btn.textContent = 'Importing...';
  showImportStatus('Stopping daemon...', 'info');

  try {
    // Need a fresh daemon with no wallet loaded
    stopPolling();
    await invoke('stop_daemon');
    await new Promise(function (r) { setTimeout(r, 500); });

    showImportStatus('Starting daemon...', 'info');
    await ensureDaemonReady();

    showImportStatus('Importing wallet from seed... this can take a while on larger chains.', 'info');
    var body = { mnemonic: words.join(' '), password: password };
    if (filename) body.filename = filename;
    var result = await api('/api/wallet/import', { method: 'POST', body: body });

    // Update active wallet to the imported file
    var importedName = result.filename || filename || 'wallet.dat';
    await invoke('switch_wallet', { name: importedName });

    // Restart daemon pointed at new wallet
    await invoke('stop_daemon');
    await new Promise(function (r) { setTimeout(r, 500); });
    await ensureDaemonReady();
    await loadOrUnlockWallet(password);
    sessionPassword = password;

    hideImportForm();
    showSettingsStatus('Wallet imported. Scanning blockchain for your outputs...', 'success');
    await loadWalletList();
    showApp();
  } catch (e) {
    showImportStatus(normalizeError(e), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}


async function handlePasswordScreenImportSubmit() {
  var mnemonic = document.getElementById('ps-import-seed').value.trim();
  var password = document.getElementById('ps-import-password').value;
  var filename = document.getElementById('ps-import-filename').value.trim();
  var btn = document.getElementById('ps-import-submit');
  var statusEl = document.getElementById('ps-import-status');

  function showPsStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status-message ' + type;
    statusEl.style.display = 'block';
  }

  if (!mnemonic) { showPsStatus('Enter your 12-word recovery phrase', 'error'); return; }
  var words = mnemonic.split(/\s+/);
  if (words.length !== 12) { showPsStatus('Recovery phrase must be exactly 12 words', 'error'); return; }
  if (password.length < 3) { showPsStatus('Password must be at least 3 characters', 'error'); return; }
  if (filename && !filename.endsWith('.dat')) filename = filename + '.dat';

  btn.disabled = true;
  btn.textContent = 'Importing...';
  showPsStatus('Preparing daemon...', 'info');

  try {
    await ensureDaemonReady();

    showPsStatus('Importing wallet from seed... this can take a while on larger chains.', 'info');
    var body = { mnemonic: words.join(' '), password: password };
    if (filename) body.filename = filename;
    var result = await api('/api/wallet/import', { method: 'POST', body: body });

    var importedName = result.filename || filename || 'wallet.dat';
    // Persist the imported wallet as active so next launch prompts for this wallet.
    try {
      await invoke('switch_wallet', { name: importedName });
    } catch (_) {}

    // The daemon already loaded this wallet via import; continue into app.
    sessionPassword = password;
    showApp();
  } catch (e) {
    var msg = normalizeError(e);
    // Recovery path: if prior import already created the file, try loading it now.
    if (msg.toLowerCase().includes('wallet file already exists')) {
      try {
        showPsStatus('Wallet file exists; attempting to load it now...', 'info');
        await loadOrUnlockWallet(password);
        sessionPassword = password;
        showApp();
        return;
      } catch (loadErr) {
        showPsStatus(normalizeError(loadErr), 'error');
      }
    } else {
      showPsStatus(msg, 'error');
    }
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}

// --- Settings ---

async function handleLockWallet() {
  var lockFailed = false;
  try {
    await api('/api/wallet/lock', { method: 'POST' });
  } catch (e) {
    console.error('Lock API error (UI locked anyway):', e);
    lockFailed = true;
  }
  // Always lock the UI regardless of API success
  playLock();
  sessionPassword = '';
  showUnlockScreen();
  if (lockFailed) {
    showStatus('Wallet UI locked. Warning: daemon lock may have failed — restart app if concerned.', 'warning');
  } else {
    showStatus('Wallet locked. Enter password to unlock.', 'info');
  }
}

async function handleViewSeed() {
  const globalSettingsStatus = document.getElementById('settings-status');
  if (globalSettingsStatus) globalSettingsStatus.style.display = 'none';
  const seedDisplayEl = document.getElementById('seed-display');
  const seedStatusEl = document.getElementById('seed-status');

  // If seed is already shown, clicking again hides it.
  if (seedDisplayEl && seedDisplayEl.style.display !== 'none') {
    seedDisplayEl.style.display = 'none';
    if (seedStatusEl) seedStatusEl.style.display = 'none';
    viewSeedArmed = false;
    if (viewSeedArmTimer) {
      clearTimeout(viewSeedArmTimer);
      viewSeedArmTimer = null;
    }
    return;
  }

  if (!viewSeedArmed) {
    viewSeedArmed = true;
    if (viewSeedArmTimer) clearTimeout(viewSeedArmTimer);
    viewSeedArmTimer = setTimeout(() => {
      viewSeedArmed = false;
      viewSeedArmTimer = null;
      document.getElementById('seed-status').style.display = 'none';
    }, 10000);
    showSeedStatus('Click "View Recovery Seed" again within 10s to confirm.', 'info');
    return;
  }
  
  viewSeedArmed = false;
  if (viewSeedArmTimer) {
    clearTimeout(viewSeedArmTimer);
    viewSeedArmTimer = null;
  }
  document.getElementById('seed-status').style.display = 'none';

  if (!sessionPassword) {
    showSeedStatus('No session password. Lock and re-unlock wallet first.', 'error');
    return;
  }

  try {
    showSeedStatus('Loading seed...', 'info');
    const data = await api('/api/wallet/seed', {
      method: 'POST',
      body: { password: sessionPassword },
    });
    document.getElementById('seed-status').style.display = 'none';
    const el = document.getElementById('seed-display');
    el.textContent = data.mnemonic;
    el.style.display = 'block';
    showSeedStatus('Recovery seed displayed. Keep this safe!', 'success');
  } catch (e) {
    document.getElementById('seed-display').style.display = 'none';
    showSeedStatus(normalizeError(e), 'error');
  }
}

async function handleResetChainData() {
  let confirmed = false;
  try {
    if (typeof window.confirm === 'function') {
      confirmed = window.confirm('Reset blockchain data and resync from height 0? Wallet file is kept.');
    }
  } catch (_) {
    // Some WebView environments disable blocking dialogs.
  }

  // Fallback confirmation flow if browser dialogs are unavailable.
  if (!confirmed) {
    if (!resetChainArmed) {
      resetChainArmed = true;
      if (resetChainArmTimer) clearTimeout(resetChainArmTimer);
      resetChainArmTimer = setTimeout(() => {
        resetChainArmed = false;
        resetChainArmTimer = null;
      }, 10000);
      showSettingsStatus('Click "Reset Blockchain Data" again within 10s to confirm.', 'info');
      return;
    }
    resetChainArmed = false;
    if (resetChainArmTimer) {
      clearTimeout(resetChainArmTimer);
      resetChainArmTimer = null;
    }
    confirmed = true;
  }
  if (!confirmed) return;

  try {
    showSettingsStatus('Resetting blockchain data...', 'info');
    document.getElementById('dash-height').textContent = '--';
    document.getElementById('dash-syncing').textContent = 'Resyncing';
    dashLastHeight = -1;
    dashLastTxCount = -1;
    await invoke('reset_blockchain_data');
    showSettingsStatus('Starting daemon...', 'info');
    await ensureDaemonReady();
    if (sessionPassword) {
      showSettingsStatus('Loading wallet...', 'info');
      await loadOrUnlockWallet(sessionPassword);
    }
    showSettingsStatus('Blockchain reset complete. Resync started from 0.', 'success');
    if (currentView === 'dashboard') {
      await loadDashboard();
    }
  } catch (e) {
    showSettingsStatus(normalizeError(e), 'error');
  }
}

function showSettingsStatus(msg, type) {
  const el = document.getElementById('settings-status');
  el.textContent = msg;
  el.className = 'status-message ' + type;
  el.style.display = 'block';
}

function showSeedStatus(msg, type) {
  const globalStatus = document.getElementById('settings-status');
  if (globalStatus) globalStatus.style.display = 'none';
  const el = document.getElementById('seed-status');
  el.textContent = msg;
  el.className = 'status-message ' + type;
  el.style.display = 'block';
}

// --- Polling ---

async function checkInboundTx() {
  try {
    var data = await api('/api/wallet/history');
    if (!data.outputs || data.outputs.length === 0) {
      dashLastTxCount = 0;
      return;
    }
    var inboundCount = data.outputs.filter(function (o) { return !o.spent; }).length;
    if (dashLastTxCount >= 0 && inboundCount > dashLastTxCount) {
      playTada();
    }
    dashLastTxCount = inboundCount;
  } catch (_) {}
}

async function handleRealtimeEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  var eventName = payload.event || '';
  if (eventName !== 'connected' && eventName !== 'new_block' && eventName !== 'mined_block') {
    return;
  }

  // Force next dashboard refresh to pull latest chain-linked wallet state.
  dashLastHeight = -1;

  try {
    if (currentView === 'dashboard') await loadDashboard();
    if (currentView === 'history') await loadHistory();
    if (currentView === 'mining') await loadMining();
    if (currentView === 'network') await loadNetwork();
    if (currentView !== 'dashboard') await checkInboundTx();
  } catch (_) {}
}

function startPolling() {
  stopPolling();

  // Start daemon SSE bridge in Rust.
  invoke('start_api_events').catch(function (e) {
    console.error('Failed to start api events:', e);
  });

  // Subscribe to bridged realtime API events.
  try {
    var eventApi = window.__TAURI__ && window.__TAURI__.event;
    if (eventApi && typeof eventApi.listen === 'function') {
      eventApi.listen('api-events', async function (evt) {
        await handleRealtimeEvent(evt && evt.payload ? evt.payload : null);
      }).then(function (unlisten) {
        realtimeUnlisten = unlisten;
      }).catch(function (e) {
        console.error('Failed to subscribe api events:', e);
      });
    }
  } catch (e) {
    console.error('Realtime subscribe error:', e);
  }

  // Keep only low-frequency refresh for non-chain realtime panels.
  pollInterval = setInterval(async function () {
    try {
      if (currentView === 'mining') await loadMining();
      if (currentView === 'network') await loadNetwork();
      if (currentView === 'peer-detail' && peerDetailActiveId) await showPeerDetail(peerDetailActiveId);
    } catch (_) {}
  }, 15000);
}

function stopPolling() {
  if (realtimeUnlisten) {
    try { realtimeUnlisten(); } catch (_) {}
    realtimeUnlisten = null;
  }

  invoke('stop_api_events').catch(function () {});

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// --- Screen transitions ---

function showPasswordScreen(newWallet) {
  isNewWallet = newWallet;
  const splash = document.getElementById('splash');
  const passwordScreen = document.getElementById('password-screen');
  const password2 = document.getElementById('password2');
  const subtitle = document.getElementById('password-subtitle');
  const form = document.getElementById('password-form');
  const choice = document.getElementById('onboard-choice');
  const backLink = document.getElementById('password-back-link');
  var psImport = document.getElementById('password-screen-import');
  if (psImport) psImport.remove();

  if (newWallet) {
    // Show the choice screen, hide the form
    subtitle.textContent = '';
    form.style.display = 'none';
    choice.style.display = 'flex';
    loadOnboardWalletList();
    if (backLink) backLink.style.display = 'none';
  } else {
    subtitle.textContent = 'Enter your wallet password';
    form.style.display = 'flex';
    password2.style.display = 'none';
    choice.style.display = 'none';
    if (backLink) backLink.style.display = 'none';
  }

  splash.classList.add('fade-out');
  passwordScreen.style.display = 'flex';
  setTimeout(() => splash.remove(), 1000);
}

function showOnboardCreate() {
  var choice = document.getElementById('onboard-choice');
  var form = document.getElementById('password-form');
  var subtitle = document.getElementById('password-subtitle');
  var password2 = document.getElementById('password2');
  var backLink = document.getElementById('password-back-link');
  var psImport = document.getElementById('password-screen-import');
  if (psImport) psImport.remove();

  isNewWallet = true;
  choice.style.display = 'none';
  subtitle.textContent = 'Create a password for your new wallet';
  password2.style.display = 'block';
  form.style.display = 'flex';
  if (backLink) backLink.style.display = '';
  document.getElementById('password1').focus();
}

function showOnboardImport() {
  var choice = document.getElementById('onboard-choice');
  var form = document.getElementById('password-form');
  var subtitle = document.getElementById('password-subtitle');
  var backLink = document.getElementById('password-back-link');

  choice.style.display = 'none';
  form.style.display = 'none';
  subtitle.textContent = 'Restore from recovery seed';
  if (backLink) backLink.style.display = '';
  hideStatus();

  // Build the inline import form if not already present
  var existing = document.getElementById('password-screen-import');
  if (existing) { existing.remove(); }

  var container = document.querySelector('.password-main');
  var div = document.createElement('div');
  div.id = 'password-screen-import';
  div.className = 'password-import-inline';
  div.innerHTML =
    '<textarea id="ps-import-seed" class="seed-input" rows="2" placeholder="12-word recovery phrase" spellcheck="false"></textarea>' +
    '<input type="password" id="ps-import-password" class="seed-pw-input" placeholder="Password for new wallet" autocomplete="new-password">' +
    '<input type="text" id="ps-import-filename" class="seed-pw-input" placeholder="Filename (optional, e.g. restored.dat)">' +
    '<button type="button" class="btn-primary" id="ps-import-submit" style="width:100%">Import</button>' +
    '<div id="ps-import-status" class="status-message" style="display:none"></div>';
  container.insertBefore(div, backLink);

  document.getElementById('ps-import-seed').focus();
  document.getElementById('ps-import-submit').addEventListener('click', handlePasswordScreenImportSubmit);
}

function showOnboardBack() {
  var psImport = document.getElementById('password-screen-import');
  if (psImport) psImport.remove();

  var form = document.getElementById('password-form');
  form.style.display = 'none';
  document.getElementById('password2').style.display = 'none';
  document.getElementById('password1').value = '';
  document.getElementById('password2').value = '';

  var choice = document.getElementById('onboard-choice');
  var subtitle = document.getElementById('password-subtitle');
  var backLink = document.getElementById('password-back-link');
  choice.style.display = 'flex';
  loadOnboardWalletList();
  subtitle.textContent = '';
  if (backLink) backLink.style.display = 'none';
  hideStatus();
}

function showUnlockScreen() {
  isNewWallet = false;
  stopPolling();
  invoke('set_tray_unlocked', { unlocked: false }).catch(function() {});

  const app = document.getElementById('app');
  const passwordScreen = document.getElementById('password-screen');
  const passwordTitle = document.getElementById('password-title');
  const subtitle = document.getElementById('password-subtitle');
  const password1 = document.getElementById('password1');
  const password2 = document.getElementById('password2');
  const submitBtn = document.getElementById('password-submit');
  const seedDisplay = document.getElementById('seed-display');
  const seedStatus = document.getElementById('seed-status');
  const settingsStatus = document.getElementById('settings-status');

  if (passwordTitle) passwordTitle.textContent = 'Welcome to Blocknet';
  if (subtitle) subtitle.textContent = 'Enter your wallet password';
  if (password1) password1.value = '';
  if (password2) {
    password2.value = '';
    password2.style.display = 'none';
  }
  var psImport = document.getElementById('password-screen-import');
  if (psImport) psImport.remove();
  var passwordForm = document.getElementById('password-form');
  if (passwordForm) passwordForm.style.display = 'flex';
  var choice = document.getElementById('onboard-choice');
  if (choice) choice.style.display = 'none';
  var backLink = document.getElementById('password-back-link');
  if (backLink) backLink.style.display = 'none';
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Continue';
  }
  if (seedDisplay) seedDisplay.style.display = 'none';
  if (seedStatus) seedStatus.style.display = 'none';
  if (settingsStatus) settingsStatus.style.display = 'none';

  hideStatus();
  if (app) app.style.display = 'none';
  if (passwordScreen) passwordScreen.style.display = 'flex';
}

async function showApp() {
  try { setActiveWalletName(await invoke('get_active_wallet')); } catch (_) {}
  migrateLocalStorageKeys();
  const passwordScreen = document.getElementById('password-screen');
  const app = document.getElementById('app');
  if (passwordScreen) passwordScreen.style.display = 'none';
  app.style.display = 'flex';
  navigate('dashboard');
  startPolling();
  playTada();
  invoke('set_tray_unlocked', { unlocked: true }).catch(function() {});
}

async function showAppFromSplash() {
  try { setActiveWalletName(await invoke('get_active_wallet')); } catch (_) {}
  migrateLocalStorageKeys();
  const splash = document.getElementById('splash');
  const app = document.getElementById('app');
  splash.classList.add('fade-out');
  app.style.display = 'flex';
  setTimeout(() => splash.remove(), 1000);
  navigate('dashboard');
  startPolling();
  invoke('set_tray_unlocked', { unlocked: true }).catch(function() {});
  if (pendingDeepLink) {
    applyPendingDeepLink();
    return;
  }
  await pullCurrentDeepLinkWithRetries(24, 500);
}

function showStatus(message, type) {
  const el = document.getElementById('password-status');
  el.textContent = message;
  el.className = 'status-message ' + type;
  el.style.display = 'block';
}

function hideStatus() {
  document.getElementById('password-status').style.display = 'none';
}

async function loadOnboardWalletList() {
  var listEl = document.getElementById('onboard-wallet-list');
  if (!listEl) return;

  try {
    var wallets = await invoke('list_wallets');
    var active = '';
    try { active = await invoke('get_active_wallet'); } catch (_) {}

    if (!wallets || wallets.length === 0) {
      listEl.innerHTML = '<div class="onboard-wallet-empty">No wallet files found yet.</div>';
      return;
    }

    var ordered = wallets.slice().sort(function (a, b) {
      if (a === active) return -1;
      if (b === active) return 1;
      return a.localeCompare(b);
    });

    listEl.innerHTML = ordered.map(function (name) {
      var display = name.replace(/\.dat$/i, '');
      var activeClass = name === active ? ' active' : '';
      return '<button type="button" class="onboard-wallet-row' + activeClass + '" data-wallet="' + escapeHtml(name) + '">' +
        '<span class="onboard-wallet-bullet">&#8226;</span>' +
        '<span>' + escapeHtml(display) + '.dat</span>' +
      '</button>';
    }).join('');

    listEl.querySelectorAll('.onboard-wallet-row').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var selected = btn.getAttribute('data-wallet');
        if (!selected) return;
        try {
          await invoke('switch_wallet', { name: selected });
          setActiveWalletName(selected);
          isNewWallet = false;
          var choice = document.getElementById('onboard-choice');
          var form = document.getElementById('password-form');
          var subtitle = document.getElementById('password-subtitle');
          var password2 = document.getElementById('password2');
          var backLink = document.getElementById('password-back-link');
          var psImport = document.getElementById('password-screen-import');
          if (psImport) psImport.remove();
          if (choice) choice.style.display = 'none';
          if (form) form.style.display = 'flex';
          if (subtitle) subtitle.textContent = 'Enter your wallet password';
          if (password2) password2.style.display = 'none';
          if (backLink) backLink.style.display = 'none';
          showStatus('Selected ' + selected.replace(/\.dat$/i, '') + '. Enter password to unlock.', 'info');
          document.getElementById('password1').focus();
        } catch (e) {
          showStatus(normalizeError(e), 'error');
        }
      });
    });
  } catch (_) {
    listEl.innerHTML = '<div class="onboard-wallet-empty">Unable to load wallet list.</div>';
  }
}

// --- Password form ---

async function handlePasswordSubmit(e) {
  e.preventDefault();

  const password1 = document.getElementById('password1').value;
  const password2val = document.getElementById('password2').value;
  const submitBtn = document.getElementById('password-submit');

  hideStatus();

  if (isNewWallet) {
    if (password1.length < 3) {
      showStatus('Password must be at least 3 characters', 'error');
      return;
    }
    if (password1 !== password2val) {
      showStatus('Passwords do not match', 'error');
      return;
    }
  } else {
    if (password1.length === 0) {
      showStatus('Please enter your password', 'error');
      return;
    }
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Please wait...';

  try {
    const daemonReady = await invoke('check_daemon_ready');
    if (!daemonReady) {
      showStatus('Preparing daemon...', 'info');
      await ensureDaemonReady();
    }

    showStatus('Loading wallet...', 'info');
    await loadOrUnlockWallet(password1);
    sessionPassword = password1;
    showApp();

  } catch (error) {
    console.error('Error:', error);
    if (String(error || '').includes('SECURITY_BLOCKED')) {
      showSecurityBlockedModal();
      return;
    }
    const msg = normalizeError(error).toLowerCase();
    if (msg.includes('incorrect password') || msg.includes('wrong password') || msg.includes('decrypt') || msg.includes('cipher')) {
      showStatus('Check your password and try again', 'error');
    } else if (msg.includes('wallet already loaded')) {
      showStatus('Wallet is already loaded', 'error');
    } else if (msg.includes('api port 8332 is already in use')) {
      showStatus('API port 8332 is already in use. Stop other blocknet daemons and try again.', 'error');
    } else {
      showStatus(normalizeError(error), 'error');
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Continue';
  }
}

async function waitForDaemon() {
  const maxAttempts = 150;
  let attempts = 0;
  while (attempts < maxAttempts) {
    const ready = await invoke('check_daemon_ready');
    if (ready) return;
    await new Promise(r => setTimeout(r, 200));
    attempts++;
  }
  throw new Error('Daemon failed to start within timeout');
}

async function ensureDaemonReady() {
  const alreadyReady = await invoke('check_daemon_ready');
  if (alreadyReady) return;

  if (!daemonStartPromise) {
    daemonStartPromise = (async () => {
      await invoke('start_daemon');
      await waitForDaemon();
    })().finally(() => {
      daemonStartPromise = null;
    });
  }

  await daemonStartPromise;
}

function showSecurityBlockedModal() {
  var existing = document.getElementById('security-blocked-overlay');
  if (existing) existing.remove();

  var ua = navigator.userAgent || navigator.platform || '';
  var isMac = /Mac/i.test(ua);
  var isWin = /Win/i.test(ua);
  var instructions = '';

  if (isMac) {
    instructions =
      '<p>macOS is blocking the blocknet daemon from running because it hasn\'t been verified by Apple.</p>' +
      '<h3>To fix this:</h3>' +
      '<ol>' +
        '<li>Open <strong>System Settings</strong></li>' +
        '<li>Go to <strong>Privacy & Security</strong></li>' +
        '<li>Scroll down ; you\'ll see a message about "blocknet" being blocked</li>' +
        '<li>Click <strong>Allow Anyway</strong></li>' +
        '<li>Come back here and click <strong>Try Again</strong></li>' +
      '</ol>';
  } else if (isWin) {
    instructions =
      '<p>Windows SmartScreen is blocking the blocknet daemon from running.</p>' +
      '<h3>To fix this:</h3>' +
      '<ol>' +
        '<li>When the SmartScreen popup appears, click <strong>More info</strong></li>' +
        '<li>Then click <strong>Run anyway</strong></li>' +
        '<li>If no popup appeared, find the blocknet binary in the app folder, right-click it and select <strong>Properties</strong></li>' +
        '<li>Check the <strong>Unblock</strong> checkbox at the bottom and click <strong>OK</strong></li>' +
        '<li>Come back here and click <strong>Try Again</strong></li>' +
      '</ol>';
  } else {
    instructions =
      '<p>Your operating system is preventing the blocknet daemon from running.</p>' +
      '<h3>To fix this:</h3>' +
      '<ol>' +
        '<li>Open a terminal</li>' +
        '<li>Run <code>chmod +x</code> on the blocknet daemon binary inside the app\'s resource directory</li>' +
        '<li>Come back here and click <strong>Try Again</strong></li>' +
      '</ol>';
  }

  var overlay = document.createElement('div');
  overlay.id = 'security-blocked-overlay';
  overlay.className = 'security-blocked-overlay';
  overlay.innerHTML =
    '<div class="security-blocked-modal">' +
      '<div class="security-blocked-icon">&#9888;</div>' +
      '<h2>Security Permission Required</h2>' +
      instructions +
      '<button class="btn-primary" id="security-blocked-retry">Try Again</button>' +
    '</div>';
  document.body.appendChild(overlay);

  document.getElementById('security-blocked-retry').addEventListener('click', function() {
    overlay.remove();
    location.reload();
  });
}

// --- Init ---

async function init() {
  try {
    if (!window.__TAURI__ || !window.__TAURI__.core) {
      throw new Error('Tauri API not available');
    }

    // Check if daemon is already running
    const daemonReady = await invoke('check_daemon_ready');
    if (!daemonReady) {
      // Pre-start daemon in the background while splash/password is shown.
      ensureDaemonReady().catch(e => {
        if (String(e || '').includes('SECURITY_BLOCKED')) {
          showSecurityBlockedModal();
          return;
        }
        console.error('Daemon pre-start error:', e);
      });
    }

    playIntro();
    await new Promise(r => setTimeout(r, 1000));

    if (daemonReady) {
      try {
        // If wallet is already loaded/unlocked, go straight to app.
        await api('/api/wallet/balance');
        showAppFromSplash();
      } catch (_) {
        // Daemon is running but no wallet loaded (or locked): ask for password flow.
        const exists = await invoke('wallet_exists');
        showPasswordScreen(!exists);
      }
      return;
    }

    // Check if wallet exists
    const exists = await invoke('wallet_exists');
    showPasswordScreen(!exists);

  } catch (error) {
    console.error('Init error:', error);
    const splash = document.getElementById('splash');
    if (splash) {
      splash.innerHTML = '<div style="color: #000; padding: 20px; text-align: center; font-family: monospace;">' +
        '<h1>Error</h1><p>' + error.toString() + '</p></div>';
    }
  }
}

// --- TX Detail ---

async function showTxDetail(txid) {
  navigate('tx-detail');
  var container = document.getElementById('tx-detail-content');
  container.innerHTML = '<div class="d">Loading...</div>';
  try {
    var data = await api('/api/tx/' + txid);
    var tx = data.tx;
    var status = data.in_mempool
      ? '<span class="g">In mempool</span>'
      : '<span class="d">' + data.confirmations + ' confirmation' + (data.confirmations !== 1 ? 's' : '') + '</span>';
    var blockLink = data.block_height
      ? '<a class="detail-link" data-block="' + data.block_height + '">Block ' + data.block_height + '</a>'
      : 'Pending';

    container.innerHTML =
      '<div class="detail-grid">' +
        '<div class="detail-label">TX Hash</div>' +
        '<div class="detail-value mono">' + copyable(txid) + '</div>' +
        '<div class="detail-label">Status</div>' +
        '<div class="detail-value">' + status + '</div>' +
        '<div class="detail-label">Block</div>' +
        '<div class="detail-value">' + blockLink + '</div>' +
        '<div class="detail-label">Fee</div>' +
        '<div class="detail-value">' + formatBNT(tx.fee) + ' BNT</div>' +
        '<div class="detail-label">Inputs</div>' +
        '<div class="detail-value">' + (tx.inputs ? tx.inputs.length : 0) + '</div>' +
        '<div class="detail-label">Outputs</div>' +
        '<div class="detail-value">' + (tx.outputs ? tx.outputs.length : 0) + '</div>' +
      '</div>' +
      '<div class="detail-actions">' +
        '<button class="btn-secondary" id="tx-open-explorer">Open in Explorer</button>' +
      '</div>';

    document.getElementById('tx-open-explorer').addEventListener('click', function () {
      window.__TAURI__.shell.open('https://explorer.blocknetcrypto.com/tx/' + txid);
    });
    wireCopyable(container);

    container.querySelectorAll('[data-block]').forEach(function (el) {
      el.addEventListener('click', function () { showBlockDetail(el.dataset.block); });
    });
  } catch (e) {
    container.innerHTML = '<div class="status-message error">' + escapeHtml(normalizeError(e)) + '</div>';
  }
}

// --- Block Detail ---

async function showBlockDetail(id) {
  navigate('block-detail');
  var container = document.getElementById('block-detail-content');
  container.innerHTML = '<div class="d">Loading...</div>';
  try {
    var block = await api('/api/block/' + id);
    var time = new Date(block.timestamp * 1000);
    var timeStr = time.toLocaleString();

    var txRows = '';
    if (block.transactions && block.transactions.length) {
      txRows = block.transactions.map(function (t) {
        var label = t.is_coinbase ? '<span class="g">coinbase</span>' : (t.fee ? formatBNT(t.fee) + ' BNT fee' : '');
        return '<div class="block-tx-row">' +
          '<a class="detail-link mono" data-txid="' + escapeHtml(t.hash) + '">' + t.hash.substring(0, 24) + '...</a>' +
          '<span class="d">' + t.inputs + ' in / ' + t.outputs + ' out</span>' +
          '<span class="d">' + label + '</span>' +
        '</div>';
      }).join('');
    }

    container.innerHTML =
      '<div class="detail-grid">' +
        '<div class="detail-label">Height</div>' +
        '<div class="detail-value">' + block.height + '</div>' +
        '<div class="detail-label">Hash</div>' +
        '<div class="detail-value mono">' + copyable(block.hash) + '</div>' +
        '<div class="detail-label">Previous</div>' +
        '<div class="detail-value">' + (block.height > 0
          ? '<a class="detail-link mono" data-block="' + (block.height - 1) + '">' + escapeHtml(block.prev_hash) + '</a>'
          : '<span class="mono d">Genesis</span>') + '</div>' +
        '<div class="detail-label">Time</div>' +
        '<div class="detail-value">' + escapeHtml(timeStr) + '</div>' +
        '<div class="detail-label">Confirmations</div>' +
        '<div class="detail-value">' + block.confirmations + '</div>' +
        '<div class="detail-label">Reward</div>' +
        '<div class="detail-value g">' + formatBNT(block.reward) + ' BNT</div>' +
        '<div class="detail-label">Difficulty</div>' +
        '<div class="detail-value">' + block.difficulty.toLocaleString() + '</div>' +
        '<div class="detail-label">Nonce</div>' +
        '<div class="detail-value">' + block.nonce.toLocaleString() + '</div>' +
        '<div class="detail-label">Merkle Root</div>' +
        '<div class="detail-value mono">' + copyable(block.merkle_root) + '</div>' +
      '</div>' +
      '<h2>Transactions (' + block.tx_count + ')</h2>' +
      '<div class="block-tx-list">' + txRows + '</div>';

    wireCopyable(container);
    container.querySelectorAll('[data-txid]').forEach(function (el) {
      el.addEventListener('click', function () { showTxDetail(el.dataset.txid); });
    });
    container.querySelectorAll('[data-block]').forEach(function (el) {
      el.addEventListener('click', function () { showBlockDetail(el.dataset.block); });
    });
  } catch (e) {
    container.innerHTML = '<div class="status-message error">' + escapeHtml(normalizeError(e)) + '</div>';
  }
}

// --- Sign / Verify ---

function initSignVerifyTabs() {
  document.querySelectorAll('.sv-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.sv-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.dataset.tab;
      document.getElementById('sv-sign').style.display = target === 'sign' ? '' : 'none';
      document.getElementById('sv-verify').style.display = target === 'verify' ? '' : 'none';
      document.getElementById('sign-result').style.display = 'none';
      document.getElementById('verify-result').style.display = 'none';
    });
  });
}

async function handleSign() {
  var btn = document.getElementById('sign-btn');
  var message = document.getElementById('sign-message').value;
  var resultEl = document.getElementById('sign-result');
  if (!message) {
    resultEl.innerHTML = '<span class="r">Enter a message to sign</span>';
    resultEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  resultEl.innerHTML = '<span class="d">Signing...</span>';
  resultEl.style.display = 'block';
  try {
    var data = await api('/api/wallet/sign', { method: 'POST', body: { message: message } });
    resultEl.innerHTML =
      '<div class="detail-grid">' +
        '<div class="detail-label">Address</div>' +
        '<div class="detail-value mono">' + copyable(data.address) + '</div>' +
        '<div class="detail-label">Signature</div>' +
        '<div class="detail-value mono">' + copyable(data.signature) + '</div>' +
      '</div>';
    wireCopyable(resultEl);
  } catch (e) {
    resultEl.innerHTML = '<span class="r">' + escapeHtml(normalizeError(e)) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function handleVerify() {
  var btn = document.getElementById('verify-btn');
  var address = document.getElementById('verify-address').value.trim();
  var message = document.getElementById('verify-message').value;
  var signature = document.getElementById('verify-signature').value.trim();
  var resultEl = document.getElementById('verify-result');
  if (!address || !message || !signature) {
    resultEl.innerHTML = '<span class="r">All fields are required</span>';
    resultEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  resultEl.innerHTML = '<span class="d">Verifying...</span>';
  resultEl.style.display = 'block';
  try {
    var data = await api('/api/verify', {
      method: 'POST',
      body: { address: address, message: message, signature: signature }
    });
    if (data.valid) {
      resultEl.innerHTML = '<span class="resolve-ok">✓ Signature is valid</span>';
    } else {
      resultEl.innerHTML = '<span class="r">✗ Signature is invalid</span>';
    }
  } catch (e) {
    resultEl.innerHTML = '<span class="r">' + escapeHtml(normalizeError(e)) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

// --- Deep link handling ---

function normalizeDeepLinkUrl(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.url === 'string') return raw.url;
  if (raw && typeof raw.href === 'string') return raw.href;
  return '';
}

function parsePaymentRequestUri(raw) {
  var input = String(raw || '').trim();
  if (!input) return null;
  var address = '';
  var params = {};

  if (/^blocknet:(\/\/)?/i.test(input)) {
    var stripped = input.replace(/^blocknet:(\/\/)?/i, '');
    var qIdx = stripped.indexOf('?');
    address = qIdx >= 0 ? stripped.substring(0, qIdx) : stripped;
    if (qIdx >= 0) {
      stripped.substring(qIdx + 1).split('&').forEach(function (pair) {
        var eq = pair.indexOf('=');
        if (eq > 0) params[decodeURIComponent(pair.substring(0, eq))] = decodeURIComponent(pair.substring(eq + 1));
      });
    }
  } else {
    try {
      var u = new URL(input);
      var host = (u.hostname || '').toLowerCase();
      if (host === 'bntpay.com' || host === 'www.bntpay.com') {
        var seg = (u.pathname || '').replace(/^\/+/, '').split('/')[0] || '';
        address = decodeURIComponent(seg);
        u.searchParams.forEach(function (v, k) { params[k] = v; });
      } else {
        return null;
      }
    } catch (_) {
      return null;
    }
  }

  address = String(address || '').trim();
  if (!address) return null;
  return {
    address: address,
    amount: params.amount || '',
    memo: params.memo || '',
  };
}

function applyPaymentRequestToSend(raw, silent) {
  return applyPaymentRequestToRow(getFirstRecipientRow(), raw, silent);
}

function handleDeepLinkUrls(urls) {
  if (!urls) return;
  var first = Array.isArray(urls) ? urls[0] : urls;
  var raw = normalizeDeepLinkUrl(first).trim();
  if (!raw) return;
  var parsed = parsePaymentRequestUri(raw);
  if (!parsed) return;

  try {
    var win = window.__TAURI__.window.getCurrentWindow();
    win.show();
    win.setFocus();
  } catch (_) {}

  var app = document.getElementById('app');
  if (!app || app.style.display === 'none') {
    pendingDeepLink = { address: parsed.address, amount: parsed.amount || '', memo: parsed.memo || '' };
    return;
  }
  prefillSend(parsed.address, parsed.amount || '', parsed.memo || '');
}

function prefillSend(address, amount, memo) {
  navigate('send');
  if (address) document.getElementById('send-address').value = address;
  if (amount) document.getElementById('send-amount').value = amount;
  if (memo) document.getElementById('send-memo').value = memo;
  showSendStatus('Pre-filled from blocknet:// link. Review and confirm.', 'info');
  if (address) debouncedResolve();
}

function applyPendingDeepLink() {
  if (!pendingDeepLink) return;
  var dl = pendingDeepLink;
  pendingDeepLink = null;
  prefillSend(dl.address, dl.amount, dl.memo);
}

async function pullCurrentDeepLinkWithRetries(attempts, delayMs) {
  if (!window.__TAURI__ || !window.__TAURI__.core) return false;
  for (var i = 0; i < attempts; i++) {
    try {
      var urls = await window.__TAURI__.core.invoke('plugin:deep-link|get_current');
      if (urls && urls.length) {
        handleDeepLinkUrls(urls);
        return true;
      }
    } catch (_) {}
    if (i < attempts - 1) {
      await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
    }
  }
  return false;
}

(async function initDeepLink() {
  if (!window.__TAURI__ || !window.__TAURI__.event) return;
  try {
    await window.__TAURI__.event.listen('deep-link://new-url', function (event) {
      if (event.payload) handleDeepLinkUrls(event.payload);
    });
  } catch (_) {}
  await pullCurrentDeepLinkWithRetries(1, 0);
})();

// --- Wire up events ---

document.getElementById('password-form').addEventListener('submit', handlePasswordSubmit);
document.getElementById('send-form').addEventListener('submit', handleSend);
wireCopyable();
document.getElementById('qr-container').addEventListener('click', showQROverlay);
document.getElementById('qr-overlay').addEventListener('click', dismissQROverlay);
document.getElementById('request-generate-btn').addEventListener('click', generatePaymentLink);
document.getElementById('request-amount').addEventListener('input', clearPaymentLink);
document.getElementById('request-memo').addEventListener('input', clearPaymentLink);
document.getElementById('request-link-mode-blocknet').addEventListener('click', function () { setRequestLinkMode('blocknet'); });
document.getElementById('request-link-mode-bntpay').addEventListener('click', function () { setRequestLinkMode('bntpay'); });
document.getElementById('receive-shortname').addEventListener('input', debouncedVerifyReceiveShortname);
document.getElementById('receive-shortname-save').addEventListener('click', saveReceiveShortname);
document.getElementById('receive-shortname-clear').addEventListener('click', clearReceiveShortname);
document.getElementById('mining-toggle').addEventListener('click', toggleMining);
document.getElementById('threads-inc').addEventListener('click', function () { changeThreads(1); });
document.getElementById('threads-dec').addEventListener('click', function () { changeThreads(-1); });
document.getElementById('export-csv-btn').addEventListener('click', exportHistoryCSV);
document.getElementById('save-contact-btn').addEventListener('click', handleSaveContact);
(function () {
  var firstRow = getFirstRecipientRow();
  if (firstRow) wireRecipientRow(firstRow);
  renumberRecipientRows();
  var addBtn = document.getElementById('add-recipient-btn');
  if (addBtn) addBtn.addEventListener('click', function () { addRecipientRow(); });
})();
document.getElementById('lock-wallet-btn').addEventListener('click', handleLockWallet);
document.getElementById('view-seed-btn').addEventListener('click', handleViewSeed);
document.getElementById('reset-chain-btn').addEventListener('click', handleResetChainData);
document.getElementById('peer-detail-back').addEventListener('click', navigateBack);
document.getElementById('tx-detail-back').addEventListener('click', navigateBack);
document.getElementById('block-detail-back').addEventListener('click', navigateBack);
document.getElementById('sign-btn').addEventListener('click', handleSign);
document.getElementById('verify-btn').addEventListener('click', handleVerify);
initSignVerifyTabs();

// Sound controls
(function () {
  var slider = document.getElementById('sound-volume');
  var label = document.getElementById('sound-volume-label');
  var muteBtn = document.getElementById('sound-mute-btn');
  var muteIcon = document.getElementById('sound-mute-icon');

  loadSoundPrefs();
  slider.value = Math.round(soundVolume * 100);
  label.textContent = Math.round(soundVolume * 100) + '%';
  muteIcon.textContent = soundMuted ? '\u2716' : '\u266A';
  if (soundMuted) slider.classList.add('muted');

  slider.addEventListener('input', function () {
    soundVolume = parseInt(slider.value) / 100;
    label.textContent = slider.value + '%';
    if (soundMuted) {
      soundMuted = false;
      muteIcon.textContent = '\u266A';
      slider.classList.remove('muted');
    }
    applyVolume();
    saveSoundPrefs();
  });

  muteBtn.addEventListener('click', function () {
    soundMuted = !soundMuted;
    muteIcon.textContent = soundMuted ? '\u2716' : '\u266A';
    slider.classList.toggle('muted', soundMuted);
    applyVolume();
    saveSoundPrefs();
  });
})();
document.getElementById('import-seed-btn').addEventListener('click', showImportForm);
document.getElementById('import-seed-cancel').addEventListener('click', hideImportForm);
document.getElementById('import-seed-submit').addEventListener('click', handleImportSeed);
document.getElementById('import-file-btn').addEventListener('click', handleImportWalletFile);
document.getElementById('onboard-create').addEventListener('click', showOnboardCreate);
document.getElementById('onboard-import').addEventListener('click', showOnboardImport);
document.getElementById('password-back-link').addEventListener('click', showOnboardBack);

document.querySelectorAll('.nav-link').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

// --- Keyboard Shortcuts ---

var navKeys = ['dashboard', 'send', 'receive', 'history', 'mining', 'network', 'signverify', 'settings'];

document.addEventListener('keydown', function (e) {
  // Ignore when typing in inputs/textareas
  var tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  // Ignore if app is not visible (password/splash screen)
  var app = document.getElementById('app');
  if (!app || app.style.display === 'none') return;

  // CMD/CTRL+L to lock wallet
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    handleLockWallet();
    return;
  }

  // Escape: dismiss QR overlay only
  if (e.key === 'Escape') {
    var overlay = document.getElementById('qr-overlay');
    if (overlay && overlay.classList.contains('visible')) {
      dismissQROverlay();
    }
    return;
  }

  // 1-7 for nav pages
  var idx = parseInt(e.key) - 1;
  if (idx >= 0 && idx < navKeys.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
    navigate(navKeys[idx]);
  }
});

// --- Platform Detection & Custom Titlebar Controls ---
(function () {
  var isWindows = navigator.platform && navigator.platform.indexOf('Win') === 0;
  if (!isWindows) return;
  document.body.classList.add('platform-windows');
  var appWindow = window.__TAURI__.window.getCurrentWindow();
  document.getElementById('titlebar-minimize').addEventListener('click', function () { appWindow.minimize(); });
  document.getElementById('titlebar-maximize').addEventListener('click', function () { appWindow.toggleMaximize(); });
  document.getElementById('titlebar-close').addEventListener('click', function () { appWindow.close(); });
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
