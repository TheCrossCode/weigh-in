// Weigh-In — offline-first weight + program tracker. All data lives on-device (IndexedDB).
// Each weigh-in is an "entry" {id, date: 'YYYY-MM-DD', time: ms, weight: kg, photos: Blob[]}.
// A day can hold several entries; day-level views (program days) use that day's latest one.

const $ = (s, r = document) => r.querySelector(s);
const KG_PER_LB = 0.45359237;
const MAX_PHOTOS = 6;
const DAY = 86400000;

/* ---------------- storage ---------------- */

let dbp;
function db() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('weigh-in', 2);
    r.onupgradeneeded = () => {
      const d = r.result, t = r.transaction;
      if (!d.objectStoreNames.contains('programs')) d.createObjectStore('programs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('entries')) {
        const es = d.createObjectStore('entries', { keyPath: 'id' });
        // v1 stored one log per day keyed by date — carry those over as entries.
        if (d.objectStoreNames.contains('logs')) {
          t.objectStore('logs').getAll().onsuccess = (e) => {
            for (const l of e.target.result) es.put(migrated(l));
          };
        }
      }
    };
    r.onsuccess = () => {
      // Let an upgrade from another tab (or a newer app version) proceed instead of blocking.
      r.result.onversionchange = () => { r.result.close(); dbp = null; };
      res(r.result);
    };
    r.onerror = () => rej(r.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const getAll = (s) => tx(s, 'readonly', (st) => st.getAll());
const put = (s, v) => tx(s, 'readwrite', (st) => st.put(v));
const del = (s, k) => tx(s, 'readwrite', (st) => st.delete(k));

/* ---------------- state + helpers ---------------- */

const state = {
  logs: [], programs: [], unit: loadPref('unit', null), open: new Set(), pick: null,
  range: loadPref('range', 'month'), offset: 0,
};
if (state.unit !== 'lb' && state.unit !== 'kg') state.unit = /^en-(US|LR|MM)/i.test(navigator.language || '') ? 'lb' : 'kg';
if (!['week', 'month', 'year'].includes(state.range)) state.range = 'month';

function loadPref(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(k, v); } catch {} }
function setUnit(u) { state.unit = u; savePref('unit', u); render(); }

const toDisp = (kg) => (state.unit === 'lb' ? kg / KG_PER_LB : kg);
const fromDisp = (v) => (state.unit === 'lb' ? v * KG_PER_LB : v);
const fmt = (kg) => toDisp(kg).toFixed(1);
const r1 = (kg) => Math.round(toDisp(kg) * 10) / 10;
const signed = (d) => {
  if (d == null) return '—';
  const r = r1(d);
  return r === 0 ? '0.0' : (r > 0 ? '+' : '−') + Math.abs(r).toFixed(1);
};
function tone(d, goal) {
  if (d == null) return 'none';
  const r = r1(d);
  if (r === 0) return 'flat';
  if (!goal) return '';
  return (goal === 'cut') === r < 0 ? 'good' : 'bad';
}
function chip(d, goal) {
  if (d == null) return '';
  const r = r1(d);
  const ar = r > 0 ? '▲' : r < 0 ? '▼' : '•';
  return `<span class="chip ${tone(d, goal)}"><span class="ar">${ar}</span>${Math.abs(r).toFixed(1)}</span>`;
}

const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dayStr(new Date());
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const noonOf = (s) => parseDay(s).getTime() + DAY / 2;
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return dayStr(d); };
const dayDiff = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY);
const fmtDate = (s, o = { month: 'short', day: 'numeric' }) => parseDay(s).toLocaleDateString(undefined, o);
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// `exact` = we know the real time of day (logged live). Backfilled days sit at noon and never show a time.
const stamp = (date) => (date === todayStr() ? { time: Date.now(), exact: true } : { time: noonOf(date), exact: false });
const timeOf = (e) => (e.exact ? fmtTime(e.time) : '');
// A v1 log (one per day, keyed by date): keep its save time if it was saved on that day.
function migrated(l) {
  const real = l.updated && dayStr(new Date(l.updated)) === l.date;
  return { ...l, id: l.id || `m-${l.date}`, time: l.time || (real ? l.updated : noonOf(l.date)), exact: l.exact ?? !!real };
}
const byOrder = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.time - b.time);

const byId = (id) => state.logs.find((l) => l.id === id);
const prevEntry = (e) => state.logs[state.logs.findIndex((l) => l.id === e.id) - 1] || null;
const dayCount = (d) => state.logs.reduce((n, l) => n + (l.date === d), 0);
function dayLast(d) { let r = null; for (const l of state.logs) { if (l.date === d) r = l; else if (l.date > d) break; } return r; }
const dayFirst = (d) => state.logs.find((l) => l.date === d) || null;
function lastOnOrBefore(d) { let p = null; for (const l of state.logs) { if (l.date <= d) p = l; else break; } return p; }
function lastBefore(d) { let p = null; for (const l of state.logs) { if (l.date < d) p = l; else break; } return p; }
const activeProgram = () => state.programs.find((p) => !p.endDate);
const goalFor = (d) => state.programs.find((p) => p.startDate <= d && (!p.endDate || d <= p.endDate))?.type || null;

const urls = new WeakMap();
function blobURL(b) { let u = urls.get(b); if (!u) { u = URL.createObjectURL(b); urls.set(b, u); } return u; }

const ICON = {
  cam: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  camBig: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
};

/* ---------------- load + render ---------------- */

async function load() {
  const [logs, programs] = await Promise.all([getAll('entries'), getAll('programs')]);
  state.logs = logs.sort(byOrder);
  state.programs = programs.sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  // A program whose planned end date has passed finishes on that date.
  for (const p of state.programs) {
    if (!p.endDate && p.planEnd && p.planEnd < todayStr()) { p.endDate = p.planEnd; await put('programs', p); }
  }
  render();
}

function render() {
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  $('[data-act=share-all]').hidden = !state.logs.length;
  renderHero();
  renderTiles();
  renderChart();
  renderHistory();
  renderPrograms();
}

function renderHero() {
  const last = state.logs.at(-1);
  if (!last) {
    $('#hero').innerHTML = `<div class="hero-empty"><div class="big">—</div><p>Tap + to log your first weigh-in</p></div>`;
    return;
  }
  const prev = state.logs.at(-2);
  const when = last.date === todayStr() ? 'Today' : fmtDate(last.date, { weekday: 'short', month: 'short', day: 'numeric' });
  $('#hero').innerHTML = `
    <div class="hero-weight"><span class="big">${fmt(last.weight)}</span><button class="unit" data-act="unit">${state.unit}</button></div>
    <div class="hero-sub"><span>${when}</span>${prev ? chip(last.weight - prev.weight, goalFor(last.date)) : ''}</div>`;
}

function changeOver(days, at = state.logs.at(-1)) {
  const ref = at && lastOnOrBefore(addDays(at.date, -days));
  return ref ? at.weight - ref.weight : null;
}

function renderTiles() {
  const el = $('#tiles');
  const L = state.logs;
  if (!L.length) { el.hidden = true; return; }
  el.hidden = false;
  const goal = activeProgram()?.type || null;
  const tiles = [
    ['Last', L.length > 1 ? L.at(-1).weight - L.at(-2).weight : null],
    ['Week', changeOver(7)],
    ['Month', changeOver(30)],
    ['Total', L.length > 1 ? L.at(-1).weight - L[0].weight : null],
  ];
  el.innerHTML = tiles.map(([label, d]) =>
    `<div class="tile"><div class="tile-val ${tone(d, goal)}">${signed(d)}</div><div class="tile-label">${label}</div></div>`).join('');
}

/* ---------------- charts ---------------- */

const weekStartsSunday = /-(US|CA|JP|IL|BR|MX|PH|KR|TW|IN)$/i.test(navigator.language || '');

// Calendar period for the main chart: week / month / year, shifted by `off` periods (0 = current).
function period(range, off) {
  const now = new Date();
  let s, e;
  if (range === 'week') {
    const back = (now.getDay() - (weekStartsSunday ? 0 : 1) + 7) % 7;
    s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back + off * 7);
    e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7);
  } else if (range === 'month') {
    s = new Date(now.getFullYear(), now.getMonth() + off, 1);
    e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
  } else {
    s = new Date(now.getFullYear() + off, 0, 1);
    e = new Date(s.getFullYear() + 1, 0, 1);
  }
  const ticks = [];
  let label;
  if (range === 'week') {
    for (let i = 0; i < 7; i++) {
      const d = new Date(s.getFullYear(), s.getMonth(), s.getDate() + i, 12);
      ticks.push({ t: d.getTime(), label: d.toLocaleDateString(undefined, { weekday: 'narrow' }) });
    }
    const last = new Date(e.getFullYear(), e.getMonth(), e.getDate() - 1);
    const o = { month: 'short', day: 'numeric', ...(s.getFullYear() !== now.getFullYear() && { year: 'numeric' }) };
    label = `${s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString(undefined, o)}`;
  } else if (range === 'month') {
    const days = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate();
    for (const day of [1, 8, 15, 22, 29]) if (day <= days) ticks.push({ t: new Date(s.getFullYear(), s.getMonth(), day, 12).getTime(), label: String(day) });
    label = s.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  } else {
    for (let m = 0; m < 12; m++) ticks.push({ t: new Date(s.getFullYear(), m, 15).getTime(), label: new Date(2000, m, 1).toLocaleDateString(undefined, { month: 'narrow' }) });
    label = String(s.getFullYear());
  }
  return { s: s.getTime(), e: e.getTime(), ticks, label };
}

let chartSeq = 0;
// Draws a weight line into `el`. `entries` may include one point either side of the window
// so the line runs off the edges; only `inRange` points get dots and tooltips.
function drawChart(el, { entries, inRange, t0, t1, ticks = [], color = 'var(--accent)', target = null, path = null, dots = false, H = 140 }) {
  const W = el.clientWidth || 340;
  const PL = 14, PR = 44, PT = 18, PB = ticks.length ? 26 : 12;
  const plotB = H - PB;
  const X = (t) => PL + ((t - t0) / (t1 - t0)) * (W - PL - PR);
  const tickSVG = ticks.map((k) => `<text class="axis tick" x="${X(k.t).toFixed(1)}" y="${H - 8}" text-anchor="${k.anchor || 'middle'}">${k.label}</text>`).join('');
  el._tip = -1;
  if (!inRange.length) {
    el._pts = [];
    el.innerHTML = `<svg width="${W}" height="${H}" aria-hidden="true">
      <text class="axis empty" x="${(W - PR + PL) / 2}" y="${plotB / 2 + 6}" text-anchor="middle">No logs</text>${tickSVG}</svg><div class="tip" hidden></div>`;
    return;
  }
  const vals = inRange.map((e) => toDisp(e.weight));
  if (target != null) vals.push(toDisp(target));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { const m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
  const Y = (v) => PT + ((hi - v) / (hi - lo)) * (plotB - PT);
  const pts = entries.map((e) => ({ x: X(e.time), y: Y(toDisp(e.weight)), e }));
  const id = ++chartSeq;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
  const area = `${line}L${pts.at(-1).x.toFixed(1)} ${plotB}L${pts[0].x.toFixed(1)} ${plotB}Z`;
  const inPts = pts.filter((p) => inRange.includes(p.e));
  const lastPt = inPts.at(-1);
  const isLatest = lastPt.e === state.logs.at(-1);
  const showDots = dots || inPts.length < 3;
  el._pts = inPts;
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <defs>
      <linearGradient id="cg${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:${color};stop-opacity:.24"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/>
      </linearGradient>
      <clipPath id="cc${id}"><rect x="${PL - 8}" y="0" width="${W - PL - PR + 16}" height="${plotB}"/></clipPath>
    </defs>
    ${target != null ? `<line x1="${PL}" x2="${W - PR}" y1="${Y(toDisp(target)).toFixed(1)}" y2="${Y(toDisp(target)).toFixed(1)}" style="stroke:${color};stroke-width:1.5;stroke-dasharray:5 5;opacity:.55"/>` : ''}
    <g clip-path="url(#cc${id})">
      ${path ? `<line x1="${X(path.t0).toFixed(1)}" y1="${Y(toDisp(path.v0)).toFixed(1)}" x2="${X(path.t1).toFixed(1)}" y2="${Y(toDisp(path.v1)).toFixed(1)}" style="stroke:var(--muted);stroke-width:1.5;stroke-dasharray:2 4;stroke-linecap:round;opacity:.7"/>` : ''}
      <path d="${area}" fill="url(#cg${id})"/>
      <path d="${line}" style="fill:none;stroke:${color};stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round"/>
      ${showDots ? inPts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" style="fill:${color}"/>`).join('') : ''}
      ${isLatest ? `<circle cx="${lastPt.x}" cy="${lastPt.y}" r="8" style="fill:${color};opacity:.18"/><circle cx="${lastPt.x}" cy="${lastPt.y}" r="3.75" style="fill:${color}"/>` : ''}
    </g>
    <text class="axis" x="${W - 10}" y="${PT + 4}" text-anchor="end">${hi.toFixed(1)}</text>
    <text class="axis" x="${W - 10}" y="${plotB + 2}" text-anchor="end">${lo.toFixed(1)}</text>
    ${tickSVG}
    <g class="cmark" style="display:none">
      <line y1="0" y2="${plotB}" style="stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;opacity:.6"/>
      <circle r="5.5" style="fill:var(--text);stroke:var(--surface);stroke-width:2.5"/>
    </g>
  </svg><div class="tip" hidden></div>`;
}

function renderChart() {
  const card = $('#chart-card');
  if (!state.logs.length) { card.hidden = true; return; }
  card.hidden = false;
  card.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.range));
  const p = period(state.range, state.offset);
  const inRange = state.logs.filter((l) => l.time >= p.s && l.time < p.e);
  const before = state.logs.filter((l) => l.time < p.s).at(-1);
  const after = state.logs.find((l) => l.time >= p.e);
  $('#chart-label').textContent = p.label;
  $('#chart-chip').innerHTML = inRange.length > 1 ? chip(inRange.at(-1).weight - inRange[0].weight, activeProgram()?.type || null) : '';
  $('[data-act=chart-prev]').disabled = !(state.logs[0].time < p.s);
  $('[data-act=chart-next]').disabled = state.offset >= 0;
  drawChart($('#chart'), {
    entries: [before, ...inRange, after].filter(Boolean), inRange, t0: p.s, t1: p.e,
    ticks: p.ticks, dots: state.range !== 'year', H: 150,
  });
}

// Move the main chart by one period (-1 = older). Returns false at either end.
function shiftPeriod(dir) {
  const next = state.offset + dir;
  if (next > 0) return false;
  if (dir < 0 && !(state.logs[0]?.time < period(state.range, state.offset).s)) return false;
  state.offset = next;
  renderChart();
  $('#chart svg')?.animate(
    [{ transform: `translateX(${dir < 0 ? -48 : 48}px)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }],
    { duration: 240, easing: 'cubic-bezier(.2,.9,.25,1)' });
  return true;
}

function programChart(el, p) {
  const s = programStats(p);
  // A live program with a planned end shows the whole plan, so the remaining runway is visible.
  const last = !p.endDate && p.planEnd && p.planEnd > s.end ? p.planEnd : s.end;
  const t0 = parseDay(p.startDate).getTime();
  const t1 = parseDay(last).getTime() + DAY;
  const inRange = state.logs.filter((l) => l.date >= p.startDate && l.date <= s.end);
  const entries = s.base && !inRange.includes(s.base) ? [s.base, ...inRange] : inRange;
  // Goal path: straight line from the starting weight to the target on the planned end date.
  const path = p.planEnd && p.target != null && s.base
    ? { t0, v0: s.base.weight, t1: parseDay(p.planEnd).getTime() + DAY, v1: p.target } : null;
  drawChart(el, {
    entries, inRange, t0, t1, color: `var(--${p.type})`, target: p.target, path, H: 130,
    ticks: [{ t: t0, label: fmtDate(p.startDate), anchor: 'start' },
      { t: t1, label: last === todayStr() && !p.endDate ? 'Today' : fmtDate(last), anchor: 'end' }],
  });
}
function drawProgramCharts(root = document) {
  root.querySelectorAll('.pchart[data-id]').forEach((el) => {
    const p = state.programs.find((x) => x.id === el.dataset.id);
    if (p && el.offsetParent) { programChart(el, p); bindChart(el); }
  });
}

/* Chart interaction: tap a point for its weight (tap again / elsewhere to hide);
   swipe sideways on the main chart to move between periods. */

function nearestPoint(el, clientX) {
  const pts = el._pts;
  if (!pts?.length) return -1;
  const x = clientX - el.getBoundingClientRect().left;
  let best = -1, dist = Infinity;
  pts.forEach((p, i) => { const d = Math.abs(p.x - x); if (d < dist) { dist = d; best = i; } });
  return best;
}

function showTip(el, i) {
  const p = el._pts?.[i];
  if (!p) return;
  el._tip = i;
  const mark = $('.cmark', el);
  mark.style.display = '';
  mark.querySelector('line').setAttribute('x1', p.x);
  mark.querySelector('line').setAttribute('x2', p.x);
  mark.querySelector('circle').setAttribute('cx', p.x);
  mark.querySelector('circle').setAttribute('cy', p.y);
  const tip = $('.tip', el);
  const multi = dayCount(p.e.date) > 1;
  tip.innerHTML = `<b>${fmt(p.e.weight)}</b> ${state.unit}<small>${fmtDate(p.e.date, { weekday: 'short', month: 'short', day: 'numeric' })}${multi && p.e.exact ? ` · ${timeOf(p.e)}` : ''}</small>`;
  tip.hidden = false;
  const svgTop = $('svg', el).getBoundingClientRect().top - el.getBoundingClientRect().top;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.max(6, Math.min(p.x - w / 2, el.clientWidth - w - 6));
  let top = svgTop + p.y - h - 14;
  if (top < 4) top = svgTop + p.y + 14; // no room above a peak: flip below
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip(el) {
  el._tip = -1;
  const tip = $('.tip', el);
  if (tip) tip.hidden = true;
  const mark = $('.cmark', el);
  if (mark) mark.style.display = 'none';
}

function bindChart(el, onSwipe = null) {
  if (el._bound) return;
  el._bound = true;
  let x0 = null, y0 = 0, dx = 0, swiping = false;
  const svg = () => $('svg', el);
  el.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; dx = 0; swiping = false; });
  el.addEventListener('pointermove', (e) => {
    if (x0 == null || !onSwipe) return;
    dx = e.clientX - x0;
    if (!swiping && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(e.clientY - y0)) {
      swiping = true;
      el.setPointerCapture?.(e.pointerId);
      hideTip(el);
    }
    if (swiping && svg()) svg().style.transform = `translateX(${dx * 0.5}px)`;
  });
  el.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    x0 = null;
    if (swiping) {
      swiping = false;
      const s = svg();
      if (!(Math.abs(dx) > 50 && onSwipe(dx > 0 ? -1 : 1)) && s) {
        s.animate([{ transform: s.style.transform }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
      }
      if (s) s.style.transform = '';
      return;
    }
    const i = nearestPoint(el, e.clientX);
    if (i < 0) return;
    if (i === el._tip) hideTip(el); else showTip(el, i);
  });
  el.addEventListener('pointercancel', () => { x0 = null; swiping = false; if (svg()) svg().style.transform = ''; });
}

document.addEventListener('pointerdown', (e) => {
  document.querySelectorAll('.chart').forEach((el) => { if (el._tip >= 0 && !el.contains(e.target)) hideTip(el); });
}, true);
addEventListener('scroll', () => document.querySelectorAll('.chart').forEach((el) => { if (el._tip >= 0) hideTip(el); }), { passive: true });

/* ---------------- rows + detail ---------------- */

function detailHTML(log) {
  const prev = prevEntry(log);
  const d = prev ? log.weight - prev.weight : null;
  const photos = log.photos || [];
  const prevLabel = prev ? (prev.date === log.date ? `Since ${timeOf(prev) || 'earlier'}` : `Since ${fmtDate(prev.date)}`) : 'First log';
  return `<div class="detail">
    <div class="detail-stats">
      <div><div class="stat-val">${fmt(log.weight)}<small>${state.unit}</small></div><div class="stat-label">Weight</div></div>
      <div><div class="stat-val ${tone(d, goalFor(log.date))}">${signed(d)}${d != null ? `<small>${state.unit}</small>` : ''}</div>
        <div class="stat-label">${prevLabel}</div></div>
    </div>
    ${photos.length ? `<div class="detail-photos">${photos.map((b, i) =>
      `<img src="${blobURL(b)}" alt="" data-act="photo" data-id="${log.id}" data-i="${i}">`).join('')}</div>` : ''}
    ${state.pick ? (log.id === state.pick.id
      ? '<div class="pick-note">This is the day you’re sharing</div>'
      : `<button class="pick-btn" data-act="pick" data-id="${log.id}">Compare with this day</button>`)
    : `<div class="detail-actions">
      <button data-act="edit" data-id="${log.id}">Edit</button>
      <button data-act="share-log" data-id="${log.id}">Share</button>
      <button class="danger" data-act="delete" data-id="${log.id}">Delete</button>
    </div>`}
  </div>`;
}

function entryRow(e, scope, title, sub) {
  const key = `${scope}:${e.id}`;
  const open = state.open.has(key);
  const prev = prevEntry(e);
  const src = state.pick?.id === e.id;
  return `<li class="row ${open ? 'open' : ''}" data-key="${key}" data-id="${e.id}">
    <div class="row-main" data-act="toggle">
      <div><div class="row-title">${title}${src ? '<span class="src-tag">Sharing</span>' : ''}</div><div class="row-sub">${sub}</div></div>
      <div class="row-right">${e.photos?.length ? `<span class="cam">${ICON.cam}</span>` : ''}
        <span class="row-weight">${fmt(e.weight)}</span>${prev ? chip(e.weight - prev.weight, goalFor(e.date)) : '<span class="chip flat">—</span>'}</div>
    </div>${open ? detailHTML(e) : ''}</li>`;
}

function emptyDayRow(date, title, sub, canAdd) {
  return `<li class="row empty ${canAdd ? '' : 'static'}" ${canAdd ? `data-act="log-day" data-date="${date}"` : ''}>
    <div class="row-main"><div><div class="row-title">${title}</div><div class="row-sub">${sub}</div></div>
    <div class="row-right">${canAdd ? '<span class="add-hint">+</span>' : ''}</div></div></li>`;
}

function renderHistory() {
  const has = state.logs.length > 0;
  $('#history-title').hidden = !has;
  $('#history').hidden = !has;
  const year = new Date().getFullYear();
  $('#history').innerHTML = [...state.logs].reverse().map((l) => {
    const d = parseDay(l.date);
    let sub = d.toLocaleDateString(undefined, d.getFullYear() === year ? { weekday: 'long' } : { weekday: 'short', year: 'numeric' });
    if (dayCount(l.date) > 1 && l.exact) sub += ` · ${timeOf(l)}`;
    return entryRow(l, 'h', fmtDate(l.date), sub);
  }).join('');
}

/* ---------------- programs ---------------- */

function programStats(p) {
  const end = p.endDate || todayStr();
  const inRange = state.logs.filter((l) => l.date >= p.startDate && l.date <= end);
  const base = dayFirst(p.startDate) || lastBefore(p.startDate) || inRange[0] || null;
  const cur = inRange.at(-1) || base;
  const days = Math.max(0, dayDiff(p.startDate, end) + 1);
  const change = base && cur ? cur.weight - base.weight : null;
  const span = base && cur ? dayDiff(base.date, cur.date) : 0;
  const rate = span >= 7 ? (change / span) * 7 : null;
  let progress = null;
  if (p.target != null && base && cur) {
    const total = p.target - base.weight;
    progress = total === 0 ? 1 : Math.max(0, Math.min(1, (cur.weight - base.weight) / total));
  }
  const total = p.planEnd ? dayDiff(p.startDate, p.planEnd) + 1 : null;
  return { end, base, cur, days, total, change, rate, progress };
}

function daysLeft(p) {
  const n = dayDiff(todayStr(), p.planEnd);
  return n <= 0 ? 'Last day' : `${n} day${n === 1 ? '' : 's'} left`;
}

function programCard(p, live) {
  const s = programStats(p);
  const v = (kg) => (kg == null ? '—' : fmt(kg));
  return `<div class="pcard ${p.type}">
    <div class="pcard-top"><span class="badge ${p.type}">${cap(p.type)}</span>
      <span class="pday">${live ? `Day ${s.days}${s.total ? ` of ${s.total}` : ''}` : `${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}`}</span></div>
    <div class="pcard-change"><span class="big2 ${tone(s.change, p.type)}">${signed(s.change)}</span><span class="unit">${state.unit}</span></div>
    <div class="chart pchart" data-id="${p.id}"></div>
    <div class="pcard-row">
      <div><div class="v">${v(s.base?.weight)}</div><div class="l">Start</div></div>
      <div><div class="v">${v(s.cur?.weight)}</div><div class="l">${live ? 'Now' : 'End'}</div></div>
      <div><div class="v">${v(p.target)}</div><div class="l">Target</div></div>
      <div><div class="v ${tone(s.rate, p.type)}">${signed(s.rate)}</div><div class="l">/ Week</div></div>
    </div>
    ${s.progress != null ? `<div class="bar"><span style="width:${(s.progress * 100).toFixed(1)}%"></span></div>` : ''}
    ${live && s.total ? `<div class="pcard-time"><span>${fmtDate(p.startDate)}</span><span>${daysLeft(p)}</span><span>${fmtDate(p.planEnd)}</span></div>
      <div class="bar time"><span style="width:${Math.min(100, (s.days / s.total) * 100).toFixed(1)}%"></span></div>` : ''}
    <div class="pcard-actions">
      <button class="ghost" data-act="share-program" data-id="${p.id}">Share</button>
      ${live
        ? `<button class="ghost" data-act="edit-program">Edit</button><button class="ghost" data-act="end-program">End</button>`
        : `<button class="ghost danger" data-act="delete-program" data-id="${p.id}">Delete</button>`}
    </div>
  </div>`;
}

function dayRows(p, scope, canAdd) {
  const n = programStats(p).days;
  let out = '';
  for (let i = n; i >= 1; i--) {
    const d = addDays(p.startDate, i - 1);
    const e = dayLast(d);
    const sub = fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' });
    const c = dayCount(d);
    out += e ? entryRow(e, scope, `Day ${i}`, c > 1 ? `${sub} · ${c} logs` : sub) : emptyDayRow(d, `Day ${i}`, sub, canAdd);
  }
  return out;
}

function renderPrograms() {
  const p = activeProgram();
  $('#program-active').innerHTML = p
    ? programCard(p, true) + `<h2 class="section-title">Days</h2><ul class="list">${dayRows(p, 'ap', true)}</ul>`
    : `<div class="start-grid">
        <button class="start-card cut" data-act="start" data-type="cut"><span class="start-ic">${ICON.down}</span><span class="start-t">Cut</span></button>
        <button class="start-card bulk" data-act="start" data-type="bulk"><span class="start-ic">${ICON.up}</span><span class="start-t">Bulk</span></button>
      </div>`;
  const past = state.programs.filter((x) => x.endDate);
  $('#past-title').hidden = !past.length;
  $('#program-past').hidden = !past.length;
  $('#program-past').innerHTML = past.map((x) => {
    const s = programStats(x);
    return `<li class="row" data-act="past" data-id="${x.id}"><div class="row-main">
      <div><div class="row-title"><span class="badge ${x.type}">${cap(x.type)}</span></div>
        <div class="row-sub">${fmtDate(x.startDate)} – ${fmtDate(x.endDate)} · ${s.days} days</div></div>
      <div class="row-right"><span class="row-weight ${tone(s.change, x.type)}">${signed(s.change)}</span><span class="chev">›</span></div>
    </div></li>`;
  }).join('');
  drawProgramCharts($('#program-active'));
}

/* ---------------- sheets ---------------- */

const sheet = $('#sheet');
function openSheet(html) {
  sheet.innerHTML = `<div class="grabber"></div>${html}`;
  sheet.scrollTop = 0;
  document.body.classList.add('sheet-open');
}
function closeSheet() { document.body.classList.remove('sheet-open'); }

function pickFiles(input, cb) {
  input.onchange = () => { const f = [...input.files]; input.value = ''; if (f.length) cb(f); };
  input.click();
}

async function compress(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.84))) || file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(src);
  }
}

// New entry (default), or edit an existing one with { id }.
function openLogSheet({ id = null, date = todayStr() } = {}) {
  const existing = id ? byId(id) : null;
  if (existing) date = existing.date;
  let photos = existing ? [...(existing.photos || [])] : [];
  let busy = 0;
  const ref = state.logs.at(-1);
  const hint = ref ? fmt(ref.weight) : '0.0';
  const step = state.unit === 'lb' ? 0.2 : 0.1;

  openSheet(`
    <div class="sheet-head">
      <button class="link" data-act="close">Cancel</button>
      <input type="date" class="date-pill" id="log-date" value="${date}" max="${todayStr()}">
      <span></span>
    </div>
    <div class="wi">
      <button class="step" data-d="-1" aria-label="Decrease">−</button>
      <div class="wi-field"><input id="log-w" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${existing ? fmt(existing.weight) : ''}" placeholder="${hint}"><span class="unit">${state.unit}</span></div>
      <button class="step" data-d="1" aria-label="Increase">+</button>
    </div>
    <div class="photos" id="log-photos"></div>
    <button class="primary" id="log-save">${existing ? 'Update' : 'Save'}</button>`);

  const input = $('#log-w', sheet);
  const strip = $('#log-photos', sheet);
  const dateIn = $('#log-date', sheet);
  input.onfocus = () => input.select();

  const draw = () => {
    strip.innerHTML =
      photos.map((b, i) => `<div class="thumb"><img src="${blobURL(b)}" alt=""><button data-rm="${i}" aria-label="Remove photo">×</button></div>`).join('') +
      '<div class="thumb busy"></div>'.repeat(busy) +
      (photos.length + busy < MAX_PHOTOS ? `<button class="thumb add" data-add aria-label="Add photo">${ICON.camBig}</button>` : '');
  };
  draw();

  strip.onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { photos.splice(+rm.dataset.rm, 1); draw(); return; }
    if (e.target.closest('[data-add]')) {
      pickFiles($('#file-input'), async (files) => {
        files = files.slice(0, MAX_PHOTOS - photos.length - busy);
        busy += files.length; draw();
        for (const f of files) { const b = await compress(f); busy--; photos.push(b); draw(); }
      });
    }
  };

  // Steppers start from the last weight shown as the placeholder.
  sheet.querySelectorAll('.step').forEach((b) => (b.onclick = () => {
    const v = parseFloat(input.value.replace(',', '.')) || parseFloat(input.placeholder) || 0;
    input.value = Math.max(0, Math.round((v + +b.dataset.d * step) * 10) / 10).toFixed(1);
  }));

  const save = async () => {
    const v = parseFloat(input.value.replace(',', '.'));
    if (!(v > 0 && v < 1500) || busy) {
      input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake');
      return;
    }
    const d = dateIn.value || todayStr();
    const when = existing && d === existing.date ? { time: existing.time, exact: existing.exact } : stamp(d);
    const entry = { ...(existing || { id: newId() }), date: d, ...when, weight: fromDisp(v), photos, updated: Date.now() };
    await put('entries', entry);
    navigator.vibrate?.(12);
    closeSheet();
    await load();
  };
  $('#log-save', sheet).onclick = save;
  input.onkeydown = (e) => { if (e.key === 'Enter') { input.blur(); save(); } };
}

// Start a new program, or edit the active one (`existing`). `planEnd` is the optional planned
// last day; once it has passed the program finishes on its own (see autoFinish).
function openProgramSheet(type, existing = null) {
  const start0 = existing?.startDate || todayStr();
  openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">${existing ? 'Edit program' : 'New program'}</div><span></span></div>
    <div class="seg" id="p-type"><button data-v="cut">Cut</button><button data-v="bulk">Bulk</button></div>
    <label class="field"><span>Target</span><span class="field-in"><input id="p-target" inputmode="decimal" placeholder="Optional" value="${existing?.target != null ? fmt(existing.target) : ''}"><em>${state.unit}</em></span></label>
    <label class="field"><span>Start</span><input type="date" id="p-start" value="${start0}" max="${todayStr()}"></label>
    <label class="field"><span>End</span><span class="date-opt"><input type="date" id="p-end" value="${existing?.planEnd || ''}" min="${addDays(start0, 1)}"><em>Optional</em></span></label>
    <p class="foot" id="p-len"></p>
    <button class="primary" id="p-go"></button>`);

  const go = $('#p-go', sheet), startIn = $('#p-start', sheet), endIn = $('#p-end', sheet), len = $('#p-len', sheet);
  const setType = (t) => {
    type = t;
    sheet.querySelectorAll('#p-type button').forEach((b) => (b.className = b.dataset.v === t ? `on ${t}` : ''));
    go.className = `primary ${t}`;
    go.textContent = existing ? 'Save' : `Start ${t}`;
  };
  // Show how long the plan is, and keep the end after the start.
  const syncEnd = () => {
    endIn.min = addDays(startIn.value || todayStr(), 1);
    endIn.parentElement.classList.toggle('empty', !endIn.value);
    const n = endIn.value ? dayDiff(startIn.value || todayStr(), endIn.value) + 1 : 0;
    len.textContent = n > 0 ? `${n} days · ${(n / 7).toFixed(n % 7 ? 1 : 0)} weeks` : '';
  };
  setType(type);
  syncEnd();
  startIn.onchange = endIn.onchange = endIn.oninput = syncEnd;
  $('#p-type', sheet).onclick = (e) => { const b = e.target.closest('button'); if (b) setType(b.dataset.v); };

  go.onclick = async () => {
    const raw = $('#p-target', sheet).value.trim().replace(',', '.');
    const t = raw ? parseFloat(raw) : null;
    if (raw && !(t > 0 && t < 1500)) { $('#p-target', sheet).classList.add('shake'); return; }
    const startDate = startIn.value || todayStr();
    const planEnd = endIn.value || null;
    if (planEnd && planEnd <= startDate) { endIn.closest('.field').classList.add('shake'); return; }
    await put('programs', {
      ...(existing || { id: Date.now().toString(36), endDate: null }),
      type, startDate, planEnd, target: t == null ? null : fromDisp(t),
    });
    closeSheet();
    await load();
  };
}

function openPastSheet(id) {
  const p = state.programs.find((x) => x.id === id);
  if (!p) return;
  openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Close</button><div class="sheet-title">${cap(p.type)}</div><span></span></div>
    ${programCard(p, false)}
    <ul class="list">${dayRows(p, 'pp', false)}</ul>`);
  drawProgramCharts(sheet);
}

function openSettings() {
  openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Done</button><div class="sheet-title">Settings</div><span></span></div>
    <div class="seg" id="unit-seg"><button data-v="lb">lb</button><button data-v="kg">kg</button></div>
    <button class="secondary" data-act="export" style="margin-top:14px">Export backup</button>
    <button class="secondary" data-act="import">Import backup</button>
    <p class="foot">Data is stored only on this device.</p>`);
  const seg = $('#unit-seg', sheet);
  const mark = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.unit));
  mark();
  seg.onclick = (e) => { const b = e.target.closest('button'); if (b) { setUnit(b.dataset.v); mark(); } };
}

/* ---------------- share image ---------------- */

const C = {
  bg: '#0a0a0d', surface: '#141419', surface2: '#1d1d24', text: '#f4f4f6', muted: '#8b8b98', dim: '#55555f',
  accent: '#c8f03c', good: '#4ade80', bad: '#fb7185', cut: '#38bdf8', bulk: '#fb923c',
};
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif';
const toneColor = (t) => (t === 'good' ? C.good : t === 'bad' ? C.bad : C.text);
const hexA = (h, a) => `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${a})`;

async function drawPhoto(x, blob, X, Y, W, H, R) {
  const bmp = await createImageBitmap(blob);
  const s = Math.max(W / bmp.width, H / bmp.height);
  const sw = W / s, sh = H / s;
  x.save();
  x.beginPath(); x.roundRect(X, Y, W, H, R); x.clip();
  x.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, X, Y, W, H);
  x.restore();
  bmp.close?.();
}

function pill(x, text, X, bottom) {
  x.font = `600 28px ${FONT}`;
  const w = x.measureText(text).width + 36;
  x.fillStyle = 'rgba(0,0,0,.6)';
  x.beginPath(); x.roundRect(X, bottom - 52, w, 52, 26); x.fill();
  x.fillStyle = '#fff';
  x.fillText(text, X + 18, bottom - 16);
}

function drawCardChart(x, logs, X, Y, W, H, color) {
  const P = 56, LABEL = 110;
  const ts = logs.map((l) => l.time);
  const ws = logs.map((l) => toDisp(l.weight));
  let lo = Math.min(...ws), hi = Math.max(...ws);
  if (hi - lo < 1) { const m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
  const t0 = ts[0], t1 = ts.at(-1);
  const px = (t) => X + P + ((t - t0) / (t1 - t0 || 1)) * (W - P * 2 - LABEL);
  const py = (v) => Y + P + ((hi - v) / (hi - lo)) * (H - P * 2);
  const pts = ts.map((t, i) => [px(t), py(ws[i])]);
  const g = x.createLinearGradient(0, Y, 0, Y + H);
  g.addColorStop(0, hexA(color, 0.28)); g.addColorStop(1, hexA(color, 0));
  x.beginPath();
  pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b)));
  x.lineTo(pts.at(-1)[0], Y + H - 2); x.lineTo(pts[0][0], Y + H - 2); x.closePath();
  x.fillStyle = g; x.fill();
  x.beginPath();
  pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b)));
  x.strokeStyle = color; x.lineWidth = 6; x.lineJoin = x.lineCap = 'round'; x.stroke();
  const [lx, ly] = pts.at(-1);
  x.fillStyle = hexA(color, 0.2); x.beginPath(); x.arc(lx, ly, 22, 0, 7); x.fill();
  x.fillStyle = color; x.beginPath(); x.arc(lx, ly, 11, 0, 7); x.fill();
  x.font = `600 28px ${FONT}`; x.fillStyle = C.dim; x.textAlign = 'right';
  x.fillText(hi.toFixed(1), X + W - 36, Y + P + 10);
  x.fillText(lo.toFixed(1), X + W - 36, Y + H - P + 10);
  x.textAlign = 'left';
}

// 1080×1350 (4:5) — fits Instagram / Stories / Messages without cropping.
async function renderCard(o) {
  const W = 1080, H = 1350, P = 72;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(W * 0.9, H, 0, W * 0.9, H, 760);
  glow.addColorStop(0, hexA(o.accent, 0.14)); glow.addColorStop(1, hexA(o.accent, 0));
  x.fillStyle = glow; x.fillRect(0, 0, W, H);

  x.font = `700 34px ${FONT}`;
  x.fillStyle = o.kickerColor || C.muted;
  let kx = P;
  if (o.dot) { x.beginPath(); x.arc(P + 9, 95, 9, 0, 7); x.fill(); kx += 30; }
  x.fillText(o.kicker, kx, 107);
  x.font = `600 30px ${FONT}`; x.fillStyle = C.dim; x.textAlign = 'right';
  x.fillText('Weigh-In', W - P, 107);
  x.textAlign = 'left';

  const top = 150, mh = 700, mw = W - P * 2;
  if (o.photos.length) {
    const gap = 16, n = o.photos.length, pw = (mw - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const px = P + i * (pw + gap), ph = o.photos[i];
      if (ph.blob) {
        await drawPhoto(x, ph.blob, px, top, pw, mh, 36);
      } else {
        x.fillStyle = C.surface; x.beginPath(); x.roundRect(px, top, pw, mh, 36); x.fill();
        x.font = `600 30px ${FONT}`; x.fillStyle = C.dim; x.textAlign = 'center';
        x.fillText('No photo', px + pw / 2, top + mh / 2);
        x.textAlign = 'left';
      }
      if (ph.tag) pill(x, ph.tag, px + 20, top + 72);
      if (ph.label) pill(x, ph.label, px + 20, top + mh - 20);
    }
  } else {
    x.fillStyle = C.surface; x.beginPath(); x.roundRect(P, top, mw, mh, 36); x.fill();
    if (o.chart.length >= 2) drawCardChart(x, o.chart, P, top, mw, mh, o.accent);
  }

  x.font = `800 180px ${FONT}`; x.fillStyle = o.headColor || C.text;
  x.fillText(o.head, P - 6, 1040);
  const hw = x.measureText(o.head).width;
  x.font = `600 52px ${FONT}`; x.fillStyle = C.muted;
  x.fillText(state.unit, P + hw + 12, 1040);
  x.font = `600 38px ${FONT}`; x.fillStyle = o.subColor || C.muted;
  x.fillText(o.sub, P, 1100);

  x.fillStyle = C.surface2; x.fillRect(P, 1140, W - P * 2, 2);
  const cw = (W - P * 2) / o.stats.length;
  o.stats.forEach(([v, label, col], i) => {
    const sx = P + i * cw;
    x.font = `700 54px ${FONT}`; x.fillStyle = col || C.text; x.fillText(v, sx, 1218);
    x.font = `600 26px ${FONT}`; x.fillStyle = C.muted; x.fillText(label.toUpperCase(), sx, 1260);
  });

  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
}

function logCard(id, withPhotos) {
  const log = byId(id);
  const prev = prevEntry(log);
  const d = prev ? log.weight - prev.weight : null;
  const goal = goalFor(log.date);
  const ph = (log.photos || []).slice(0, 2);
  const col = (v) => toneColor(tone(v, goal));
  return {
    hasPhotos: ph.length > 0,
    accent: goal ? C[goal] : C.accent,
    kicker: fmtDate(log.date, { weekday: 'long', month: 'long', day: 'numeric' }),
    head: fmt(log.weight),
    sub: prev ? `${signed(d)} ${state.unit} since ${prev.date === log.date ? timeOf(prev) || 'earlier' : fmtDate(prev.date)}` : 'First weigh-in',
    subColor: prev ? col(d) : C.muted,
    photos: withPhotos ? ph.map((blob) => ({ blob })) : [],
    chart: state.logs.filter((l) => byOrder(l, log) <= 0).slice(-60),
    stats: [['Since last', d], ['Week', changeOver(7, log)], ['Month', changeOver(30, log)], ['Total', log.weight - state.logs[0].weight]]
      .map(([l, v]) => [signed(v), l, col(v)]),
  };
}

// Two chosen entries side by side; order is always older → newer.
function compareCard(idA, idB, withPhotos) {
  const [a, b] = [byId(idA), byId(idB)].sort(byOrder);
  const goal = goalFor(b.date);
  const d = b.weight - a.weight;
  const days = dayDiff(a.date, b.date);
  const rate = days >= 7 ? (d / days) * 7 : null;
  const yr = a.date.slice(0, 4) !== b.date.slice(0, 4) ? { month: 'short', day: 'numeric', year: 'numeric' } : undefined;
  const side = (l, tag) => ({ blob: l.photos?.[0] || null, tag, label: `${fmtDate(l.date, yr)} · ${fmt(l.weight)}` });
  const hasPhotos = !!(a.photos?.length || b.photos?.length);
  const col = (v) => toneColor(tone(v, goal));
  return {
    hasPhotos,
    accent: goal ? C[goal] : C.accent, dot: true, kicker: 'COMPARE', kickerColor: goal ? C[goal] : C.accent,
    head: signed(d), headColor: col(d),
    sub: `${fmtDate(a.date, yr)} → ${fmtDate(b.date, yr)} · ${days} day${days === 1 ? '' : 's'}`,
    photos: withPhotos && hasPhotos ? [side(a, 'Before'), side(b, 'After')] : [],
    chart: state.logs.filter((l) => byOrder(l, a) >= 0 && byOrder(l, b) <= 0),
    stats: [[fmt(a.weight), 'Before'], [fmt(b.weight), 'After'], [String(days), 'Days'], [signed(rate), 'Per week', col(rate)]],
  };
}

function beforeAfter(logs, label) {
  const wp = logs.filter((l) => l.photos?.length);
  const a = wp[0], b = wp.at(-1);
  return (a ? (a !== b ? [a, b] : [a]) : []).map((l) => ({ blob: l.photos[0], label: label(l) }));
}

function programCardImg(id, withPhotos) {
  const p = state.programs.find((x) => x.id === id);
  const s = programStats(p);
  const logs = state.logs.filter((l) => l.date >= p.startDate && l.date <= s.end);
  const ph = beforeAfter(logs, (l) => `Day ${dayDiff(p.startDate, l.date) + 1} · ${fmt(l.weight)}`);
  const v = (kg) => (kg == null ? '—' : fmt(kg));
  return {
    hasPhotos: ph.length > 0,
    accent: C[p.type], dot: true, kicker: p.type.toUpperCase(), kickerColor: C[p.type],
    head: signed(s.change), headColor: toneColor(tone(s.change, p.type)),
    sub: !p.endDate && s.total
      ? `Day ${s.days} of ${s.total} · ${fmtDate(p.startDate)} – ${fmtDate(p.planEnd)}`
      : `${s.days} days · ${fmtDate(p.startDate)} – ${p.endDate ? fmtDate(p.endDate) : 'today'}`,
    photos: withPhotos ? ph : [],
    chart: s.base && !logs.includes(s.base) ? [s.base, ...logs] : logs,
    stats: [[v(s.base?.weight), 'Start'], [v(s.cur?.weight), p.endDate ? 'End' : 'Now'], [v(p.target), 'Target'],
      [signed(s.rate), 'Per week', toneColor(tone(s.rate, p.type))]],
  };
}

function overallCard(withPhotos) {
  const L = state.logs, first = L[0], last = L.at(-1);
  const goal = activeProgram()?.type || null;
  const total = last.weight - first.weight;
  const ph = beforeAfter(L, (l) => `${fmtDate(l.date)} · ${fmt(l.weight)}`);
  const col = (d) => toneColor(tone(d, goal));
  return {
    hasPhotos: ph.length > 0,
    accent: C.accent, dot: true, kicker: 'PROGRESS', kickerColor: C.accent,
    head: signed(total), headColor: col(total),
    sub: `${fmtDate(first.date)} – ${fmtDate(last.date)} · ${L.length} weigh-ins`,
    photos: withPhotos ? ph : [],
    chart: L.slice(-90),
    stats: [[fmt(first.weight), 'Start'], [fmt(last.weight), 'Now'],
      [signed(changeOver(7)), 'Week', col(changeOver(7))], [signed(changeOver(30)), 'Month', col(changeOver(30))]],
  };
}

function downloadFile(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Build the image first and show it; the Share tap then calls navigator.share
// synchronously, which iOS requires (it rejects shares after async work).
// `compare` (optional): { id, others } adds a Compare mode; `init` restores state after picking.
function openShareSheet(build, compare = null, init = {}) {
  let withPhotos = init.withPhotos ?? true, file = null, token = 0, shown = null;
  let kind = init.kind || 'day';
  const others = compare?.others || [];
  let other = init.other || (others.find((l) => l.photos?.length) || others[0])?.id;
  const otherLabel = () => { const l = byId(other); return `${fmtDate(l.date)} · ${fmt(l.weight)}`; };
  const on = (cond) => (cond ? 'class="on"' : '');
  openSheet(`
    <div class="sheet-head"><button class="link" data-act="close">Cancel</button><div class="sheet-title">Share</div><span></span></div>
    ${others.length ? `<div class="seg" id="sh-kind"><button data-v="day" ${on(kind === 'day')}>This day</button><button data-v="compare" ${on(kind === 'compare')}>Compare</button></div>
    <button class="field field-btn" id="sh-cmp" ${kind === 'compare' ? '' : 'hidden'}><span>Compare to</span>
      <span class="field-in"><b>${otherLabel()}</b><em class="chev">›</em></span></button>` : ''}
    <div class="seg" id="sh-mode" hidden><button data-v="1" ${on(withPhotos)}>With photos</button><button data-v="0" ${on(!withPhotos)}>Stats only</button></div>
    <div class="share-preview loading" id="sh-prev"></div>
    <button class="primary" id="sh-go" disabled>Share or save</button>`);
  const prev = $('#sh-prev', sheet), go = $('#sh-go', sheet), mode = $('#sh-mode', sheet);

  if (others.length) {
    const kindSeg = $('#sh-kind', sheet), cmp = $('#sh-cmp', sheet);
    kindSeg.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.v === kind) return;
      kind = b.dataset.v;
      kindSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      cmp.hidden = kind !== 'compare';
      draw();
    };
    // Browse the real front page to choose the other day, then come back here.
    cmp.onclick = () => enterPick(compare.id, (picked) =>
      openShareSheet(build, compare, { kind: 'compare', other: picked || other, withPhotos }));
  }

  const draw = async () => {
    const t = ++token;
    go.disabled = true; prev.classList.add('loading');
    const o = kind === 'compare' ? compareCard(compare.id, other, withPhotos) : build(withPhotos);
    mode.hidden = !o.hasPhotos;
    const blob = await renderCard(o);
    if (t !== token) return;
    file = new File([blob], `weigh-in-${todayStr()}.jpg`, { type: 'image/jpeg' });
    if (shown) URL.revokeObjectURL(shown);
    shown = URL.createObjectURL(blob);
    prev.innerHTML = `<img src="${shown}" alt="Progress image">`;
    prev.classList.remove('loading'); go.disabled = false;
  };
  mode.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || +b.dataset.v === +withPhotos) return;
    withPhotos = b.dataset.v === '1';
    mode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };
  go.onclick = () => {
    if (!file) return;
    if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
    else downloadFile(file);
  };
  draw();
}

/* ---------------- pick mode: choose a day from the front page ---------------- */

function enterPick(id, onDone) {
  state.pick = { id, onDone, prevView: $('.tab.active').dataset.view, scroll: scrollY };
  closeSheet();
  state.open.clear();
  document.body.classList.add('picking');
  $('#pick-title').textContent = `Compare with ${fmtDate(byId(id).date)}`;
  setView('log');
  render();
  scrollTo(0, 0);
}

function exitPick(picked) {
  const p = state.pick;
  if (!p) return;
  state.pick = null;
  state.open.clear();
  document.body.classList.remove('picking');
  setView(p.prevView);
  render();
  scrollTo(0, p.scroll);
  p.onDone(picked);
}

/* ---------------- photo viewer ---------------- */

const viewer = $('#viewer');
function openViewer(blobs, i) {
  viewer.innerHTML = `<button class="viewer-close" aria-label="Close">×</button>
    <div class="viewer-track">${blobs.map((b) => `<img src="${blobURL(b)}" alt="">`).join('')}</div>
    ${blobs.length > 1 ? `<div class="viewer-count">${i + 1} / ${blobs.length}</div>` : ''}`;
  viewer.classList.add('open');
  const track = $('.viewer-track', viewer);
  track.scrollLeft = i * track.clientWidth;
  const count = $('.viewer-count', viewer);
  if (count) track.onscroll = () => { count.textContent = `${Math.round(track.scrollLeft / track.clientWidth) + 1} / ${blobs.length}`; };
}
viewer.onclick = (e) => { if (e.target.tagName !== 'IMG' || e.target.closest('.viewer-close')) viewer.classList.remove('open'); };

/* ---------------- backup ---------------- */

const toDataURL = (b) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });

async function exportData() {
  const logs = await Promise.all(state.logs.map(async (l) => ({ ...l, photos: await Promise.all((l.photos || []).map(toDataURL)) })));
  const data = { app: 'weigh-in', version: 2, exported: new Date().toISOString(), logs, programs: state.programs };
  const file = new File([JSON.stringify(data)], `weigh-in-${todayStr()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadFile(file);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.logs)) throw new Error('Not a Weigh-In backup');
    for (const l of data.logs) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date) || !(l.weight > 0)) continue;
      const photos = await Promise.all((l.photos || []).map((u) => fetch(u).then((r) => r.blob())));
      const m = migrated(l);
      await put('entries', { id: m.id, date: m.date, time: m.time, exact: m.exact, weight: m.weight, photos, updated: m.updated || Date.now() });
    }
    for (const p of data.programs || []) if (p.id && p.type && p.startDate) await put('programs', p);
    closeSheet();
    await load();
    alert(`Imported ${data.logs.length} logs.`);
  } catch (e) {
    alert(`Import failed: ${e.message}`);
  }
}

/* ---------------- events ---------------- */

function setView(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'log') renderChart();
  else drawProgramCharts($('#program-active'));
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { setView(t.dataset.view); scrollTo(0, 0); }));

$('#range-seg').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === state.range) return;
  state.range = b.dataset.v;
  state.offset = 0;
  savePref('range', state.range);
  renderChart();
};
bindChart($('#chart'), shiftPeriod);

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { id, date } = el.dataset;
  switch (el.dataset.act) {
    case 'log': openLogSheet(); break;
    case 'log-day': openLogSheet({ date }); break;
    case 'edit': openLogSheet({ id }); break;
    case 'close': closeSheet(); break;
    case 'settings': openSettings(); break;
    case 'unit': setUnit(state.unit === 'lb' ? 'kg' : 'lb'); break;
    case 'chart-prev': shiftPeriod(-1); break;
    case 'chart-next': shiftPeriod(1); break;
    case 'toggle': {
      const li = el.closest('li');
      const key = li.dataset.key;
      if (state.open.has(key)) {
        state.open.delete(key);
        li.classList.remove('open');
        li.querySelector('.detail')?.remove();
      } else {
        state.open.add(key);
        li.classList.add('open');
        li.insertAdjacentHTML('beforeend', detailHTML(byId(li.dataset.id)));
      }
      break;
    }
    case 'photo': openViewer(byId(id).photos, +el.dataset.i); break;
    case 'delete':
      if (confirm(`Delete this ${fmtDate(byId(id).date)} log?`)) { await del('entries', id); closeSheet(); await load(); }
      break;
    case 'start': openProgramSheet(el.dataset.type); break;
    case 'edit-program': { const p = activeProgram(); if (p) openProgramSheet(p.type, p); break; }
    case 'end-program': {
      const p = activeProgram();
      if (p && confirm(`End this ${p.type}?`)) {
        await put('programs', { ...p, endDate: p.startDate > todayStr() ? p.startDate : todayStr() });
        await load();
      }
      break;
    }
    case 'past': openPastSheet(id); break;
    case 'delete-program':
      if (confirm('Delete this program? Your weight logs are kept.')) { await del('programs', id); closeSheet(); await load(); }
      break;
    case 'share-log':
      openShareSheet((w) => logCard(id, w), { id, others: state.logs.filter((l) => l.id !== id) });
      break;
    case 'share-program': openShareSheet((w) => programCardImg(id, w)); break;
    case 'share-all': if (state.logs.length) openShareSheet(overallCard); break;
    case 'pick': exitPick(id); break;
    case 'pick-cancel': exitPick(null); break;
    case 'export': exportData(); break;
    case 'import': pickFiles($('#import-input'), (f) => importData(f[0])); break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (viewer.classList.contains('open')) viewer.classList.remove('open');
    else if (state.pick && !document.body.classList.contains('sheet-open')) exitPick(null);
    else closeSheet();
  }
});

let rz;
addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => { renderChart(); drawProgramCharts(); }, 120);
});
// Re-render when the app comes back to the foreground on a new day.
// (load, not just render, so a program whose end date passed overnight finishes.)
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

/* ---------------- native feel ---------------- */

// iOS ignores user-scalable=no, so block pinch-zoom gestures directly.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
// No long-press / right-click menus or image dragging (inputs keep theirs for paste).
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });
document.addEventListener('dragstart', (e) => e.preventDefault());

/* ---------------- boot ---------------- */

navigator.storage?.persist?.();
setupUpdates();
load();

// Updates: an installed iPhone app is usually resumed, not reloaded, so check for a new version
// each time it comes to the foreground, and reload into it once it takes over. The reload waits
// until no sheet or day-picker is open, so a half-typed weigh-in is never lost.
function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing old to replace
    reloading = true;
    const busy = () => document.body.classList.contains('sheet-open') || state.pick || viewer.classList.contains('open');
    const go = () => (busy() ? setTimeout(go, 1000) : location.reload());
    go();
  });
}
