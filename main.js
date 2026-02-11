let currentView = 'dashboard';
let pollInterval = null;
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
let dashLastHeight = -1;
let dashLastTxCount = -1;

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

function navigate(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById('view-' + view);
  const navEl = document.querySelector('[data-view="' + view + '"]');
  if (viewEl) viewEl.classList.add('active');
  if (navEl) navEl.classList.add('active');

  currentView = view;
  loadView(view);
}

async function loadView(view) {
  try {
    switch (view) {
      case 'dashboard': await loadDashboard(); break;
      case 'send': renderAddressBook(); break;
      case 'receive': await loadReceive(); break;
      case 'history': await loadHistory(); break;
      case 'mining': await loadMining(); break;
      case 'network': await loadNetwork(); break;
      case 'settings': await loadWalletList(); break;
    }
  } catch (e) {
    console.error('Error loading ' + view + ':', e);
  }
}

// --- Dashboard ---

async function loadDashboard() {
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

  // Only re-fetch history when chain height changes (avoid hammering API every poll tick)
  try {
    var statusHeight = parseInt(document.getElementById('dash-height').textContent.replace(/,/g, '')) || 0;
    if (statusHeight !== dashLastHeight) {
      dashLastHeight = statusHeight;
      var data = await api('/api/wallet/history');
      var container = document.getElementById('dash-recent-tx');
      var outputs = data.outputs && data.outputs.length > 0 ? data.outputs : null;
      var fromCache = false;
      if (outputs) {
        try { localStorage.setItem('txCache', JSON.stringify(outputs)); } catch (_) {}
      } else {
        try { outputs = JSON.parse(localStorage.getItem('txCache') || 'null'); fromCache = true; } catch (_) {}
      }
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

        var sorted = outputs.slice().sort(function (a, b) { return b.block_height - a.block_height; });
        var limit = window.innerHeight < 720 ? 3 : 5;
        var recent = sorted.slice(0, limit);
        container.innerHTML = recent.map(function (o) {
          var typeLabel = o.is_coinbase ? 'mining reward' : (o.spent ? 'sent' : 'received');
          return '<div class="recent-tx-row' + (o.spent ? ' spent' : '') + (fromCache ? ' cached' : '') + '">' +
            '<span class="recent-tx-amount ' + (o.spent ? '' : 'g') + '">' +
              (o.spent ? '-' : '+') + formatBNTShort(o.amount) + ' BNT' +
            '</span>' +
            '<span class="recent-tx-type ' + (o.spent ? 'd' : 'g') + '">' + typeLabel + '</span>' +
            '<span class="recent-tx-block d">Block ' + o.block_height + '</span>' +
          '</div>';
        }).join('');
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

async function loadReceive() {
  const data = await api('/api/wallet/address');
  document.getElementById('receive-address').textContent = data.address;

  if (typeof qrcode === 'function') {
    var svgHtml = renderQRSvg(data.address);
    document.getElementById('qr-container').innerHTML = svgHtml;
    document.getElementById('qr-overlay-inner').innerHTML = svgHtml;
  }
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

  var outputs = data.outputs && data.outputs.length > 0 ? data.outputs : null;
  var fromCache = false;
  if (outputs) {
    try { localStorage.setItem('txCache', JSON.stringify(outputs)); } catch (_) {}
  } else {
    try { outputs = JSON.parse(localStorage.getItem('txCache') || 'null'); fromCache = true; } catch (_) {}
  }

  if (!outputs || outputs.length === 0) {
    renderHistoryBalanceSparkline([]);
    container.innerHTML = '<div class="empty">No transactions yet</div>';
    return;
  }

  renderHistoryBalanceSparkline(outputs);

  // Show newest first
  const sorted = outputs.slice().sort((a, b) => b.block_height - a.block_height);

  container.innerHTML = sorted.map(o => {
    const typeLabel = o.is_coinbase ? 'mining reward' : (o.spent ? 'sent' : 'received');
    return '<div class="history-row' + (o.spent ? ' spent' : '') + '" data-txid="' + o.txid + '">' +
      '<div class="history-amount ' + (o.spent ? '' : 'g') + '">' +
        (o.spent ? '-' : '+') + formatBNT(o.amount) + ' BNT' +
      '</div>' +
      '<div class="history-meta">' +
        '<span class="d">Block ' + o.block_height + '</span>' +
        '<span class="' + (o.spent ? 'd' : 'g') + '">' + typeLabel + '</span>' +
      '</div>' +
      '<div class="history-tx d">' + o.txid.substring(0, 24) + '...</div>' +
    '</div>';
  }).join('');

  if (fromCache) {
    container.insertAdjacentHTML('afterbegin', '<div class="tx-cache-note d">Showing cached history ; resyncing blockchain</div>');
  }

  container.querySelectorAll('.history-row[data-txid]').forEach(row => {
    row.addEventListener('click', () => {
      window.__TAURI__.shell.open('https://explorer.blocknetcrypto.com/tx/' + row.dataset.txid);
    });
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
    var outputs = data.outputs && data.outputs.length > 0 ? data.outputs : null;
    if (!outputs) {
      try { outputs = JSON.parse(localStorage.getItem('txCache') || 'null'); } catch (_) {}
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

async function toggleMining() {
  const btn = document.getElementById('mining-toggle');
  btn.disabled = true;
  btn.textContent = isMining ? 'Stopping...' : 'Starting...';
  try {
    if (isMining) {
      await api('/api/mining/stop', { method: 'POST' });
    } else {
      await api('/api/mining/start', { method: 'POST' });
    }
  } catch (e) {
    console.error('Mining toggle error:', e);
  }
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
  }, 300);
}

// --- Network ---

async function loadNetwork() {
  const [peers, banned] = await Promise.all([
    api('/api/peers'),
    api('/api/peers/banned'),
  ]);

  document.getElementById('network-peer-count').textContent = peers.count;
  const peerList = document.getElementById('network-peers');
  if (peers.peers && peers.peers.length > 0) {
    peerList.innerHTML = peers.peers.map(p =>
      '<div class="peer-row">' + p + '</div>'
    ).join('');
  } else {
    peerList.innerHTML = '<div class="empty">No peers connected</div>';
  }

  document.getElementById('network-banned-count').textContent = banned.count;
  const bannedList = document.getElementById('network-banned');
  if (banned.banned && banned.banned.length > 0) {
    bannedList.innerHTML = banned.banned.map(b =>
      '<div class="peer-row banned">' +
        '<span>' + b.peer_id.substring(0, 24) + '...</span>' +
        '<span class="d">' + b.reason + '</span>' +
      '</div>'
    ).join('');
  } else {
    bannedList.innerHTML = '<div class="empty">No banned peers</div>';
  }
}

// --- Address Book ---

function getAddressBook() {
  try {
    return JSON.parse(localStorage.getItem('addressBook') || '[]');
  } catch (_) {
    return [];
  }
}

function saveAddressBook(book) {
  localStorage.setItem('addressBook', JSON.stringify(book));
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
        '<span class="ab-addr d">' + entry.address.substring(0, 24) + '...</span>' +
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

function showAddressSuggestions() {
  var input = document.getElementById('send-address');
  var container = document.getElementById('address-book-suggestions');
  var query = (input.value || '').trim().toLowerCase();
  var book = getAddressBook();

  if (!query || book.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  var matches = book.filter(function (e) {
    return e.name.toLowerCase().indexOf(query) >= 0 || e.address.toLowerCase().indexOf(query) >= 0;
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
      '<span class="as-addr d">' + e.address.substring(0, 20) + '...</span>' +
    '</div>';
  }).join('');

  container.querySelectorAll('.address-suggestion').forEach(function (el) {
    el.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      input.value = el.dataset.address;
      hideAddressSuggestions();
    });
  });
}

function hideAddressSuggestions() {
  var container = document.getElementById('address-book-suggestions');
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Send ---

async function handleSend(e) {
  e.preventDefault();
  const address = document.getElementById('send-address').value.trim();
  const amountStr = document.getElementById('send-amount').value;
  const btn = document.getElementById('send-submit');

  if (!address) {
    showSendStatus('Enter a recipient address', 'error');
    return;
  }
  const amountBNT = parseFloat(amountStr);
  if (!amountBNT || amountBNT <= 0) {
    showSendStatus('Enter a valid amount', 'error');
    return;
  }

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
    showSendStatus('Send ' + amountBNT + ' BNT to ' + address.substring(0, 16) + '...? Press again within 10s to confirm.', 'info');
    return;
  }

  sendArmed = false;
  if (sendArmTimer) { clearTimeout(sendArmTimer); sendArmTimer = null; }
  btn.classList.remove('armed');

  const amount = Math.round(amountBNT * 100000000);
  btn.disabled = true;
  btn.textContent = 'Sending...';
  showSendStatus('Building transaction...', 'info');

  try {
    const result = await api('/api/wallet/send', {
      method: 'POST',
      body: { address, amount },
    });
    showSendStatus('Sent! TX: ' + result.txid.substring(0, 24) + '... Fee: ' + formatBNT(result.fee) + ' BNT', 'success');
    document.getElementById('send-address').value = '';
    document.getElementById('send-amount').value = '';
  } catch (e) {
    showSendStatus(normalizeError(e), 'error');
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
    sessionPassword = '';
    dashLastHeight = -1;
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

    showImportStatus('Importing wallet from seed...', 'info');
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

    showPsStatus('Importing wallet from seed...', 'info');
    var body = { mnemonic: words.join(' '), password: password };
    if (filename) body.filename = filename;
    var result = await api('/api/wallet/import', { method: 'POST', body: body });

    var importedName = result.filename || filename || 'wallet.dat';
    // The daemon already loaded this wallet via import, just set it active
    // and go straight to the app
    sessionPassword = password;
    showApp();
  } catch (e) {
    showPsStatus(normalizeError(e), 'error');
    btn.disabled = false;
    btn.textContent = 'Import';
  }
}

// --- Settings ---

async function handleLockWallet() {
  try {
    await api('/api/wallet/lock', { method: 'POST' });
    playLock();
    sessionPassword = '';
    showUnlockScreen();
    showStatus('Wallet locked. Enter password to unlock.', 'info');
  } catch (e) {
    showSettingsStatus(normalizeError(e), 'error');
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

function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    try {
      if (currentView === 'dashboard') await loadDashboard();
      if (currentView === 'mining') await loadMining();
      // Check for inbound tx on every tick regardless of view,
      // but skip if dashboard already did it this tick
      if (currentView !== 'dashboard') await checkInboundTx();
    } catch (e) {
      // API might be temporarily unavailable
    }
  }, 1000);
}

function stopPolling() {
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

  var container = document.querySelector('.password-container');
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

  if (passwordTitle) passwordTitle.textContent = 'Welcome to blocknet';
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

function showApp() {
  const passwordScreen = document.getElementById('password-screen');
  const app = document.getElementById('app');
  if (passwordScreen) passwordScreen.style.display = 'none';
  app.style.display = 'flex';
  navigate('dashboard');
  startPolling();
  playTada();
  invoke('set_tray_unlocked', { unlocked: true }).catch(function() {});
}

function showAppFromSplash() {
  const splash = document.getElementById('splash');
  const app = document.getElementById('app');
  splash.classList.add('fade-out');
  app.style.display = 'flex';
  setTimeout(() => splash.remove(), 1000);
  navigate('dashboard');
  startPolling();
  invoke('set_tray_unlocked', { unlocked: true }).catch(function() {});
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
    } else {
      showStatus('Unable to start wallet. Check console and try again.', 'error');
    }
    submitBtn.disabled = false;
    submitBtn.textContent = 'Continue';
  }
}

async function waitForDaemon() {
  const maxAttempts = 60;
  let attempts = 0;
  while (attempts < maxAttempts) {
    const ready = await invoke('check_daemon_ready');
    if (ready) return;
    await new Promise(r => setTimeout(r, 500));
    attempts++;
  }
  throw new Error('Daemon failed to start within timeout');
}

async function ensureDaemonReady() {
  const alreadyReady = await invoke('check_daemon_ready');
  if (alreadyReady) return;

  if (!daemonStartPromise) {
    daemonStartPromise = (async () => {
      try {
        await invoke('start_daemon');
      } catch (e) {
        if (String(e || '').includes('SECURITY_BLOCKED')) throw e;
        // If daemon is already starting/running, proceed to readiness polling.
      }
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

// --- Wire up events ---

document.getElementById('password-form').addEventListener('submit', handlePasswordSubmit);
document.getElementById('send-form').addEventListener('submit', handleSend);
document.getElementById('copy-address').addEventListener('click', () => {
  const addr = document.getElementById('receive-address').textContent;
  navigator.clipboard.writeText(addr);
});
document.getElementById('qr-container').addEventListener('click', showQROverlay);
document.getElementById('qr-overlay').addEventListener('click', dismissQROverlay);
document.getElementById('mining-toggle').addEventListener('click', toggleMining);
document.getElementById('threads-inc').addEventListener('click', function () { changeThreads(1); });
document.getElementById('threads-dec').addEventListener('click', function () { changeThreads(-1); });
document.getElementById('export-csv-btn').addEventListener('click', exportHistoryCSV);
document.getElementById('save-contact-btn').addEventListener('click', handleSaveContact);
document.getElementById('send-address').addEventListener('input', showAddressSuggestions);
document.getElementById('send-address').addEventListener('focus', showAddressSuggestions);
document.getElementById('send-address').addEventListener('blur', function () {
  setTimeout(hideAddressSuggestions, 150);
});
document.getElementById('lock-wallet-btn').addEventListener('click', handleLockWallet);
document.getElementById('view-seed-btn').addEventListener('click', handleViewSeed);
document.getElementById('reset-chain-btn').addEventListener('click', handleResetChainData);

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

var navKeys = ['dashboard', 'send', 'receive', 'history', 'mining', 'network', 'settings'];

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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
