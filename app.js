const STORAGE_KEY = 'stock-industry-map';
const SWAP_COLORS_KEY = 'stock-industry-map-swapColors';
const SECOND_RANGE_KEY = 'stock-industry-map-secondRange';
const QUOTE_CACHE_KEY = 'stock-industry-map-quotes-v3';
const QUOTE_CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTE_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_X = 80;
const DEFAULT_Y = 80;
const DRAG_THRESHOLD = 5;

const state = {
  maps: [],
  activeMapId: null,
  selectedIndustryId: null,
  menuTarget: null,
  linkingFromIndustryId: null,
  selectedLink: null
};

function currentMap() {
  let m = state.maps.find(m => m.id === state.activeMapId);
  if (!m) {
    if (state.maps.length) {
      state.activeMapId = state.maps[0].id;
      return state.maps[0];
    }
    m = { id: 'm1', name: '地圖 1', industries: [], nextId: 1 };
    state.maps.push(m);
    state.activeMapId = m.id;
  }
  return m;
}

function toYahooSymbol(code) {
  const c = String(code).trim();
  if (/^\d{4,5}$/.test(c)) return c + '.TW';
  return c;
}

function formatPct(value) {
  if (value == null || Number.isNaN(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

let quoteCache = {};
function loadQuoteCache() {
  try {
    const raw = localStorage.getItem(QUOTE_CACHE_KEY);
    if (raw) quoteCache = JSON.parse(raw);
  } catch (_) {}
}
function saveQuoteCache() {
  try {
    localStorage.setItem(QUOTE_CACHE_KEY, JSON.stringify(quoteCache));
  } catch (_) {}
}

function getSecondRangeSetting() {
  try {
    const raw = localStorage.getItem(SECOND_RANGE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && (o.mode === 'ytd' || o.mode === 'date')) {
        return {
          mode: o.mode,
          date: (o.mode === 'date' && o.date) ? String(o.date).trim() : ''
        };
      }
    }
  } catch (_) {}
  return { mode: 'ytd', date: '' };
}

function saveSecondRangeSetting(setting) {
  try {
    localStorage.setItem(SECOND_RANGE_KEY, JSON.stringify(setting));
  } catch (_) {}
}

function isMarketOpen(symbol) {
  const d = new Date();
  const tz = (symbol.endsWith('.TW') || symbol.endsWith('.TWO')) ? 'Asia/Taipei' : 'America/New_York';
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const dayStr = dayFmt.format(d);
  if (dayStr === 'Sat' || dayStr === 'Sun') return false;
  const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false });
  const timeStr = timeFmt.format(d);
  const [h, m] = timeStr.split(':').map(Number);
  const mins = h * 60 + (m || 0);
  if (tz === 'Asia/Taipei') return mins >= 9 * 60 && mins < 13 * 60 + 30;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function getMarketTimezone(symbol) {
  return (symbol.endsWith('.TW') || symbol.endsWith('.TWO')) ? 'Asia/Taipei' : 'America/New_York';
}

function isTimestampTodayInMarketTZ(tsSec, symbol) {
  const tz = getMarketTimezone(symbol);
  const d = new Date(tsSec * 1000);
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const nowFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dateFmt.format(d) === nowFmt.format(new Date());
}

function fetchStockQuote(code) {
  const symbol = toYahooSymbol(code);
  const now = Date.now();
  const secondRange = getSecondRangeSetting();
  const cached = quoteCache[symbol];
  const cacheValid = cached && now - (cached.t || 0) < QUOTE_CACHE_TTL_MS && cached.dailyPct != null;
  const cacheHasSecond = secondRange.mode === 'ytd' ||
    (secondRange.mode === 'date' && secondRange.date && cached?.customDate === secondRange.date);
  if (cacheValid && cacheHasSecond) {
    const secondPct = secondRange.mode === 'ytd' ? cached.ytdPct : cached.customPct;
    return Promise.resolve({
      dailyPct: cached.dailyPct,
      secondPct,
      isRealtime: !!cached.isRealtime,
      quoteType: cached.quoteType
    });
  }
  const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=1y';
  const proxies = [
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(yahooUrl),
    'https://corsproxy.io/?' + encodeURIComponent(yahooUrl),
    'https://api.cors.lol/?' + encodeURIComponent(yahooUrl)
  ];
  const fetchWithTimeout = (url, ms) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(t));
  };
  function tryNext(i) {
    if (i >= proxies.length) return Promise.resolve(null);
    return fetchWithTimeout(proxies[i], QUOTE_FETCH_TIMEOUT_MS)
      .then(r => {
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('application/json')) throw new Error('Not JSON');
        return r.json();
      })
      .then(data => {
        const result = data.chart?.result?.[0];
        if (!result) throw new Error('No result');
        return data;
      })
      .catch(() => tryNext(i + 1));
  }
  return tryNext(0).then(data => {
    if (!data) return null;
    const result = data.chart?.result?.[0];
      const meta = result.meta || {};
      const quotes = result.indicators?.quote?.[0];
      const quoteCloses = quotes?.close;
      if (!quoteCloses?.length) return null;
      const validCloses = quoteCloses.filter(c => c != null && !Number.isNaN(c));
      if (validCloses.length < 2) return null;
      const lastTs = result.timestamp != null && result.timestamp.length ? result.timestamp[result.timestamp.length - 1] : null;
      const lastClose = validCloses[validCloses.length - 1];
      const prevClose = validCloses[validCloses.length - 2];
      const lastBarIsToday = lastTs != null && isTimestampTodayInMarketTZ(lastTs, symbol);
      const previousTradingDayClose = lastBarIsToday ? prevClose : lastClose;
      if (previousTradingDayClose === 0) return null;
      const marketOpen = isMarketOpen(symbol);
      const currentPrice = meta.regularMarketPrice;
      let dailyPctOut;
      let isRealtime = false;
      if (marketOpen && currentPrice != null && !Number.isNaN(currentPrice)) {
        dailyPctOut = ((currentPrice - previousTradingDayClose) / previousTradingDayClose) * 100;
        isRealtime = true;
      } else {
        dailyPctOut = ((lastClose - prevClose) / prevClose) * 100;
      }
      let ytdPct = null;
      let customPct = null;
      let customDate = null;
      if (result.timestamp?.length) {
        const year = new Date().getFullYear();
        const firstOfYearSec = new Date(year, 0, 1).getTime() / 1000;
        let firstClose = null;
        for (let i = 0; i < result.timestamp.length; i++) {
          const t = result.timestamp[i];
          const c = quoteCloses[i];
          if (t != null && c != null && !Number.isNaN(c) && t >= firstOfYearSec) {
            firstClose = c;
            break;
          }
        }
        if (firstClose != null && firstClose !== 0) ytdPct = ((lastClose - firstClose) / firstClose) * 100;
        if (secondRange.mode === 'date' && secondRange.date) {
          const parts = secondRange.date.replace(/-/g, '/').split('/');
          if (parts.length >= 3) {
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10) - 1;
            const d = parseInt(parts[2], 10);
            if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
              const fromSec = new Date(y, m, d).getTime() / 1000;
              let fromClose = null;
              for (let i = 0; i < result.timestamp.length; i++) {
                const t = result.timestamp[i];
                const c = quoteCloses[i];
                if (t != null && c != null && !Number.isNaN(c) && t >= fromSec) {
                  fromClose = c;
                  break;
                }
              }
              if (fromClose != null && fromClose !== 0) {
                customPct = ((lastClose - fromClose) / fromClose) * 100;
                customDate = secondRange.date;
              }
            }
          }
        }
      }
      const quoteType = (meta.quoteType || meta.instrumentType || '').toUpperCase();
      const secondPct = secondRange.mode === 'ytd' ? ytdPct : customPct;
    quoteCache[symbol] = { dailyPct: dailyPctOut, ytdPct, customPct, customDate, isRealtime, quoteType, t: now };
    saveQuoteCache();
    return { dailyPct: dailyPctOut, secondPct, isRealtime, quoteType };
  }).catch(() => null);
}

function updateStockRowChanges(row, data) {
  const dailyEl = row.querySelector('.stock-daily');
  const ytdEl = row.querySelector('.stock-ytd');
  if (!dailyEl || !ytdEl) return;
  if (data == null) {
    const typeLabel = row.querySelector('.stock-type-label');
    if (typeLabel) typeLabel.textContent = '';
    dailyEl.textContent = '—';
    ytdEl.textContent = '—';
    dailyEl.className = 'stock-daily change-loading';
    ytdEl.className = 'stock-ytd change-loading';
    return;
  }
  const typeLabel = row.querySelector('.stock-type-label');
  if (typeLabel) typeLabel.textContent = (data.quoteType === 'ETF' ? ' ETF' : '');
  dailyEl.textContent = formatPct(data.dailyPct);
  const dailyClass = Math.abs(data.dailyPct) < 0.005 ? 'change-flat' : (data.dailyPct >= 0 ? 'change-up' : 'change-down');
  dailyEl.className = 'stock-daily ' + dailyClass + (data.isRealtime ? ' realtime' : '');
  ytdEl.textContent = formatPct(data.secondPct);
  ytdEl.className = 'stock-ytd ' + (data.secondPct != null ? (data.secondPct >= 0 ? 'change-up' : 'change-down') : 'change-loading');
}

function ensurePositions() {
  const industries = currentMap().industries;
  industries.forEach((ind, index) => {
    if (typeof ind.x !== 'number' || typeof ind.y !== 'number') {
      ind.x = DEFAULT_X + (index % 4) * 220;
      ind.y = DEFAULT_Y + Math.floor(index / 4) * 180;
    }
  });
}

function generateId() {
  const m = currentMap();
  return 'i-' + (m.nextId++);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.maps && Array.isArray(data.maps)) {
        state.maps = data.maps;
        state.activeMapId = data.activeMapId || (state.maps[0] && state.maps[0].id);
      } else {
        const industries = data.industries || [];
        const maxId = industries.length
          ? Math.max(...industries.map(i => parseInt(String(i.id).replace('i-', ''), 10) || 0))
          : 0;
        state.maps = [{ id: 'm1', name: '地圖 1', industries, nextId: maxId + 1 }];
        state.activeMapId = 'm1';
      }
    }
    if (!state.maps.length) {
      state.maps = [{ id: 'm1', name: '地圖 1', industries: [], nextId: 1 }];
      state.activeMapId = 'm1';
    }
    ensurePositions();
  } catch (e) {
    console.warn('Load failed', e);
    if (!state.maps.length) {
      state.maps = [{ id: 'm1', name: '地圖 1', industries: [], nextId: 1 }];
      state.activeMapId = 'm1';
    }
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      maps: state.maps,
      activeMapId: state.activeMapId
    }));
  } catch (e) {
    console.warn('Save failed', e);
  }
}

function renderTabs() {
  const container = document.getElementById('tabs');
  if (!container) return;
  container.innerHTML = '';
  state.maps.forEach(m => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab' + (m.id === state.activeMapId ? ' active' : '');
    tab.textContent = m.name;
    tab.dataset.mapId = m.id;
    tab.addEventListener('click', () => switchMap(m.id));
    tab.addEventListener('dblclick', e => {
      e.stopPropagation();
      const name = prompt('重新命名此地圖', m.name)?.trim();
      if (name) {
        m.name = name;
        saveState();
        renderTabs();
      }
    });
    container.appendChild(tab);
  });
}

function switchMap(mapId) {
  state.activeMapId = mapId;
  cancelLinkingMode();
  closeMenu();
  saveState();
  renderTabs();
  render();
  document.getElementById('emptyState').style.display = currentMap().industries.length ? 'none' : 'block';
}

function addNewMap() {
  const usedIds = state.maps.map(m => m.id);
  let n = 1;
  while (usedIds.includes('m' + n)) n++;
  const id = 'm' + n;
  state.maps.push({ id, name: '地圖 ' + n, industries: [], nextId: 1 });
  state.activeMapId = id;
  saveState();
  renderTabs();
  render();
  document.getElementById('emptyState').style.display = 'block';
}

function deleteCurrentMap() {
  if (state.maps.length <= 1) {
    alert('至少需保留一個地圖。');
    return;
  }
  const name = currentMap().name;
  if (!confirm('確定要刪除「' + name + '」嗎？此地圖內所有產業與股票資料將一併移除。')) return;
  const idx = state.maps.findIndex(m => m.id === state.activeMapId);
  state.maps.splice(idx, 1);
  state.activeMapId = state.maps[Math.max(0, idx - 1)].id;
  cancelLinkingMode();
  closeMenu();
  closeLineMenu();
  saveState();
  renderTabs();
  render();
  document.getElementById('emptyState').style.display = currentMap().industries.length ? 'none' : 'block';
}

function createRootIndustry() {
  const name = prompt('請輸入根產業名稱（例如：產業A）', '產業A')?.trim();
  if (!name) return;
  const id = generateId();
  currentMap().industries.push({ id, name, relatedIds: [], stocks: [], x: DEFAULT_X, y: DEFAULT_Y });
  saveState();
  render();
  document.getElementById('emptyState').style.display = currentMap().industries.length ? 'none' : 'block';
}

function addRelatedIndustry(fromIndustryId) {
  const name = prompt('請輸入相關產業名稱（例如：產業B）', '產業B')?.trim();
  if (!name) return;
  const id = generateId();
  const industries = currentMap().industries;
  const from = industries.find(i => i.id === fromIndustryId);
  if (!from) return;
  ensurePositions();
  from.relatedIds = from.relatedIds || [];
  from.relatedIds.push(id);
  const newX = (from.x != null ? from.x : DEFAULT_X) + 220;
  const newY = from.y != null ? from.y : DEFAULT_Y;
  industries.push({ id, name, relatedIds: [], stocks: [], x: newX, y: newY });
  saveState();
  render();
  closeMenu();
}

function addStockToIndustry(industryId) {
  const ind = currentMap().industries.find(i => i.id === industryId);
  if (!ind) return;
  ind.stocks = ind.stocks || [];
  const code = prompt('請輸入股票公司代碼（例如：2330）', '')?.trim();
  if (!code) return;
  if (ind.stocks.includes(code)) {
    alert('該代碼已存在於此產業');
    return;
  }
  ind.stocks.push(code);
  saveState();
  render();
  closeMenu();
}

function renameIndustry(industryId) {
  const ind = currentMap().industries.find(i => i.id === industryId);
  if (!ind) return;
  const name = prompt('請輸入新名稱', ind.name)?.trim();
  if (!name) return;
  ind.name = name;
  saveState();
  render();
  closeMenu();
}

function deleteIndustry(industryId) {
  if (!confirm('確定要刪除此產業嗎？其下的股票與關聯也會一併移除。')) return;
  const industries = currentMap().industries;
  const next = industries.filter(i => i.id !== industryId);
  currentMap().industries = next;
  next.forEach(i => {
    if (i.relatedIds) i.relatedIds = i.relatedIds.filter(rid => rid !== industryId);
  });
  saveState();
  render();
  closeMenu();
  document.getElementById('emptyState').style.display = currentMap().industries.length ? 'none' : 'block';
}

function removeStock(industryId, code) {
  const ind = currentMap().industries.find(i => i.id === industryId);
  if (!ind || !ind.stocks) return;
  ind.stocks = ind.stocks.filter(s => s !== code);
  saveState();
  render();
}

function openMenu(x, y, industryId) {
  state.selectedIndustryId = industryId;
  state.menuTarget = { x, y };
  const pop = document.getElementById('menuPopover');
  pop.style.display = 'block';
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}

function closeMenu() {
  state.selectedIndustryId = null;
  state.menuTarget = null;
  document.getElementById('menuPopover').style.display = 'none';
}

function openLineMenu(x, y, fromId, toId) {
  state.selectedLink = { fromId, toId };
  const pop = document.getElementById('lineMenuPopover');
  pop.style.display = 'block';
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}

function closeLineMenu() {
  state.selectedLink = null;
  document.getElementById('lineMenuPopover').style.display = 'none';
}

function addManualLink(fromIndustryId, toIndustryId) {
  if (fromIndustryId === toIndustryId) return;
  const industries = currentMap().industries;
  const from = industries.find(i => i.id === fromIndustryId);
  const to = industries.find(i => i.id === toIndustryId);
  if (!from || !to) return;
  from.relatedIds = from.relatedIds || [];
  if (from.relatedIds.includes(toIndustryId)) return;
  from.relatedIds.push(toIndustryId);
  saveState();
  render();
}

function removeLink(fromIndustryId, toIndustryId) {
  const from = currentMap().industries.find(i => i.id === fromIndustryId);
  if (!from || !from.relatedIds) return;
  from.relatedIds = from.relatedIds.filter(rid => rid !== toIndustryId);
  saveState();
  render();
  closeLineMenu();
}

function startLinkingMode(industryId) {
  state.linkingFromIndustryId = industryId;
  closeMenu();
  updateLinkingHint(true);
}

function cancelLinkingMode() {
  state.linkingFromIndustryId = null;
  updateLinkingHint(false);
}

function updateLinkingHint(show) {
  const el = document.getElementById('linkingHint');
  if (!el) return;
  el.style.display = show ? 'inline' : 'none';
  if (show) el.textContent = '請點擊要關聯的產業（按 Esc 或點空白處取消）';
}

function getCenter(el) {
  const rect = el.getBoundingClientRect();
  const map = document.querySelector('.map-inner');
  const mapRect = map.getBoundingClientRect();
  return {
    x: rect.left - mapRect.left + rect.width / 2 + map.scrollLeft,
    y: rect.top - mapRect.top + rect.height / 2 + map.scrollTop
  };
}

function drawConnections() {
  const svg = document.getElementById('connections');
  const svgHit = document.getElementById('connectionsHit');
  const mapInner = document.querySelector('.map-inner');
  const mapContainer = document.querySelector('.map-container');
  if (!mapInner || !mapContainer || !svg || !svgHit) return;
  const mapRect = mapInner.getBoundingClientRect();
  const scrollLeft = mapContainer.scrollLeft || 0;
  const scrollTop = mapContainer.scrollTop || 0;
  const nodes = document.getElementById('nodes');
  const blocks = nodes.querySelectorAll('.industry-block');
  const points = new Map();
  blocks.forEach(block => {
    const id = block.dataset.id;
    const oval = block.querySelector('.industry-oval');
    if (id && oval) {
      const rect = oval.getBoundingClientRect();
      points.set(id, {
        x: rect.left - mapRect.left + rect.width / 2 + scrollLeft,
        y: rect.top - mapRect.top + rect.height / 2 + scrollTop
      });
    }
  });
  const w = mapInner.scrollWidth || mapRect.width;
  const h = mapInner.scrollHeight || mapRect.height;
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svgHit.setAttribute('width', w);
  svgHit.setAttribute('height', h);
  svg.innerHTML = '';
  svgHit.innerHTML = '';
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'connection-lines');
  const gHit = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  gHit.setAttribute('class', 'connection-lines');
  currentMap().industries.forEach(ind => {
    (ind.relatedIds || []).forEach(rid => {
      const a = points.get(ind.id);
      const b = points.get(rid);
      if (!a || !b) return;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'connection-group');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x);
      line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x);
      line.setAttribute('y2', b.y);
      line.setAttribute('class', 'connection-line');
      group.appendChild(line);
      g.appendChild(group);

      const groupHit = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      groupHit.setAttribute('class', 'connection-group');
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hit.setAttribute('x1', a.x);
      hit.setAttribute('y1', a.y);
      hit.setAttribute('x2', b.x);
      hit.setAttribute('y2', b.y);
      hit.setAttribute('class', 'connection-line-hit');
      groupHit.addEventListener('click', e => {
        e.stopPropagation();
        openLineMenu(e.clientX, e.clientY, ind.id, rid);
      });
      groupHit.appendChild(hit);
      gHit.appendChild(groupHit);
    });
  });
  svg.appendChild(g);
  svgHit.appendChild(gHit);
}

function render() {
  const nodes = document.getElementById('nodes');
  nodes.innerHTML = '';
  currentMap().industries.forEach(ind => {
    const block = document.createElement('div');
    block.className = 'industry-block';
    block.dataset.id = ind.id;
    block.style.left = (ind.x != null ? ind.x : DEFAULT_X) + 'px';
    block.style.top = (ind.y != null ? ind.y : DEFAULT_Y) + 'px';

    const oval = document.createElement('div');
    oval.className = 'industry-oval';
    oval.innerHTML = `<span class="name">${escapeHtml(ind.name)}</span>`;

    (function setupDrag(industry) {
      let startMouseX, startMouseY, startX, startY, dragged;
      function onMove(e) {
        if (!dragged && (Math.abs(e.clientX - startMouseX) > DRAG_THRESHOLD || Math.abs(e.clientY - startMouseY) > DRAG_THRESHOLD)) {
          dragged = true;
        }
        if (dragged) {
          const dx = e.clientX - startMouseX;
          const dy = e.clientY - startMouseY;
          industry.x = startX + dx;
          industry.y = startY + dy;
          block.style.left = industry.x + 'px';
          block.style.top = industry.y + 'px';
          drawConnections();
        }
      }
      function onUp(e) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragged) {
          saveState();
        } else {
          const x = e.clientX;
          const y = e.clientY;
          const id = industry.id;
          if (state.linkingFromIndustryId) {
            addManualLink(state.linkingFromIndustryId, id);
            cancelLinkingMode();
            return;
          }
          {
            industry._menuTimer = setTimeout(() => {
              industry._menuTimer = null;
              openMenu(x, y, id);
            }, 250);
          }
        }
      }
      oval.addEventListener('dblclick', e => {
        e.stopPropagation();
        if (industry._menuTimer) {
          clearTimeout(industry._menuTimer);
          industry._menuTimer = null;
        }
        renameIndustry(industry.id);
      });
      oval.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        startMouseX = e.clientX;
        startMouseY = e.clientY;
        startX = industry.x != null ? industry.x : DEFAULT_X;
        startY = industry.y != null ? industry.y : DEFAULT_Y;
        dragged = false;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp, { once: true });
      });
    })(ind);

    const connector = document.createElement('div');
    connector.className = 'industry-connector';

    const stocksBox = document.createElement('div');
    stocksBox.className = 'stocks-box';
    stocksBox.innerHTML = '<div class="label">股票代碼</div>';
    (ind.stocks || []).forEach((code, fromIndex) => {
      const row = document.createElement('div');
      row.className = 'stock-item';
      row.dataset.code = code;
      row.dataset.stockIndex = String(fromIndex);
      row.draggable = true;
      row.innerHTML = `<span class="code">${escapeHtml(code)}</span><span class="stock-type-label"></span><span class="changes"><span class="stock-daily change-loading">…</span><span class="sep">/</span><span class="stock-ytd change-loading">…</span></span><span class="retry-quote" title="重試取得漲跌幅">↻</span><span class="remove-stock" title="移除">×</span>`;
      row.addEventListener('dragstart', e => {
        if (e.target.closest('.remove-stock, .retry-quote')) {
          e.preventDefault();
          return;
        }
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify({ industryId: ind.id, fromIndex }));
        row.classList.add('stock-dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('stock-dragging'));
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const targetRow = e.currentTarget;
        if (targetRow.classList.contains('stock-dragging')) return;
        targetRow.classList.add('stock-drop-target');
      });
      row.addEventListener('dragleave', e => {
        e.currentTarget.classList.remove('stock-drop-target');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        e.currentTarget.classList.remove('stock-drop-target');
        const targetRow = e.currentTarget;
        if (targetRow.classList.contains('stock-dragging')) return;
        try {
          const { industryId, fromIndex: srcIdx } = JSON.parse(e.dataTransfer.getData('application/json'));
          if (industryId !== ind.id) return;
          const toIndex = parseInt(targetRow.dataset.stockIndex, 10);
          if (srcIdx === toIndex) return;
          const stocks = (ind.stocks || []).slice();
          const [removed] = stocks.splice(srcIdx, 1);
          stocks.splice(toIndex, 0, removed);
          ind.stocks = stocks;
          saveState();
          render();
        } catch (_) {}
      });
      row.querySelector('.remove-stock').addEventListener('click', e => {
        e.stopPropagation();
        removeStock(ind.id, code);
      });
      row.querySelector('.retry-quote').addEventListener('click', e => {
        e.stopPropagation();
        delete quoteCache[toYahooSymbol(code)];
        saveQuoteCache();
        row.querySelector('.stock-daily').textContent = '…';
        row.querySelector('.stock-ytd').textContent = '…';
        row.querySelector('.stock-daily').className = 'stock-daily change-loading';
        row.querySelector('.stock-ytd').className = 'stock-ytd change-loading';
        fetchStockQuote(code)
          .then(data => updateStockRowChanges(row, data))
          .catch(() => updateStockRowChanges(row, null));
      });
      stocksBox.appendChild(row);
      fetchStockQuote(code)
        .then(data => updateStockRowChanges(row, data))
        .catch(() => updateStockRowChanges(row, null));
    });
    const addRow = document.createElement('div');
    addRow.className = 'add-stock-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '新增代碼';
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const code = input.value.trim();
        if (!code) return;
        ind.stocks = ind.stocks || [];
        if (ind.stocks.includes(code)) return;
        ind.stocks.push(code);
        input.value = '';
        saveState();
        render();
      }
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '加入';
    addBtn.addEventListener('click', () => {
      const code = input.value.trim();
      if (!code) return;
      ind.stocks = ind.stocks || [];
      if (ind.stocks.includes(code)) return;
      ind.stocks.push(code);
      input.value = '';
      saveState();
      render();
    });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    stocksBox.appendChild(addRow);
    stocksBox.addEventListener('click', e => e.stopPropagation());

    block.appendChild(oval);
    block.appendChild(connector);
    block.appendChild(stocksBox);
    nodes.appendChild(block);
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(drawConnections);
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function init() {
  loadQuoteCache();
  loadState();
  renderTabs();
  render();
  document.getElementById('emptyState').style.display = currentMap().industries.length ? 'none' : 'block';

  document.getElementById('createRoot').addEventListener('click', createRootIndustry);
  document.getElementById('newMapBtn').addEventListener('click', addNewMap);
  document.getElementById('deleteMapBtn').addEventListener('click', deleteCurrentMap);

  try {
    if (localStorage.getItem(SWAP_COLORS_KEY) === '1') document.body.classList.add('swap-fluctuation-colors');
  } catch (_) {}
  document.getElementById('swapColorsBtn').addEventListener('click', () => {
    document.body.classList.toggle('swap-fluctuation-colors');
    try {
      localStorage.setItem(SWAP_COLORS_KEY, document.body.classList.contains('swap-fluctuation-colors') ? '1' : '0');
    } catch (_) {}
  });

  (function setupSecondRange() {
    const modeEl = document.getElementById('secondRangeMode');
    const dateEl = document.getElementById('secondRangeDate');
    if (!modeEl || !dateEl) return;
    const setting = getSecondRangeSetting();
    modeEl.value = setting.mode;
    dateEl.value = setting.date;
    dateEl.style.display = setting.mode === 'date' ? '' : 'none';

    function applyAndRefresh() {
      const mode = modeEl.value;
      const date = (dateEl.value || '').trim().replace(/-/g, '/');
      saveSecondRangeSetting({ mode, date });
      dateEl.style.display = mode === 'date' ? '' : 'none';
      quoteCache = {};
      saveQuoteCache();
      render();
    }

    modeEl.addEventListener('change', applyAndRefresh);
    dateEl.addEventListener('change', applyAndRefresh);
    dateEl.addEventListener('blur', () => {
      const date = (dateEl.value || '').trim().replace(/-/g, '/');
      if (date && modeEl.value === 'date') applyAndRefresh();
    });
  })();

  document.getElementById('lineMenuDelete').addEventListener('click', () => {
    if (state.selectedLink) {
      removeLink(state.selectedLink.fromId, state.selectedLink.toId);
    }
  });

  document.getElementById('menuPopover').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const id = state.selectedIndustryId;
      if (!id) return;
      if (action === 'add-related') addRelatedIndustry(id);
      else if (action === 'add-stock') addStockToIndustry(id);
      else if (action === 'link-manual') startLinkingMode(id);
      else if (action === 'rename') renameIndustry(id);
      else if (action === 'delete') deleteIndustry(id);
    });
  });

  document.getElementById('modalCancel').addEventListener('click', () => {
    document.getElementById('modalBackdrop').style.display = 'none';
  });
  document.getElementById('modalOk').addEventListener('click', () => {
    const title = document.getElementById('modalTitle').textContent;
    const value = document.getElementById('modalInput').value.trim();
    if (window._modalResolve) window._modalResolve(value);
    document.getElementById('modalBackdrop').style.display = 'none';
  });

  document.body.addEventListener('click', (e) => {
    if (e.target.closest('#menuPopover') || e.target.closest('#lineMenuPopover')) return;
    closeMenu();
    closeLineMenu();
    cancelLinkingMode();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') cancelLinkingMode();
  });

  const map = document.querySelector('.map-container');
  if (map) {
    map.addEventListener('scroll', drawConnections);
    new ResizeObserver(drawConnections).observe(document.querySelector('.map-inner'));
  }
}

init();
