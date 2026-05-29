/* ===== YT-Upcomings — app.js ===== */
'use strict';

// ─── IndexedDB ──────────────────────────────────────────────────────────────
const DB_NAME    = 'ytupcomings';
const DB_VERSION = 1;
const STORE_KV   = 'kv';

let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_KV)) d.createObjectStore(STORE_KV);
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = () => reject(req.error);
  });
}
function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KV, 'readwrite');
    tx.objectStore(STORE_KV).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
function dbGet(key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_KV, 'readonly');
    const req = tx.objectStore(STORE_KV).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Quota ──────────────────────────────────────────────────────────────────
// YouTube Data API v3 quota costs (units):
//   search.list  → 100 units per call
//   videos.list  →   1 unit  per call
// PT (Pacific Time) midnight resets the daily 10,000-unit quota.
const QUOTA_MAX   = 10000;
const QUOTA_COSTS = { search: 100, videos: 1 };

let quotaState = { used: 0, resetDatePT: '' }; // resetDatePT = "YYYY-MM-DD" in PT

// Returns today's date string in Pacific Time ("YYYY-MM-DD")
function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// Add quota units, reset if PT date changed, persist to DB
async function addQuota(type, count = 1) {
  const today = todayPT();
  if (quotaState.resetDatePT !== today) {
    quotaState = { used: 0, resetDatePT: today };
  }
  const cost = (QUOTA_COSTS[type] ?? 1) * count;
  quotaState.used += cost;
  await dbSet('quotaState', quotaState);
  renderQuota();
  return cost;
}

function renderQuota() {
  const used = quotaState.used;
  const pct  = Math.min(used / QUOTA_MAX * 100, 100);

  // Header badge
  const valEl  = document.getElementById('quotaValue');
  const badge  = document.getElementById('quotaBadge');
  if (valEl) valEl.textContent = used.toLocaleString();
  if (badge) {
    badge.classList.toggle('warn',   pct >= 70 && pct < 90);
    badge.classList.toggle('danger', pct >= 90);
  }

  // Drawer detail
  const detVal = document.getElementById('quotaDetailValue');
  const fill   = document.getElementById('quotaBarFill');
  if (detVal) detVal.textContent = used.toLocaleString();
  if (fill) {
    fill.style.width = pct + '%';
    fill.classList.toggle('warn',   pct >= 70 && pct < 90);
    fill.classList.toggle('danger', pct >= 90);
  }

  // Loading overlay live counter
  const lq = document.getElementById('loadingQuota');
  if (lq) lq.textContent = `クォータ使用: ${used.toLocaleString()} / ${QUOTA_MAX.toLocaleString()}`;

  // Reset time display (next PT midnight in local time)
  renderQuotaResetTime();
}

function renderQuotaResetTime() {
  const el = document.getElementById('quotaResetTime');
  if (!el) return;
  // Next PT midnight
  const todayStr = todayPT(); // YYYY-MM-DD
  const [y, m, d] = todayStr.split('-').map(Number);
  // Construct "tomorrow midnight PT" → convert to local
  // Use Intl to find PT offset by finding what UTC time is midnight PT today
  // Simple approach: build a Date in PT using a known offset trick
  const ptMidnightUTC = new Date(`${y}-${String(m).padStart(2,'0')}-${String(d+1).padStart(2,'0')}T00:00:00`);
  // We'll just show the local equivalent of next PT midnight approximately
  // More robust: use the timeZone in toLocaleString
  try {
    const nextReset = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) + 'T24:00:00');
    // This won't work directly; use a workaround:
    // Get current PT time string, parse it, compute next midnight
    const nowPT   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const msPT    = nowPT.getTime();
    const midPT   = new Date(nowPT);
    midPT.setHours(24, 0, 0, 0);
    const diffMs  = midPT.getTime() - msPT;
    const diffH   = Math.floor(diffMs / 3600000);
    const diffM   = Math.floor((diffMs % 3600000) / 60000);
    el.textContent = `あと ${diffH}h ${diffM}m`;
  } catch (_) {
    el.textContent = '—';
  }
}

// ─── App State ───────────────────────────────────────────────────────────────
let apiKey      = '';
let channels    = [];
let events      = [];
let lastUpdated = null; // Date | null
let activeFilter = 'all';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const menuBtn           = document.getElementById('menuBtn');
const drawer            = document.getElementById('drawer');
const drawerOverlay     = document.getElementById('drawerOverlay');
const drawerClose       = document.getElementById('drawerClose');
const apiKeyInput       = document.getElementById('apiKeyInput');
const toggleApiKey      = document.getElementById('toggleApiKey');
const saveApiKeyBtn     = document.getElementById('saveApiKey');
const apiKeyStatus      = document.getElementById('apiKeyStatus');
const quotaResetBtn     = document.getElementById('quotaResetBtn');
const channelIdInput    = document.getElementById('channelIdInput');
const channelNameInput  = document.getElementById('channelNameInput');
const channelColorInput = document.getElementById('channelColorInput');
const addChannelBtn     = document.getElementById('addChannelBtn');
const channelList       = document.getElementById('channelList');
const exportBtn         = document.getElementById('exportBtn');
const importFile        = document.getElementById('importFile');
const ieStatus          = document.getElementById('ieStatus');
const refreshBtn        = document.getElementById('refreshBtn');
const filterBar         = document.getElementById('filterBar');
const timeline          = document.getElementById('timeline');
const emptyState        = document.getElementById('emptyState');
const loadingOverlay    = document.getElementById('loadingOverlay');
const loadingText       = document.getElementById('loadingText');
const lastUpdatedBar    = document.getElementById('lastUpdatedBar');
const lastUpdatedText   = document.getElementById('lastUpdatedText');
const toast             = document.getElementById('toast');

// ─── Drawer ──────────────────────────────────────────────────────────────────
function openDrawer()  {
  drawer.classList.add('open');
  drawerOverlay.classList.add('open');
  renderQuotaResetTime(); // refresh countdown
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawerOverlay.classList.remove('open');
}
menuBtn.addEventListener('click', openDrawer);
drawerClose.addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

// ─── API Key ──────────────────────────────────────────────────────────────────
toggleApiKey.addEventListener('click', () => {
  const hidden = apiKeyInput.type === 'password';
  apiKeyInput.type = hidden ? 'text' : 'password';
  toggleApiKey.textContent = hidden ? '🔒' : '👁';
});
saveApiKeyBtn.addEventListener('click', async () => {
  const v = apiKeyInput.value.trim();
  if (!v) { setApiKeyStatus('キーを入力してください', 'error'); return; }
  apiKey = v;
  await dbSet('apiKey', apiKey);
  setApiKeyStatus('✓ 保存しました', 'ok');
});
function setApiKeyStatus(msg, type = '') {
  apiKeyStatus.textContent = msg;
  apiKeyStatus.className   = 'hint-text ' + type;
}

// ─── Quota reset button ───────────────────────────────────────────────────────
quotaResetBtn.addEventListener('click', async () => {
  quotaState = { used: 0, resetDatePT: todayPT() };
  await dbSet('quotaState', quotaState);
  renderQuota();
  showToast('クォータをリセットしました');
});

// ─── Channels ────────────────────────────────────────────────────────────────
function randomColor() {
  const p = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#f97316','#84cc16'];
  return p[Math.floor(Math.random() * p.length)];
}
addChannelBtn.addEventListener('click', async () => {
  const id    = channelIdInput.value.trim();
  const name  = channelNameInput.value.trim();
  const color = channelColorInput.value;
  if (!id) { showToast('チャンネルIDを入力してください', 'error'); return; }
  if (channels.find(c => c.id === id)) { showToast('すでに追加されています', 'error'); return; }
  channels.push({ id, name: name || id, color });
  await dbSet('channels', channels);
  channelIdInput.value    = '';
  channelNameInput.value  = '';
  channelColorInput.value = randomColor();
  renderChannelList();
  showToast('チャンネルを追加しました', 'ok');
});
async function deleteChannel(id) {
  channels = channels.filter(c => c.id !== id);
  await dbSet('channels', channels);
  renderChannelList();
  showToast('削除しました');
}
async function updateChannelColor(id, color) {
  const ch = channels.find(c => c.id === id);
  if (!ch) return;
  ch.color = color;
  await dbSet('channels', channels);
  document.querySelectorAll(`.event-card-accent[data-ch="${id}"]`).forEach(el => {
    el.style.background = color;
  });
}
function renderChannelList() {
  channelList.innerHTML = '';
  if (channels.length === 0) {
    channelList.innerHTML = '<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:8px 0">チャンネルなし</p>';
    return;
  }
  channels.forEach(ch => {
    const item = document.createElement('div');
    item.className = 'channel-item';
    item.innerHTML = `
      <div class="ch-color-dot" style="background:${ch.color}" title="クリックで色変更">
        <input type="color" value="${ch.color}" data-id="${ch.id}">
      </div>
      <div class="ch-info">
        <div class="ch-name">${escHtml(ch.name)}</div>
        <div class="ch-id">${escHtml(ch.id)}</div>
      </div>
      <button class="ch-delete" data-id="${ch.id}" title="削除">✕</button>
    `;
    item.querySelector('.ch-delete').addEventListener('click', () => deleteChannel(ch.id));
    const ci = item.querySelector('input[type="color"]');
    ci.addEventListener('input',  e => item.querySelector('.ch-color-dot').style.background = e.target.value);
    ci.addEventListener('change', e => updateChannelColor(ch.id, e.target.value));
    channelList.appendChild(item);
  });
}

// ─── Import / Export ─────────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => {
  const payload = {
    version:     2,
    exportedAt:  new Date().toISOString(),
    apiKey,
    channels,
    quotaState,
    lastUpdated: lastUpdated ? lastUpdated.toISOString() : null,
    events:      events.map(ev => ({
      ...ev,
      sortTime: ev.sortTime instanceof Date ? ev.sortTime.toISOString() : ev.sortTime,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `ytupcomings-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setIeStatus('✓ エクスポートしました', 'ok');
});

importFile.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.channels || !Array.isArray(data.channels)) throw new Error('不正なフォーマットです');

    // Apply imported data
    if (data.apiKey) {
      apiKey = data.apiKey;
      apiKeyInput.value = apiKey;
      await dbSet('apiKey', apiKey);
      setApiKeyStatus('✓ APIキーをインポートしました', 'ok');
    }
    channels = data.channels;
    await dbSet('channels', channels);
    renderChannelList();

    if (data.quotaState && typeof data.quotaState.used === 'number') {
      quotaState = data.quotaState;
      await dbSet('quotaState', quotaState);
      renderQuota();
    }

    if (data.lastUpdated) {
      lastUpdated = new Date(data.lastUpdated);
      await dbSet('lastUpdated', lastUpdated.toISOString());
      renderLastUpdated();
    }

    if (Array.isArray(data.events) && data.events.length > 0) {
      events = data.events.map(ev => ({
        ...ev,
        sortTime: new Date(ev.sortTime),
      }));
      await dbSet('cachedEvents', serializeEvents(events));
      renderTimeline();
    }

    setIeStatus(`✓ インポート完了 (ch:${channels.length} / ev:${events.length})`, 'ok');
  } catch (err) {
    setIeStatus('エラー: ' + err.message, 'error');
  }
  importFile.value = '';
});

function setIeStatus(msg, type = '') {
  ieStatus.textContent = msg;
  ieStatus.className   = 'hint-text ' + type;
}

// ─── Fetch ───────────────────────────────────────────────────────────────────
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(path, params, quotaType) {
  const url = new URL(YT_BASE + path);
  const p   = { ...params, key: apiKey };
  // Remove undefined entries
  Object.keys(p).forEach(k => p[k] === undefined && delete p[k]);
  Object.entries(p).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  // Count quota regardless of result
  await addQuota(quotaType || (path.includes('search') ? 'search' : 'videos'));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err.error?.message) || `HTTP ${res.status}`);
  }
  return res.json();
}

function isoWeekRange() {
  const now  = new Date();
  const from = new Date(now.getTime() - 7 * 86400 * 1000);
  const to   = new Date(now.getTime() + 7 * 86400 * 1000);
  return { publishedAfter: from.toISOString(), publishedBefore: to.toISOString() };
}

async function fetchChannelVideos(ch) {
  const { publishedAfter, publishedBefore } = isoWeekRange();
  const items = [];
  let pageToken = '';
  do {
    setLoadingText(`「${ch.name}」の動画を検索中...`);
    const params = {
      part: 'snippet', channelId: ch.id, type: 'video',
      order: 'date', publishedAfter, publishedBefore,
      maxResults: 50,
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await ytGet('/search', params, 'search');
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  const videoIds = [...new Set(items.map(i => i.id?.videoId).filter(Boolean))];
  if (!videoIds.length) return [];

  const allDetails = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    setLoadingText(`「${ch.name}」の詳細を取得中... (${i + 1}/${videoIds.length})`);
    const det = await ytGet('/videos', {
      part: 'snippet,liveStreamingDetails,contentDetails',
      id: batch.join(','),
    }, 'videos');
    allDetails.push(...(det.items || []));
  }
  return allDetails.map(v => parseVideoItem(v, ch));
}

async function fetchUpcomingLives(ch) {
  setLoadingText(`「${ch.name}」の配信予定を取得中...`);
  let items = [];
  try {
    const data = await ytGet('/search', {
      part: 'snippet', channelId: ch.id, type: 'video',
      eventType: 'upcoming', maxResults: 50,
    }, 'search');
    items = data.items || [];
  } catch (_) { return []; }
  const videoIds = items.map(i => i.id?.videoId).filter(Boolean);
  if (!videoIds.length) return [];
  const det = await ytGet('/videos', {
    part: 'snippet,liveStreamingDetails,contentDetails',
    id: videoIds.join(','),
  }, 'videos');
  return (det.items || []).map(v => parseVideoItem(v, ch));
}

async function fetchLiveNow(ch) {
  setLoadingText(`「${ch.name}」のライブ配信を確認中...`);
  let items = [];
  try {
    const data = await ytGet('/search', {
      part: 'snippet', channelId: ch.id, type: 'video',
      eventType: 'live', maxResults: 10,
    }, 'search');
    items = data.items || [];
  } catch (_) { return []; }
  const videoIds = items.map(i => i.id?.videoId).filter(Boolean);
  if (!videoIds.length) return [];
  const det = await ytGet('/videos', {
    part: 'snippet,liveStreamingDetails,contentDetails',
    id: videoIds.join(','),
  }, 'videos');
  return (det.items || []).map(v => parseVideoItem(v, ch));
}

function parseVideoItem(v, ch) {
  const s   = v.snippet || {};
  const lsd = v.liveStreamingDetails;
  const ls  = s.liveBroadcastContent;

  let type, sortTime, displayTime;

  if (ls === 'live') {
    type        = 'live';
    const start = lsd?.actualStartTime || s.publishedAt;
    sortTime    = new Date(start);
    displayTime = `🔴 配信中 (${fmtTime(start)} 開始)`;
  } else if (ls === 'upcoming') {
    type        = 'upcoming';
    const sched = lsd?.scheduledStartTime || s.publishedAt;
    sortTime    = new Date(sched);
    displayTime = `📅 ${fmtDateTime(sched)} 予定`;
  } else if (lsd) {
    type        = 'completed';
    const start = lsd.actualStartTime || s.publishedAt;
    sortTime    = new Date(start);
    displayTime = `📼 ${fmtDateTime(start)} アーカイブ`;
  } else {
    type        = 'video';
    sortTime    = new Date(s.publishedAt);
    displayTime = `🎬 ${fmtDateTime(s.publishedAt)} 公開`;
  }

  return {
    id: v.id, type,
    channelId:    ch.id,
    channelName:  ch.name,
    channelColor: ch.color,
    title:        s.title || '(タイトルなし)',
    thumbnail:    s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
    url:          `https://www.youtube.com/watch?v=${v.id}`,
    sortTime,
    displayTime,
    concurrentViewers: lsd?.concurrentViewers || null,
  };
}

function fmtTime(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
function fmtDateLabel(date) {
  const d    = new Date(date);
  const now  = new Date();
  const diff = Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const base = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
  if (diff === 0)  return `TODAY — ${base}`;
  if (diff === 1)  return `TOMORROW — ${base}`;
  if (diff === -1) return `YESTERDAY — ${base}`;
  return base;
}

// ─── Refresh ─────────────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', fetchAll);

async function fetchAll() {
  if (!apiKey)            { showToast('APIキーを設定してください', 'error');    return; }
  if (!channels.length)   { showToast('チャンネルを追加してください', 'error'); return; }

  showLoading(true);
  refreshBtn.classList.add('spinning');
  events = [];

  try {
    for (const ch of channels) {
      const [videos, upcoming, liveNow] = await Promise.all([
        fetchChannelVideos(ch).catch(e => { console.warn(ch.id, e); return []; }),
        fetchUpcomingLives(ch).catch(() => []),
        fetchLiveNow(ch).catch(()        => []),
      ]);
      const seen = new Set();
      [...liveNow, ...upcoming, ...videos].forEach(ev => {
        if (!seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
      });
    }

    // Save cache & last updated
    lastUpdated = new Date();
    await Promise.all([
      dbSet('cachedEvents', serializeEvents(events)),
      dbSet('lastUpdated', lastUpdated.toISOString()),
    ]);

    renderTimeline();
    renderLastUpdated();
    showToast(`${events.length} 件取得しました`, 'ok');
  } catch (err) {
    console.error(err);
    showToast('取得エラー: ' + err.message, 'error');
  } finally {
    showLoading(false);
    refreshBtn.classList.remove('spinning');
  }
}

// Serialize events: convert Date objects to ISO strings for storage
function serializeEvents(evs) {
  return evs.map(ev => ({
    ...ev,
    sortTime: ev.sortTime instanceof Date ? ev.sortTime.toISOString() : ev.sortTime,
  }));
}
function deserializeEvents(evs) {
  return evs.map(ev => ({ ...ev, sortTime: new Date(ev.sortTime) }));
}

// ─── Last Updated ─────────────────────────────────────────────────────────────
function renderLastUpdated() {
  if (!lastUpdated) {
    lastUpdatedText.textContent = '';
    return;
  }
  const ts = lastUpdated.toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  lastUpdatedText.textContent = `最終更新: ${ts}`;
}

// ─── Render Timeline ──────────────────────────────────────────────────────────
filterBar.addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  activeFilter = chip.dataset.filter;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  renderTimeline();
});

function renderTimeline() {
  let list = activeFilter === 'all' ? events : events.filter(ev => ev.type === activeFilter);
  list = [...list].sort((a, b) => a.sortTime - b.sortTime);

  timeline.innerHTML = '';
  if (list.length === 0) {
    timeline.appendChild(emptyState);
    return;
  }

  const now = new Date();
  let prevDk = null, todayLine = false;

  list.forEach(ev => {
    const dk = dateKey(ev.sortTime);
    if (dk !== prevDk) {
      timeline.appendChild(makeDateSep(ev.sortTime));
      prevDk = dk;
    }
    if (!todayLine && ev.sortTime > now) {
      todayLine = true;
      timeline.appendChild(makeTodayLine());
    }
    timeline.appendChild(makeEventCard(ev));
  });
}

function dateKey(d) {
  return new Date(d).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function makeDateSep(date) {
  const el = document.createElement('div');
  el.className = 'date-sep';
  el.innerHTML = `<div class="date-sep-line"></div><span class="date-sep-label">${escHtml(fmtDateLabel(date))}</span><div class="date-sep-line"></div>`;
  return el;
}
function makeTodayLine() {
  const el = document.createElement('div');
  el.className = 'today-line';
  el.innerHTML = `<div class="today-line-bar"></div><span class="today-line-label">NOW</span><div class="today-line-bar"></div>`;
  return el;
}

const TYPE_LABELS = {
  live:      ['LIVE',     'badge-live'],
  upcoming:  ['UPCOMING', 'badge-upcoming'],
  completed: ['ARCHIVE',  'badge-completed'],
  video:     ['VIDEO',    'badge-video'],
};

function makeEventCard(ev) {
  const [label, badgeClass] = TYPE_LABELS[ev.type] || ['VIDEO', 'badge-video'];
  const card = document.createElement('div');
  card.className = 'event-card';

  const thumbHtml = ev.thumbnail
    ? `<img class="event-thumb" src="${escHtml(ev.thumbnail)}" alt="" loading="lazy">`
    : `<div class="event-thumb-placeholder">📺</div>`;

  const viewersHtml = ev.concurrentViewers
    ? `<span class="event-viewers">👁 ${Number(ev.concurrentViewers).toLocaleString()}</span>`
    : '';

  card.innerHTML = `
    <div class="event-card-accent" data-ch="${escHtml(ev.channelId)}" style="background:${escHtml(ev.channelColor)}"></div>
    <div class="event-card-inner">
      ${thumbHtml}
      <div class="event-body">
        <div class="event-meta">
          ${ev.type === 'live' ? '<span class="live-dot"></span>' : ''}
          <span class="event-type-badge ${badgeClass}">${label}</span>
          <span class="event-ch-name" style="color:${escHtml(ev.channelColor)}">${escHtml(ev.channelName)}</span>
        </div>
        <div class="event-title">${escHtml(ev.title)}</div>
        <div class="event-footer">
          <span class="event-time">${escHtml(ev.displayTime)}</span>
          ${viewersHtml}
          <a class="event-link" href="${escHtml(ev.url)}" target="_blank" rel="noopener">開く ↗</a>
        </div>
      </div>
    </div>
  `;
  return card;
}

// ─── Loading & Toast ──────────────────────────────────────────────────────────
function showLoading(on) {
  loadingOverlay.classList.toggle('visible', on);
}
function setLoadingText(msg) {
  loadingText.textContent = msg;
  renderQuota(); // update live quota counter in overlay
}

let toastTimer;
function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className   = 'toast visible ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await openDB();

  // Load all persisted state in parallel
  const [savedKey, savedChannels, savedQuota, savedLastUpdated, savedEvents] = await Promise.all([
    dbGet('apiKey'),
    dbGet('channels'),
    dbGet('quotaState'),
    dbGet('lastUpdated'),
    dbGet('cachedEvents'),
  ]);

  if (savedKey) {
    apiKey = savedKey;
    apiKeyInput.value = savedKey;
    setApiKeyStatus('✓ APIキーが読み込まれています', 'ok');
  }

  if (Array.isArray(savedChannels) && savedChannels.length) {
    channels = savedChannels;
    renderChannelList();
  }

  // Quota — check for PT date rollover on load
  const today = todayPT();
  if (savedQuota && typeof savedQuota.used === 'number') {
    quotaState = savedQuota.resetDatePT === today
      ? savedQuota
      : { used: 0, resetDatePT: today };
    if (savedQuota.resetDatePT !== today) await dbSet('quotaState', quotaState);
  } else {
    quotaState = { used: 0, resetDatePT: today };
  }
  renderQuota();

  if (savedLastUpdated) {
    lastUpdated = new Date(savedLastUpdated);
    renderLastUpdated();
  }

  if (Array.isArray(savedEvents) && savedEvents.length) {
    events = deserializeEvents(savedEvents);
    renderTimeline();
  } else {
    timeline.appendChild(emptyState);
  }

  channelColorInput.value = randomColor();

  // Update quota reset countdown every minute
  setInterval(renderQuotaResetTime, 60000);
}

init().catch(console.error);
