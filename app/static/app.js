/* Garden Tracker front end - plain JS, no build step, no external requests. */
'use strict';

// ====================================================================
// Utilities
// ====================================================================
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const CURRENT_YEAR = new Date().getFullYear();
const DAY = 864e5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNITS = ['lb', 'oz', 'kg', 'g', 'count', 'bunch'];
const TO_LB = { lb: 1, oz: 1 / 16, kg: 2.20462, g: 0.00220462 };
// Categorical palette (validated order) - used for year-vs-year series.
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 4500 : 2200);
}

function fmt(n, digits = 2) {
  if (n == null || !isFinite(n)) return '–';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function fmtCompact(n) {
  if (Math.abs(n) >= 1e4) return (n / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
  return fmt(n, n < 10 ? 2 : 1);
}

const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const isoDate = t => new Date(t).toISOString().slice(0, 10);
const shortDate = t => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const longDate = t => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
// Map any date onto a common (non-leap) reference year for season-vs-season comparison.
const toRefYear = s => { const [, m, d] = s.split('-').map(Number); return Date.UTC(2001, m - 1, d); }; // Feb 29 -> Mar 1
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const measureOf = unit => (unit in TO_LB ? 'weight' : unit);
const MEASURE_LABEL = { weight: 'Weight (lb)', count: 'Count', bunch: 'Bunches' };
const MEASURE_UNIT = { weight: 'lb', count: 'count', bunch: 'bunch' };
const measureValue = (amount, unit) => (unit in TO_LB ? amount * TO_LB[unit] : amount);

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(v => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#111' : '#fff';
}

function niceTicks(max, count = 5) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.0001; v += step) ticks.push(+v.toFixed(10));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(10));
  return ticks;
}

function timeTicks(t0, t1) {
  const span = (t1 - t0) / DAY;
  const ticks = [];
  if (span <= 50) {
    const step = span <= 14 ? 2 : 7;
    for (let t = t0; t <= t1; t += step * DAY) ticks.push({ t, label: shortDate(t) });
    return ticks;
  }
  const d = new Date(t0);
  let y = d.getUTCFullYear(), m = d.getUTCMonth() + (d.getUTCDate() > 1 ? 1 : 0);
  for (;;) {
    const t = Date.UTC(y, m, 1);
    if (t > t1) break;
    ticks.push({ t, label: MONTHS[new Date(t).getUTCMonth()] });
    m++;
  }
  return ticks;
}

function confirmDialog(title, text, yesLabel = 'Delete') {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yesLabel;
  dlg.showModal();
  return new Promise(resolve => {
    const done = v => { dlg.close(); $('#confirm-yes').onclick = $('#confirm-no').onclick = null; resolve(v); };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
    dlg.oncancel = () => done(false);
  });
}

// ---------- tooltip ----------
const tipEl = $('#tooltip');
function showTip(html, e) {
  tipEl.innerHTML = html;
  tipEl.hidden = false;
  const pad = 14, r = tipEl.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tipEl.style.left = Math.max(8, x) + 'px';
  tipEl.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => { tipEl.hidden = true; };
const tipRow = (color, label, value) =>
  `<div class="t-row">${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${esc(label)}<span class="v">${esc(value)}</span></div>`;

// ====================================================================
// App state & routing
// ====================================================================
const state = {
  crops: [],
  cropById: new Map(),
  plans: [],
  view: null,
};

async function loadCrops() {
  state.crops = await api('GET', '/api/crops');
  state.cropById = new Map(state.crops.map(c => [c.id, c]));
}

async function createCrop(name, extra = {}) {
  const crop = await api('POST', '/api/crops', { name, ...extra });
  await loadCrops();
  return crop;
}

function route() {
  const [view = 'planner', arg] = location.hash.replace(/^#\/?/, '').split('/');
  showView(['planner', 'harvest', 'crops'].includes(view) ? view : 'planner', arg);
}

async function showView(view, arg) {
  if (state.view === 'planner' && view !== 'planner') await planner.flush();
  state.view = view;
  $$('#main-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  ['planner', 'harvest', 'crops'].forEach(v => { $(`#view-${v}`).hidden = v !== view; });
  hideTip();
  try {
    if (view === 'planner') await planner.show(arg);
    else if (view === 'harvest') await harvest.show(arg);
    else await cropsView.show();
  } catch (err) {
    toast(err.message, true);
  }
}

$('#main-nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (b) location.hash = '#' + b.dataset.view;
});
addEventListener('hashchange', route);

// ====================================================================
// Garden planner
// ====================================================================
const planner = (() => {
  const KEY = (x, y) => x + y * 1024;
  let RULER_L = 30, RULER_T = 20; // recomputed in draw() from the text size
  const canvas = $('#plan-canvas');
  const ctx = canvas.getContext('2d');
  let plan = null;              // current plan metadata
  let cells = new Map();        // KEY -> crop id
  let notes = new Map();        // KEY -> {variety, rating, note} (only for planted squares)
  let groups = new Map();       // KEY -> label block id; absent/0 = merge with touching same-crop squares
  let selected = null;          // {x, y} square open in the notes panel
  let noteEditOpen = false;     // an undo snapshot was already taken for the current note edit
  let tool = 0;                 // crop id, 0 = eraser
  let mode = 'brush';
  let zoom = 34;
  let undoStack = [], redoStack = [];
  let saveTimer = null, savePromise = null, dirty = false;
  let drag = null;              // active pointer interaction

  let textSize = 14;            // planner text size in px (UI + labels on the grid)
  let panelMoved = null;        // {left, top} once the notes overlay has been dragged

  try {
    zoom = +localStorage.getItem('gt-zoom') || 34;
    textSize = +localStorage.getItem('gt-text') || 14;
  } catch { /* storage unavailable */ }
  $('#plan-zoom').value = zoom;
  $('#plan-text').value = textSize;
  const applyTextSize = () => $('#view-planner').style.setProperty('--planner-text', textSize + 'px');
  applyTextSize();
  const labelFont = () => Math.round(textSize * 0.86);
  const rulerFont = () => Math.max(9, Math.round(textSize * 0.75));

  function setStatus(s) { $('#save-status').textContent = s; }

  async function show(arg) {
    [state.plans] = await Promise.all([api('GET', '/api/plans'), loadCrops()]);
    if (!state.plans.length) {
      plan = null;
      renderTabs();
      $('#planner-empty').hidden = false;
      $('#planner-body').hidden = true;
      return;
    }
    $('#planner-empty').hidden = true;
    $('#planner-body').hidden = false;
    let id = +arg;
    if (!state.plans.some(p => p.id === id)) id = state.plans[0].id;
    if (!plan || plan.id !== id) await open(id);
    else { renderTabs(); renderPalette(); draw(); }
  }

  async function open(id) {
    await flush();
    const p = await api('GET', `/api/plans/${id}`);
    plan = p;
    cells = new Map(p.cells.map(([x, y, c]) => [KEY(x, y), c]));
    notes = new Map();
    groups = new Map();
    for (const [x, y, , variety, rating, note, grp] of p.cells) {
      if (variety || rating || note) notes.set(KEY(x, y), { variety, rating, note });
      if (grp) groups.set(KEY(x, y), grp);
    }
    undoStack = []; redoStack = [];
    selected = null;
    $('#plan-name').value = p.name;
    $('#plan-year').value = p.year;
    $('#plan-width').value = p.width;
    $('#plan-height').value = p.height;
    $('#plan-notes').value = p.notes;
    setStatus('');
    if (tool && !state.cropById.has(tool)) tool = 0;
    if (!tool && state.crops.length) tool = state.crops[0].id;
    if (location.hash !== `#planner/${id}`) history.replaceState(null, '', `#planner/${id}`);
    renderTabs(); renderPalette(); renderSquarePanel(); draw();
  }

  function renderTabs() {
    const el = $('#plan-tabs');
    el.innerHTML = state.plans.map(p =>
      `<button data-id="${p.id}" class="${plan && plan.id === p.id ? 'active' : ''}">${esc(p.name)}<span class="sub">${p.year} · ${p.width}×${p.height} ft</span></button>`
    ).join('') + `<button class="add" data-new="1">+ New plan</button>`;
  }

  $('#plan-tabs').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.new) newPlanDialog();
    else location.hash = `#planner/${b.dataset.id}`;
  });
  $('#planner-empty-new').addEventListener('click', () => newPlanDialog());

  // ---------- new plan dialog ----------
  function newPlanDialog() {
    const dlg = $('#plan-dialog');
    const years = state.plans.map(p => p.year);
    const year = years.includes(CURRENT_YEAR) ? Math.max(...years) + 1 : CURRENT_YEAR;
    $('#np-year').value = year;
    $('#np-name').value = `${year} Garden`;
    const src = state.plans[0];
    $('#np-copy').innerHTML = `<option value="">Blank garden</option>` + state.plans.map(p =>
      `<option value="${p.id}">Copy of “${esc(p.name)}” (${p.year})</option>`).join('');
    $('#np-copy').value = src ? src.id : '';
    $('#np-width').value = src ? src.width : 10;
    $('#np-height').value = src ? src.height : 10;
    dlg.showModal();
  }
  $('#np-copy').addEventListener('change', e => {
    const src = state.plans.find(p => p.id === +e.target.value);
    if (src) { $('#np-width').value = src.width; $('#np-height').value = src.height; }
  });
  $('#np-year').addEventListener('input', e => {
    const n = $('#np-name');
    if (/^\d{4} Garden$/.test(n.value)) n.value = `${e.target.value} Garden`;
  });
  $('#np-cancel').addEventListener('click', () => $('#plan-dialog').close());
  $('#plan-dialog-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const p = await api('POST', '/api/plans', {
        name: $('#np-name').value, year: +$('#np-year').value,
        width: +$('#np-width').value, height: +$('#np-height').value,
        copy_from: $('#np-copy').value ? +$('#np-copy').value : null,
      });
      $('#plan-dialog').close();
      state.plans = await api('GET', '/api/plans');
      plan = null;
      location.hash = `#planner/${p.id}`; // hashchange opens it
    } catch (err) { toast(err.message, true); }
  });

  // ---------- palette ----------
  function counts() {
    const m = new Map();
    for (const c of cells.values()) m.set(c, (m.get(c) || 0) + 1);
    return m;
  }

  function renderPalette() {
    const n = counts();
    $('#palette-list').innerHTML =
      `<button class="crop-chip ${tool === 0 ? 'selected' : ''}" data-tool="0"><span class="dot eraser"></span><span class="name">Eraser (empty)</span></button>` +
      state.crops.map(c => `<button class="crop-chip ${tool === c.id ? 'selected' : ''}" data-tool="${c.id}">
        <span class="dot" style="background:${c.color}"></span><span class="name">${esc(c.name)}</span>
        <span class="count">${n.get(c.id) ? n.get(c.id) + ' ft²' : ''}</span></button>`).join('');
    $$('.palette .tools .btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    renderSummary(n);
    renderPlantNotes();
  }

  function renderSummary(n = counts()) {
    if (!plan) return;
    const total = plan.width * plan.height;
    const used = cells.size;
    const parts = [...n.entries()]
      .map(([id, k]) => [state.cropById.get(id), k]).filter(([c]) => c)
      .sort((a, b) => b[1] - a[1])
      .map(([c, k]) => `<span><span class="swatch" style="background:${c.color}"></span>${esc(c.name)} ${k} ft²</span>`);
    $('#plan-summary').innerHTML =
      `<span><b>${used}</b> of ${total} ft² planted</span>` + parts.join('');
  }

  $('#palette-list').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    tool = +b.dataset.tool;
    if (mode !== 'brush' && mode !== 'rect') mode = 'brush'; // picking a plant means you want to paint
    renderPalette();
  });
  function setMode(m) {
    mode = m;
    if (m !== 'select' && selected) closePanel();
    renderPalette();
  }
  $$('.palette .tools .btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------- per-square notes ----------
  const RATINGS = { 1: '👍 Liked', 2: '😐 Okay', '-1': "👎 Didn't like" };
  const snapshot = () => ({ cells: new Map(cells), notes: new Map(notes), groups: new Map(groups) });
  const groupOf = k => groups.get(k) || 0;

  function selectSquare(x, y) {
    selected = { x, y };
    noteEditOpen = false;
    renderSquarePanel();
    draw();
  }

  function noteAt(k) { return notes.get(k) || { variety: '', rating: 0, note: '' }; }

  // Squares in the same labeled block as (x, y): touching, same crop, same block id.
  function connectedSquares(x, y) {
    const crop = cells.get(KEY(x, y)), grp = groupOf(KEY(x, y));
    const seen = new Set([KEY(x, y)]), stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        const k = KEY(nx, ny);
        if (nx < 0 || ny < 0 || nx >= plan.width || ny >= plan.height || seen.has(k) ||
            cells.get(k) !== crop || groupOf(k) !== grp) continue;
        seen.add(k); stack.push([nx, ny]);
      }
    }
    return [...seen];
  }

  function closePanel() {
    selected = null;
    panelMoved = null;
    renderSquarePanel();
    draw();
  }

  // Float the notes overlay beside the selected square, kept inside the viewport.
  function placePanel() {
    const panel = $('#square-panel');
    if (panel.hidden || !selected) return;
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    const headerH = $('header.top').offsetHeight;
    const clampX = v => Math.min(Math.max(8, v), innerWidth - pw - 8);
    const clampY = v => Math.min(Math.max(headerH + 8, v), innerHeight - ph - 8);
    if (panelMoved) {
      panel.style.left = clampX(panelMoved.left) + 'px';
      panel.style.top = clampY(panelMoved.top) + 'px';
      return;
    }
    const r = canvas.getBoundingClientRect(), cs = cellSize();
    const sx = r.left + RULER_L + selected.x * cs, sy = r.top + RULER_T + selected.y * cs;
    let left = sx + cs + 14;                                // prefer the right of the square
    if (left + pw > innerWidth - 8) left = sx - pw - 14;    // else the left
    if (left < 8) {                                         // narrow screen: above/below
      left = clampX(sx + cs / 2 - pw / 2);
      const below = sy + cs + 14;
      panel.style.top = clampY(below + ph <= innerHeight - 8 ? below : sy - ph - 14) + 'px';
    } else {
      panel.style.top = clampY(sy + cs / 2 - 40) + 'px';
    }
    panel.style.left = left + 'px';
  }
  $('#canvas-wrap').addEventListener('scroll', placePanel, { passive: true });
  addEventListener('scroll', placePanel, { passive: true });
  addEventListener('resize', placePanel);

  // Drag the overlay by its header.
  $('#sq-head').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const panel = $('#square-panel');
    const start = { x: e.clientX, y: e.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    $('#sq-head').setPointerCapture(e.pointerId);
    const move = ev => {
      panelMoved = { left: start.left + ev.clientX - start.x, top: start.top + ev.clientY - start.y };
      placePanel();
    };
    const up = () => {
      $('#sq-head').removeEventListener('pointermove', move);
      $('#sq-head').removeEventListener('pointerup', up);
    };
    $('#sq-head').addEventListener('pointermove', move);
    $('#sq-head').addEventListener('pointerup', up);
  });

  // Scroll the grid (and page) so a square is on screen.
  function revealSquare(x, y) {
    const wrap = $('#canvas-wrap'), cs = cellSize();
    const px = RULER_L + x * cs, py = RULER_T + y * cs;
    if (px < wrap.scrollLeft || px + cs > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = px - wrap.clientWidth / 2;
    if (py < wrap.scrollTop || py + cs > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = py - wrap.clientHeight / 2;
    const r = canvas.getBoundingClientRect();
    const vy = r.top + py;
    if (vy < $('header.top').offsetHeight + 8 || vy + cs > innerHeight - 8) scrollBy(0, vy - innerHeight / 2);
  }

  function renderSquarePanel() {
    const panel = $('#square-panel');
    if (!plan || !selected) { panel.hidden = true; return; }
    const k = KEY(selected.x, selected.y);
    const crop = state.cropById.get(cells.get(k));
    panel.hidden = false;
    requestAnimationFrame(placePanel);
    $('#sq-title').innerHTML = (crop ? `<span class="swatch" style="background:${crop.color}"></span>${esc(crop.name)}` : 'Empty square') +
      ` <span class="hint">· column ${selected.x + 1}, row ${selected.y + 1}</span>`;
    $('#sq-empty').hidden = !!crop;
    $('#sq-form').hidden = !crop;
    if (!crop) return;
    const n = noteAt(k);
    if (document.activeElement !== $('#sq-variety')) $('#sq-variety').value = n.variety;
    if (document.activeElement !== $('#sq-note')) $('#sq-note').value = n.note;
    $$('#sq-rating button').forEach(b => b.classList.toggle('on', +b.dataset.r === n.rating));
    // suggest varieties already used for this crop in this plan
    const vs = new Set();
    for (const [kk, nn] of notes) if (nn.variety && cells.get(kk) === crop.id) vs.add(nn.variety);
    $('#sq-variety-list').innerHTML = [...vs].map(v => `<option value="${esc(v)}">`).join('');
    const group = connectedSquares(selected.x, selected.y).length;
    $('#sq-spread').hidden = group < 2;
    $('#sq-spread').textContent = `Copy these notes to all ${group} connected ${crop.name} squares`;
  }

  function editNote(change) {
    if (!selected) return;
    const k = KEY(selected.x, selected.y);
    if (!cells.has(k)) return;
    if (!noteEditOpen) { // one undo step per editing session on a square
      undoStack.push(snapshot()); redoStack = [];
      noteEditOpen = true;
    }
    const n = { ...noteAt(k), ...change };
    if (n.variety || n.rating || n.note) notes.set(k, n); else notes.delete(k);
    renderPlantNotes();
    scheduleSave();
    draw();
  }

  $('#sq-variety').addEventListener('input', e => editNote({ variety: e.target.value }));
  $('#sq-note').addEventListener('input', e => editNote({ note: e.target.value }));
  $('#sq-rating').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !selected) return;
    const r = +b.dataset.r;
    editNote({ rating: noteAt(KEY(selected.x, selected.y)).rating === r ? 0 : r });
    renderSquarePanel();
  });
  $('#sq-clear').addEventListener('click', () => {
    if (!selected) return;
    noteEditOpen = false;
    editNote({ variety: '', rating: 0, note: '' });
    noteEditOpen = false;
    renderSquarePanel();
  });
  $('#sq-spread').addEventListener('click', () => {
    if (!selected) return;
    const src = notes.get(KEY(selected.x, selected.y));
    undoStack.push(snapshot()); redoStack = [];
    noteEditOpen = false;
    for (const k of connectedSquares(selected.x, selected.y)) {
      if (src) notes.set(k, { ...src }); else notes.delete(k);
    }
    changed(); draw();
    toast('Notes copied');
  });
  $('#sq-close').addEventListener('click', closePanel);
  $('#square-panel').addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  // Table of every note in this plan; identical notes on several squares are merged.
  function renderPlantNotes() {
    const el = $('#plant-notes');
    if (!plan || !notes.size) { el.innerHTML = ''; return; }
    const groups = new Map();
    for (const [k, n] of notes) {
      const crop = state.cropById.get(cells.get(k));
      if (!crop) continue;
      const gk = JSON.stringify([crop.id, n.variety, n.rating, n.note]);
      if (!groups.has(gk)) groups.set(gk, { crop, n, keys: [] });
      groups.get(gk).keys.push(k);
    }
    const list = [...groups.values()].sort((a, b) =>
      a.crop.name.localeCompare(b.crop.name) || a.n.variety.localeCompare(b.n.variety));
    el.innerHTML = `<h3 style="margin-bottom:6px">Plant notes</h3><div class="table-wrap"><table class="data">
      <thead><tr><th>Crop</th><th>Variety</th><th>Rating</th><th>Notes</th><th class="num">Squares</th></tr></thead><tbody>` +
      list.map(g => {
        const k = Math.min(...g.keys);
        return `<tr data-k="${k}" title="Click to select"><td><span class="swatch" style="background:${g.crop.color}"></span>${esc(g.crop.name)}</td>
          <td>${esc(g.n.variety) || '<span class="hint">–</span>'}</td><td>${RATINGS[g.n.rating] || '<span class="hint">–</span>'}</td>
          <td class="note-text">${esc(g.n.note)}</td><td class="num">${g.keys.length}</td></tr>`;
      }).join('') + '</tbody></table></div>';
  }
  $('#plant-notes').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-k]');
    if (!tr) return;
    const k = +tr.dataset.k;
    setMode('select');
    revealSquare(k % 1024, Math.floor(k / 1024));
    selectSquare(k % 1024, Math.floor(k / 1024));
  });
  $('#palette-add').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('input', e.target);
    try {
      const c = await createCrop(input.value);
      input.value = '';
      tool = c.id;
      renderPalette();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- drawing ----------
  function cellSize() { return zoom; }

  function draw() {
    if (!plan) return;
    const cs = cellSize();
    ctx.font = `${rulerFont()}px system-ui, sans-serif`;
    RULER_L = Math.max(30, Math.ceil(ctx.measureText(String(plan.height)).width) + 14);
    RULER_T = Math.max(20, rulerFont() + 10);
    const W = RULER_L + plan.width * cs + 1, H = RULER_T + plan.height * cs + 1;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const empty = cssVar('--cell-empty'), line = cssVar('--cell-line'), muted = cssVar('--muted');
    ctx.fillStyle = cssVar('--surface-2');
    ctx.fillRect(0, 0, W, H);

    // rulers (1-based feet)
    ctx.fillStyle = muted;
    ctx.font = `${rulerFont()}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const numW = ctx.measureText(String(Math.max(plan.width, plan.height))).width;
    const every = cs >= numW + 6 ? 1 : cs * 2 >= numW + 6 ? 2 : 5;
    for (let x = 0; x < plan.width; x++) {
      if ((x + 1) % every === 0 || x === 0) ctx.fillText(x + 1, RULER_L + x * cs + cs / 2, RULER_T / 2);
    }
    ctx.textAlign = 'right';
    for (let y = 0; y < plan.height; y++) {
      if ((y + 1) % every === 0 || y === 0) ctx.fillText(y + 1, RULER_L - 6, RULER_T + y * cs + cs / 2);
    }

    // cells
    const preview = drag && drag.mode === 'rect' ? rectOf(drag.start, drag.end) : null;
    const inPreview = (x, y) => preview && x >= preview.x0 && x <= preview.x1 && y >= preview.y0 && y <= preview.y1;
    for (let y = 0; y < plan.height; y++) {
      for (let x = 0; x < plan.width; x++) {
        let c = cells.get(KEY(x, y)) || 0;
        if (preview && x >= preview.x0 && x <= preview.x1 && y >= preview.y0 && y <= preview.y1) c = drag.tool;
        const crop = c ? state.cropById.get(c) : null;
        ctx.fillStyle = crop ? crop.color : empty;
        ctx.fillRect(RULER_L + x * cs, RULER_T + y * cs, cs, cs);
      }
    }

    // grid lines: hairline every foot, stronger every 5 ft
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? muted : line;
      ctx.globalAlpha = pass ? 0.55 : 1;
      ctx.beginPath();
      for (let x = 0; x <= plan.width; x++) {
        if (pass && x % 5 && x !== plan.width) continue;
        const px = RULER_L + x * cs + 0.5;
        ctx.moveTo(px, RULER_T); ctx.lineTo(px, RULER_T + plan.height * cs);
      }
      for (let y = 0; y <= plan.height; y++) {
        if (pass && y % 5 && y !== plan.height) continue;
        const py = RULER_T + y * cs + 0.5;
        ctx.moveTo(RULER_L, py); ctx.lineTo(RULER_L + plan.width * cs, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Plant labels (identity is never color alone): one label per connected group of
    // the same crop, centered in the largest rectangle inside that group, wrapping
    // onto extra lines - or turned sideways for tall, narrow beds - when needed.
    const fs = labelFont(), lineH = Math.round(fs * 1.2);
    {
      ctx.font = `${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const gw = plan.width, gh = plan.height;
      const grid = new Int32Array(gw * gh), grp = new Int32Array(gw * gh);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const k = KEY(x, y), cur = cells.get(k) || 0;
        const c = inPreview(x, y) ? drag.tool : cur;
        grid[y * gw + x] = c;
        grp[y * gw + x] = c === cur ? groupOf(k) : 0;
      }
      const seen = new Uint8Array(gw * gh);
      for (let i = 0; i < grid.length; i++) {
        const c = grid[i];
        if (!c || seen[i]) continue;
        // flood-fill the connected group
        const group = [i];
        seen[i] = 1;
        let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
        for (let g = 0; g < group.length; g++) {
          const j = group[g], x = j % gw, y = (j - x) / gw;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
            const n = ny * gw + nx;
            if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && !seen[n] && grid[n] === c && grp[n] === grp[i]) {
              seen[n] = 1; group.push(n);
            }
          }
        }
        const crop = state.cropById.get(c);
        if (!crop || cs * 2 < lineH) continue;
        const r = largestRect(grid, gw, c, x0, y0, x1, y1, group);
        drawLabel(crop, RULER_L + r.x * cs, RULER_T + r.y * cs, r.w * cs, r.h * cs, lineH);
      }

      // Divider lines where touching squares of the same crop are in different blocks.
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = cssVar('--surface');
      ctx.beginPath();
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        if (!grid[i]) continue;
        if (x + 1 < gw && grid[i + 1] === grid[i] && grp[i + 1] !== grp[i]) {
          const px = RULER_L + (x + 1) * cs + 0.5;
          ctx.moveTo(px, RULER_T + y * cs + 2); ctx.lineTo(px, RULER_T + (y + 1) * cs - 2);
        }
        if (y + 1 < gh && grid[i + gw] === grid[i] && grp[i + gw] !== grp[i]) {
          const py = RULER_T + (y + 1) * cs + 0.5;
          ctx.moveTo(RULER_L + x * cs + 2, py); ctx.lineTo(RULER_L + (x + 1) * cs - 2, py);
        }
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // outline of the area being unmerged/merged
    if (drag && (drag.mode === 'split' || drag.mode === 'merge')) {
      const r = rectOf(drag.start, drag.end);
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = cssVar('--text');
      ctx.strokeRect(RULER_L + r.x0 * cs + 1, RULER_T + r.y0 * cs + 1, (r.x1 - r.x0 + 1) * cs - 2, (r.y1 - r.y0 + 1) * cs - 2);
      ctx.restore();
    }

    // corner mark on squares that have notes
    const mark = Math.max(5, Math.round(cs * 0.28));
    for (const k of notes.keys()) {
      const crop = state.cropById.get(cells.get(k));
      if (!crop) continue;
      const px = RULER_L + (k % 1024 + 1) * cs, py = RULER_T + Math.floor(k / 1024) * cs;
      ctx.fillStyle = textOn(crop.color);
      ctx.beginPath();
      ctx.moveTo(px - mark, py + 1); ctx.lineTo(px - 1, py + 1); ctx.lineTo(px - 1, py + mark);
      ctx.closePath(); ctx.fill();
    }

    // selected square outline
    if (selected) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = cssVar('--text');
      ctx.strokeRect(RULER_L + selected.x * cs + 1.5, RULER_T + selected.y * cs + 1.5, cs - 3, cs - 3);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = cssVar('--surface');
      ctx.strokeRect(RULER_L + selected.x * cs + 3.75, RULER_T + selected.y * cs + 3.75, cs - 7.5, cs - 7.5);
    }
    placePanel();
  }

  // Largest all-same-crop rectangle within one connected group (histogram method over
  // the group's bounding box). Only squares belonging to this group count.
  function largestRect(grid, W, c, x0, y0, x1, y1, group) {
    const inGroup = new Set(group);
    const bw = x1 - x0 + 1;
    const heights = new Int32Array(bw);
    let best = { x: x0, y: y0, w: 1, h: 1, area: 0 };
    for (let y = y0; y <= y1; y++) {
      for (let i = 0; i < bw; i++) {
        const idx = y * W + x0 + i;
        heights[i] = grid[idx] === c && inGroup.has(idx) ? heights[i] + 1 : 0;
      }
      const stack = [];
      for (let i = 0; i <= bw; i++) {
        const h = i < bw ? heights[i] : 0;
        while (stack.length && heights[stack[stack.length - 1]] >= h) {
          const top = stack.pop();
          const hh = heights[top];
          const left = stack.length ? stack[stack.length - 1] + 1 : 0;
          const w = i - left;
          // prefer bigger area; on ties prefer wider (horizontal text reads best)
          if (hh && (hh * w > best.area || (hh * w === best.area && w > best.w))) {
            best = { x: x0 + left, y: y - hh + 1, w, h: hh, area: hh * w };
          }
        }
        stack.push(i);
      }
    }
    return best;
  }

  // Draw a crop name centered in a box: horizontal (wrapped) if it fits, otherwise
  // sideways when the box is taller than wide, otherwise truncated with …
  function drawLabel(crop, bx, by, bw, bh, lineH) {
    const pad = 6;
    const horiz = layoutLabel(crop.name, bw - pad, Math.floor((bh - 2) / lineH));
    const full = ls => ls.length > 0 && !ls.some(l => l.endsWith('…'));
    let lines = horiz, rotate = false;
    if (!full(horiz) && bh > bw) {
      const vert = layoutLabel(crop.name, bh - pad, Math.floor((bw - 2) / lineH));
      if (full(vert) || (vert.length && !horiz.length)) { lines = vert; rotate = true; }
    }
    if (!lines.length) return;
    ctx.save();
    ctx.translate(bx + bw / 2, by + bh / 2);
    if (rotate) ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = textOn(crop.color);
    const top = -((lines.length - 1) * lineH) / 2 + 0.5;
    lines.forEach((ln, i) => ctx.fillText(ln, 0, top + i * lineH));
    ctx.restore();
  }

  const fits = (s, w) => ctx.measureText(s).width <= w;

  function truncate(s, width) {
    if (fits(s, width)) return s;
    for (let n = s.length - 1; n >= 1; n--) {
      const t = s.slice(0, n).trimEnd() + '…';
      if (fits(t, width)) return t;
    }
    return '';
  }

  // Wrap a name into at most maxLines lines of the given width; truncate with … if it won't fit.
  function layoutLabel(name, width, maxLines) {
    if (maxLines < 1 || width <= 0) return [];
    if (fits(name, width)) return [name];
    if (maxLines === 1) return [truncate(name, width)].filter(Boolean);
    const lines = [];
    let cur = '';
    for (const word of name.split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word;
      if (!cur || fits(next, width)) cur = next;
      else { lines.push(cur); cur = word; }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] += '…';
    }
    return lines.map(l => truncate(l, width)).filter(Boolean);
  }

  function cellAt(e) {
    const r = canvas.getBoundingClientRect();
    const cs = cellSize();
    const x = Math.floor((e.clientX - r.left - RULER_L) / cs);
    const y = Math.floor((e.clientY - r.top - RULER_T) / cs);
    if (!plan || x < 0 || y < 0 || x >= plan.width || y >= plan.height) return null;
    return { x, y };
  }
  const rectOf = (a, b) => ({
    x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y),
  });

  function paint(x, y, t) {
    const k = KEY(x, y);
    if ((cells.get(k) || 0) === t) return false;
    if (t) cells.set(k, t); else cells.delete(k);
    notes.delete(k);  // notes describe the old plant, so they go with it
    groups.delete(k); // a new plant joins the default (merged) block
    return true;
  }

  // Unmerge: the planted squares in the rectangle become their own labeled block.
  // Merge: a single click rejoins the clicked block with its neighbours; a dragged
  // rectangle rejoins every square inside it.
  function applyBlockTool(m, r) {
    let keys = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
      if (cells.has(KEY(x, y))) keys.push(KEY(x, y));
    }
    if (m === 'merge' && r.x0 === r.x1 && r.y0 === r.y1 && keys.length) {
      keys = connectedSquares(r.x0, r.y0);
    }
    let changedAny = false;
    if (m === 'split') {
      const id = Math.max(0, ...groups.values()) + 1;
      for (const k of keys) { groups.set(k, id); changedAny = true; }
    } else {
      for (const k of keys) if (groups.delete(k)) changedAny = true;
    }
    return changedAny;
  }

  function paintLine(a, b, t) {
    // Bresenham so fast drags don't skip squares
    let { x, y } = a;
    const dx = Math.abs(b.x - x), dy = -Math.abs(b.y - y);
    const sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
    let err = dx + dy, changed = false;
    for (;;) {
      changed = paint(x, y, t) || changed;
      if (x === b.x && y === b.y) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return changed;
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !plan) return;
    const c = cellAt(e);
    if (!c) return;
    e.preventDefault();
    if (mode === 'select' && !e.shiftKey) { selectSquare(c.x, c.y); return; }
    canvas.setPointerCapture(e.pointerId);
    drag = { mode: e.shiftKey ? 'rect' : mode, tool, start: c, end: c, last: c, before: snapshot(), changed: false };
    if (drag.mode === 'brush') drag.changed = paint(c.x, c.y, tool);
    draw();
  });

  canvas.addEventListener('pointermove', e => {
    const c = cellAt(e);
    if (c) {
      const k = KEY(c.x, c.y);
      const crop = state.cropById.get(cells.get(k));
      const n = notes.get(k);
      $('#plan-hover').textContent = `Column ${c.x + 1}, row ${c.y + 1}: ${crop ? crop.name : 'empty'}` +
        (n && n.variety ? ` (${n.variety})` : '') + (n && RATINGS[n.rating] ? ` ${RATINGS[n.rating]}` : '');
      // Variety tooltip in every tool; nothing when the square has no variety or while painting.
      if (crop && n && n.variety && !drag) showTip(`<div class="t-title" style="margin:0">${esc(n.variety)}</div>`, e);
      else hideTip();
    } else {
      $('#plan-hover').innerHTML = '&nbsp;';
      hideTip();
    }
    if (!drag || !c) return;
    if (drag.mode === 'brush') {
      if (paintLine(drag.last, c, drag.tool)) { drag.changed = true; draw(); }
      drag.last = c;
    } else if (c.x !== drag.end.x || c.y !== drag.end.y) {
      drag.end = c; draw();
    }
  });

  function endDrag() {
    if (!drag) return;
    if (drag.mode === 'rect') {
      const r = rectOf(drag.start, drag.end);
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
        drag.changed = paint(x, y, drag.tool) || drag.changed;
      }
    } else if (drag.mode === 'split' || drag.mode === 'merge') {
      drag.changed = applyBlockTool(drag.mode, rectOf(drag.start, drag.end));
    }
    if (drag.changed) {
      undoStack.push(drag.before);
      if (undoStack.length > 60) undoStack.shift();
      redoStack = [];
      changed();
    }
    drag = null;
    draw();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    hideTip();
    if (!drag) $('#plan-hover').innerHTML = '&nbsp;';
  });

  function changed() {
    renderPalette();
    renderSquarePanel();
    scheduleSave();
  }

  function restore(snap) {
    cells = snap.cells; notes = snap.notes; groups = snap.groups;
    noteEditOpen = false;
    changed(); draw();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }
  $('#plan-undo').addEventListener('click', undo);
  $('#plan-redo').addEventListener('click', redo);

  document.addEventListener('keydown', e => {
    if (state.view !== 'planner' || !plan) return;
    if (e.target.matches('input, textarea, select') || $('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (k === 'e') { tool = 0; if (mode === 'select') setMode('brush'); else renderPalette(); }
    else if (k === 'b') setMode('brush');
    else if (k === 'r') setMode('rect');
    else if (k === 's') setMode('select');
    else if (k === 'u') setMode('split');
    else if (k === 'm') setMode('merge');
    else if (k === 'escape' && selected) closePanel();
  });

  $('#plan-zoom').addEventListener('input', e => {
    zoom = +e.target.value;
    try { localStorage.setItem('gt-zoom', zoom); } catch { /* ignore */ }
    draw();
  });
  $('#plan-text').addEventListener('input', e => {
    textSize = +e.target.value;
    try { localStorage.setItem('gt-text', textSize); } catch { /* ignore */ }
    applyTextSize();
    draw();
  });

  // ---------- metadata & resize ----------
  ['#plan-name', '#plan-year', '#plan-notes'].forEach(sel =>
    $(sel).addEventListener('input', () => { if (plan) scheduleSave(); }));

  $('#plan-resize').addEventListener('click', async () => {
    if (!plan) return;
    const w = +$('#plan-width').value, h = +$('#plan-height').value;
    if (!(w >= 1 && w <= 200 && h >= 1 && h <= 200 && Number.isInteger(w) && Number.isInteger(h))) {
      toast('Width and length must be whole numbers from 1 to 200 ft', true);
      return;
    }
    let lost = 0;
    for (const k of cells.keys()) if (k % 1024 >= w || Math.floor(k / 1024) >= h) lost++;
    if (lost && !(await confirmDialog('Shrink garden?',
      `${lost} planted square${lost === 1 ? '' : 's'} fall outside ${w}×${h} ft and will be removed.`, 'Resize'))) {
      $('#plan-width').value = plan.width; $('#plan-height').value = plan.height;
      return;
    }
    undoStack.push(snapshot()); redoStack = [];
    for (const k of [...cells.keys()]) {
      if (k % 1024 >= w || Math.floor(k / 1024) >= h) { cells.delete(k); notes.delete(k); groups.delete(k); }
    }
    if (selected && (selected.x >= w || selected.y >= h)) selected = null;
    plan.width = w; plan.height = h;
    changed(); draw();
  });

  $('#plan-delete').addEventListener('click', async () => {
    if (!plan) return;
    if (!(await confirmDialog('Delete this plan?', `“${plan.name}” (${plan.year}) will be permanently deleted.`))) return;
    clearTimeout(saveTimer); dirty = false;
    try {
      await api('DELETE', `/api/plans/${plan.id}`);
      plan = null;
      history.replaceState(null, '', '#planner');
      await show();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- saving ----------
  function scheduleSave() {
    dirty = true;
    setStatus('Unsaved…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }

  function payload() {
    const name = $('#plan-name').value.trim() || 'Untitled garden';
    const year = Math.round(+$('#plan-year').value) || plan.year;
    return {
      name, year, width: plan.width, height: plan.height, notes: $('#plan-notes').value,
      cells: [...cells].map(([k, c]) => {
        const n = notes.get(k);
        const cell = [k % 1024, Math.floor(k / 1024), c];
        const g = groupOf(k);
        return n || g ? cell.concat([n ? n.variety.trim() : '', n ? n.rating : 0, n ? n.note : '', g]) : cell;
      }),
    };
  }

  async function save() {
    clearTimeout(saveTimer);
    if (!dirty || !plan) return;
    if (savePromise) await savePromise;
    dirty = false;
    const id = plan.id, body = payload();
    setStatus('Saving…');
    savePromise = api('PUT', `/api/plans/${id}`, body).then(() => {
      if (!dirty) setStatus('Saved ✓');
      const p = state.plans.find(p => p.id === id);
      const meta = { name: body.name, year: body.year, width: body.width, height: body.height };
      if (p && Object.keys(meta).some(k => p[k] !== meta[k])) {
        Object.assign(p, meta);
        state.plans.sort((a, b) => b.year - a.year || b.id - a.id);
        renderTabs();
      }
    }).catch(err => {
      dirty = true;
      setStatus('Save failed');
      toast('Could not save plan: ' + err.message, true);
    }).finally(() => { savePromise = null; });
    return savePromise;
  }

  async function flush() {
    if (dirty) await save();
    else if (savePromise) await savePromise;
  }

  addEventListener('beforeunload', e => {
    if (dirty || savePromise) {
      if (dirty && plan) {
        fetch(`/api/plans/${plan.id}`, {
          method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload()),
        });
      }
      e.preventDefault();
      e.returnValue = '';
    }
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw());

  return { show, flush, redraw: () => { renderPalette(); draw(); } };
})();

// ====================================================================
// Charts (hand-rolled SVG; no external libraries)
// ====================================================================
const charts = (() => {
  const hidden = {};   // chartKey -> Set of hidden series ids (legend toggles)

  function attachTips(el, tips) {
    el.addEventListener('mousemove', e => {
      const t = e.target.closest('[data-tip]');
      if (t) showTip(tips[+t.dataset.tip], e); else hideTip();
    });
    el.addEventListener('mouseleave', hideTip);
  }

  // Horizontal bars, 4px rounded data-end, square at baseline.
  function hBarPath(x, y, w, h) {
    const r = Math.min(4, w, h / 2);
    if (w <= 0) return '';
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  // Vertical column segment; rounded top only when it's the top of the stack.
  function colPath(x, y, w, h, roundTop) {
    if (h <= 0) return '';
    const r = roundTop ? Math.min(4, h, w / 2) : 0;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /**
   * Grouped horizontal bar chart.
   * groups: [{title, rows:[{label, color, value, display, tip}]}]  (value = comparable scale within group)
   */
  function bars(el, groups) {
    const width = Math.max(300, el.clientWidth);
    const labelW = Math.min(150, 16 + Math.max(...groups.flatMap(g => g.rows.map(r => r.label.length))) * 7);
    const valueW = 90, rowH = 30, barH = 18, headH = 26;
    let y = 4, body = '';
    const tips = [];
    const multi = groups.length > 1;
    for (const g of groups) {
      if (multi) { body += `<text class="ink2" x="0" y="${y + 15}" font-weight="600">${esc(g.title)}</text>`; y += headH; }
      const max = Math.max(...g.rows.map(r => r.value)) || 1;
      const plotW = width - labelW - valueW;
      body += `<line class="baseline" x1="${labelW}" x2="${labelW}" y1="${y}" y2="${y + g.rows.length * rowH}"/>`;
      for (const r of g.rows) {
        const w = Math.max(2, (r.value / max) * plotW);
        const by = y + (rowH - barH) / 2;
        tips.push(r.tip);
        body += `<g data-tip="${tips.length - 1}">
          <rect x="0" y="${y}" width="${width}" height="${rowH}" fill="transparent"/>
          <text class="ink" x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
          <path d="${hBarPath(labelW + 1, by, w, barH)}" fill="${r.color}"/>
          <text class="ink2" x="${labelW + w + 8}" y="${y + rowH / 2 + 4}">${esc(r.display)}</text></g>`;
        y += rowH;
      }
      y += 10;
    }
    el.innerHTML = `<svg width="${width}" height="${y}" role="img">${body}</svg>`;
    attachTips($('svg', el), tips);
  }

  function legend(key, series, onChange) {
    const off = hidden[key] || (hidden[key] = new Set());
    const div = document.createElement('div');
    div.className = 'chart-legend';
    div.innerHTML = series.map(s =>
      `<button data-id="${esc(s.id)}" class="${off.has(String(s.id)) ? 'off' : ''}" title="Show/hide"><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}</button>`).join('');
    div.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const id = b.dataset.id;
      if (off.has(id)) off.delete(id); else off.add(id);
      onChange();
    });
    return div;
  }

  /**
   * Cumulative step-line chart over time.
   * series: [{id, name, color, points:[{t, v}]}] (v = per-event amount, cumulated here)
   */
  function cumulative(el, { key, series, domain, unit, tipTitle = longDate }) {
    const render = () => {
      el.innerHTML = '';
      if (series.length > 1) el.appendChild(legend(key, series, render));
      const off = hidden[key] || new Set();
      const vis = series.filter(s => !off.has(String(s.id)));
      const width = Math.max(320, el.clientWidth), height = 260;
      const m = { l: 48, r: 16, t: 12, b: 26 };
      const [t0, t1] = domain;
      const X = t => m.l + ((t - t0) / (t1 - t0 || 1)) * (width - m.l - m.r);
      const cum = vis.map(s => {
        let acc = 0;
        const steps = [];
        for (const p of [...s.points].sort((a, b) => a.t - b.t)) {
          acc += p.v;
          if (steps.length && steps[steps.length - 1].t === p.t) steps[steps.length - 1].v = acc;
          else steps.push({ t: p.t, v: acc });
        }
        return { ...s, steps, total: acc };
      });
      const max = Math.max(0, ...cum.map(s => s.total));
      const ticks = niceTicks(max);
      const yMax = ticks[ticks.length - 1] || 1;
      const Y = v => height - m.b - (v / yMax) * (height - m.t - m.b);
      let g = '';
      for (const v of ticks) {
        g += `<line class="gridline" x1="${m.l}" x2="${width - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
        g += `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtCompact(v)}</text>`;
      }
      for (const tk of timeTicks(t0, t1)) {
        g += `<text x="${X(tk.t)}" y="${height - 8}" text-anchor="middle">${tk.label}</text>`;
      }
      g += `<line class="baseline" x1="${m.l}" x2="${width - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
      g += `<text x="${m.l}" y="${m.t - 2}" font-size="10">${esc(unit)}</text>`;
      for (const s of cum) {
        let d = `M${X(t0)},${Y(0)}`;
        for (const p of s.steps) d += `H${X(p.t)}V${Y(p.v)}`;
        d += `H${X(t1)}`;
        g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        const last = s.steps[s.steps.length - 1];
        if (last) g += `<circle cx="${X(last.t)}" cy="${Y(last.v)}" r="4" fill="${s.color}" style="stroke:var(--surface)" stroke-width="2"/>`;
      }
      // Direct end labels for <= 4 series if they don't collide.
      if (cum.length <= 4 && cum.length > 1) {
        const ends = cum.map(s => ({ s, y: Y(s.total) })).sort((a, b) => a.y - b.y);
        if (ends.every((e, i) => i === 0 || e.y - ends[i - 1].y >= 13)) {
          for (const e of ends) g += `<text class="ink2" x="${width - m.r - 4}" y="${e.y - 6}" text-anchor="end">${esc(e.s.name)}</text>`;
        }
      }
      g += `<line class="baseline xh" y1="${m.t}" y2="${Y(0)}" visibility="hidden"/>`;
      g += `<rect x="${m.l}" y="${m.t}" width="${width - m.l - m.r}" height="${height - m.t - m.b}" fill="transparent" class="hit"/>`;
      const wrap = document.createElement('div');
      wrap.innerHTML = `<svg width="${width}" height="${height}" role="img">${g}</svg>`;
      el.appendChild(wrap);
      const svg = $('svg', wrap), xh = $('.xh', svg);
      const events = [...new Set(cum.flatMap(s => s.steps.map(p => p.t)))].sort((a, b) => a - b);
      $('.hit', svg).addEventListener('mousemove', e => {
        if (!events.length) return;
        const r = svg.getBoundingClientRect();
        const t = t0 + ((e.clientX - r.left - m.l) / (width - m.l - m.r)) * (t1 - t0);
        const near = events.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
        xh.setAttribute('x1', X(near)); xh.setAttribute('x2', X(near)); xh.setAttribute('visibility', 'visible');
        const rows = cum.map(s => {
          let v = 0;
          for (const p of s.steps) if (p.t <= near) v = p.v;
          return { s, v };
        }).filter(r => r.v > 0).sort((a, b) => b.v - a.v);
        showTip(`<div class="t-title">${esc(tipTitle(near))}</div>` +
          (rows.length ? rows.map(r => tipRow(r.s.color, r.s.name, `${fmt(r.v)} ${unit}`)).join('') : '<div>Nothing yet</div>') +
          `<div class="hint" style="margin-top:4px">Running total</div>`, e);
      });
      $('.hit', svg).addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); });
    };
    render();
  }

  /**
   * Stacked weekly columns.
   * weeks: [{t, parts:[{id, name, color, v}]}]
   */
  function weekly(el, { weeks, unit }) {
    const width = Math.max(320, el.clientWidth), height = 240;
    const m = { l: 48, r: 12, t: 12, b: 26 };
    const totals = weeks.map(w => w.parts.reduce((a, p) => a + p.v, 0));
    const ticks = niceTicks(Math.max(0, ...totals));
    const yMax = ticks[ticks.length - 1] || 1;
    const Y = v => height - m.b - (v / yMax) * (height - m.t - m.b);
    const slot = (width - m.l - m.r) / Math.max(1, weeks.length);
    const bw = Math.min(24, Math.max(4, slot - 4));
    let g = '';
    const tips = [];
    for (const v of ticks) {
      g += `<line class="gridline" x1="${m.l}" x2="${width - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
      g += `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmtCompact(v)}</text>`;
    }
    g += `<text x="${m.l}" y="${m.t - 2}" font-size="10">${esc(unit)}</text>`;
    const labelEvery = Math.ceil(46 / slot);
    weeks.forEach((w, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      let base = 0;
      const parts = w.parts.filter(p => p.v > 0);
      parts.forEach((p, j) => {
        const y0 = Y(base), y1 = Y(base + p.v);
        const top = j === parts.length - 1;
        // 2px surface gap between stacked segments
        const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
        g += `<path d="${colPath(x, y1, bw, h, top)}" fill="${p.color}"/>`;
        base += p.v;
      });
      tips.push(`<div class="t-title">Week of ${esc(shortDate(w.t))}</div>` +
        [...parts].reverse().map(p => tipRow(p.color, p.name, `${fmt(p.v)} ${unit}`)).join('') +
        (parts.length > 1 ? tipRow('', 'Total', `${fmt(totals[i])} ${unit}`) : '') +
        (parts.length ? '' : '<div>No harvest</div>'));
      g += `<rect data-tip="${i}" x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${height - m.t - m.b}" fill="transparent"/>`;
      if (i % labelEvery === 0) g += `<text x="${m.l + i * slot + slot / 2}" y="${height - 8}" text-anchor="middle">${esc(shortDate(w.t))}</text>`;
    });
    g += `<line class="baseline" x1="${m.l}" x2="${width - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    el.innerHTML = `<svg width="${width}" height="${height}" role="img">${g}</svg>`;
    attachTips($('svg', el), tips);
  }

  /**
   * Harvest-window timeline: one row per entity, a dot on every harvest day.
   * rows: [{label, color, events:[{t, size(0..1), tip}]}]
   */
  function timeline(el, { rows, domain }) {
    const width = Math.max(320, el.clientWidth);
    const labelW = Math.min(140, 16 + Math.max(...rows.map(r => r.label.length)) * 7);
    const rowH = 30, m = { t: 6, b: 24, r: 14 };
    const height = m.t + rows.length * rowH + m.b;
    const [t0, t1] = domain;
    const X = t => labelW + ((t - t0) / (t1 - t0 || 1)) * (width - labelW - m.r);
    let g = '';
    const tips = [];
    for (const tk of timeTicks(t0, t1)) {
      g += `<line class="gridline" x1="${X(tk.t)}" x2="${X(tk.t)}" y1="${m.t}" y2="${height - m.b}"/>`;
      g += `<text x="${X(tk.t)}" y="${height - 8}" text-anchor="middle">${tk.label}</text>`;
    }
    rows.forEach((r, i) => {
      const cy = m.t + i * rowH + rowH / 2;
      g += `<text class="ink" x="${labelW - 10}" y="${cy + 4}" text-anchor="end">${esc(r.label)}</text>`;
      const ts = r.events.map(e => e.t);
      if (ts.length > 1) {
        g += `<line x1="${X(Math.min(...ts))}" x2="${X(Math.max(...ts))}" y1="${cy}" y2="${cy}" stroke="${r.color}" stroke-width="2" stroke-opacity="0.35" stroke-linecap="round"/>`;
      }
      for (const ev of r.events) {
        tips.push(ev.tip);
        const rad = 4 + 5 * Math.sqrt(ev.size);
        g += `<g data-tip="${tips.length - 1}"><circle cx="${X(ev.t)}" cy="${cy}" r="${rad + 4}" fill="transparent"/>
          <circle cx="${X(ev.t)}" cy="${cy}" r="${rad}" fill="${r.color}" style="stroke:var(--surface)" stroke-width="2"/></g>`;
      }
    });
    el.innerHTML = `<svg width="${width}" height="${height}" role="img">${g}</svg>`;
    attachTips($('svg', el), tips);
  }

  return { bars, cumulative, weekly, timeline };
})();

// ====================================================================
// Harvest tracker
// ====================================================================
const harvest = (() => {
  let year = CURRENT_YEAR;
  let years = [];
  let entries = [];
  let editingId = null;
  let measure = 'weight';
  let compareCrop = 'weight';
  let logFilter = '';
  let lastRender = null;

  async function show(arg) {
    await loadCrops();
    years = await api('GET', '/api/harvest-years');
    if (!years.includes(CURRENT_YEAR)) years.push(CURRENT_YEAR);
    years.sort((a, b) => b - a);
    if (arg === 'compare') {
      renderTabs('compare');
      $('#harvest-year').hidden = true;
      $('#harvest-compare').hidden = false;
      await renderCompare();
      lastRender = renderCompare;
      return;
    }
    const y = +arg;
    year = years.includes(y) ? y : (y >= 1900 && y <= 2200 ? y : CURRENT_YEAR);
    if (!years.includes(year)) { years.push(year); years.sort((a, b) => b - a); }
    renderTabs(year);
    $('#harvest-year').hidden = false;
    $('#harvest-compare').hidden = true;
    editingId = null;
    entries = await api('GET', `/api/harvests?year=${year}`);
    resetForm();
    renderYear();
    lastRender = renderYear;
  }

  function renderTabs(active) {
    $('#year-tabs').innerHTML = years.map(y =>
      `<button data-y="${y}" class="${active === y ? 'active' : ''}">${y}</button>`).join('') +
      `<button data-y="compare" class="${active === 'compare' ? 'active' : ''}">Compare years</button>` +
      `<button data-y="new" class="add" title="Open another season">+ Year</button>`;
  }
  $('#year-tabs').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.y === 'new') {
      const v = prompt('Which year do you want to open?', String(Math.min(...years) - 1));
      if (v && /^\d{4}$/.test(v.trim())) location.hash = `#harvest/${v.trim()}`;
      return;
    }
    location.hash = `#harvest/${b.dataset.y}`;
  });

  async function loadYear() {
    entries = await api('GET', `/api/harvests?year=${year}`);
    renderYear();
  }

  // ---------- entry form ----------
  function fillCropSelect() {
    const sel = $('#entry-crop');
    const prev = sel.value;
    let remembered = '';
    try { remembered = localStorage.getItem('gt-last-crop') || ''; } catch { /* ignore */ }
    sel.innerHTML = (state.crops.length ? '' : `<option value="">Choose…</option>`) +
      state.crops.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('') +
      `<option value="__new">+ New crop…</option>`;
    const pick = [prev, remembered].find(v => v && state.cropById.has(+v));
    sel.value = pick || (state.crops[0] ? state.crops[0].id : '');
    $('#entry-hint').hidden = state.crops.length > 0;
    $('#entry-hint').textContent = 'No crops yet. Choose “+ New crop…” in the crop list, or add crops on the Crops tab.';
    updateUnit();
  }
  function updateUnit() {
    const c = state.cropById.get(+$('#entry-crop').value);
    $('#entry-unit').textContent = c ? c.unit : '';
  }
  $('#entry-crop').addEventListener('change', async e => {
    if (e.target.value !== '__new') { updateUnit(); return; }
    const name = prompt('Name of the new crop (e.g. Tomato):');
    if (!name || !name.trim()) { fillCropSelect(); return; }
    const unit = (prompt(`How do you measure ${name.trim()}? (${UNITS.join(', ')})`, 'lb') || 'lb').trim().toLowerCase();
    try {
      const c = await createCrop(name.trim(), { unit: UNITS.includes(unit) ? unit : 'lb' });
      fillCropSelect();
      e.target.value = c.id;
      updateUnit();
    } catch (err) { toast(err.message, true); fillCropSelect(); }
  });

  function defaultDate() {
    if (year === CURRENT_YEAR) return todayIso();
    return entries.length ? entries[0].date : `${year}-07-01`;
  }

  function resetForm() {
    editingId = null;
    fillCropSelect();
    $('#entry-date').value = defaultDate();
    $('#entry-amount').value = '';
    $('#entry-notes').value = '';
    $('#entry-submit').textContent = 'Add';
    $('#entry-cancel').hidden = true;
    $('#entry-title').textContent = 'Log a harvest';
  }

  $('#entry-cancel').addEventListener('click', () => { resetForm(); renderLog(); });

  $('#entry-form').addEventListener('submit', async e => {
    e.preventDefault();
    const crop_id = +$('#entry-crop').value;
    if (!crop_id) { toast('Pick a crop first', true); return; }
    const body = {
      date: $('#entry-date').value, crop_id,
      amount: +$('#entry-amount').value, notes: $('#entry-notes').value,
    };
    try {
      if (editingId) await api('PUT', `/api/harvests/${editingId}`, body);
      else await api('POST', '/api/harvests', body);
      try { localStorage.setItem('gt-last-crop', String(crop_id)); } catch { /* ignore */ }
      const entryYear = +body.date.slice(0, 4);
      const wasEditing = !!editingId;
      if (entryYear !== year) {
        toast(`Saved to ${entryYear}`);
        if (!years.includes(entryYear)) { years.push(entryYear); years.sort((a, b) => b - a); renderTabs(year); }
      } else {
        toast(wasEditing ? 'Entry updated' : 'Harvest logged');
      }
      const keepDate = body.date;
      editingId = null;
      await loadYear();
      resetForm();
      if (!wasEditing) {
        $('#entry-date').value = keepDate;
        $('#entry-crop').value = crop_id; updateUnit();
      }
      $('#entry-amount').focus();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- year view ----------
  function aggregate(list) {
    const byCrop = new Map();
    for (const h of list) {
      let a = byCrop.get(h.crop_id);
      if (!a) {
        a = { id: h.crop_id, name: h.crop, color: h.color, unit: h.unit, total: 0, picks: 0, days: new Map() };
        byCrop.set(h.crop_id, a);
      }
      a.total += h.amount;
      a.picks++;
      a.days.set(h.date, (a.days.get(h.date) || 0) + h.amount);
    }
    for (const a of byCrop.values()) {
      const ds = [...a.days.keys()].sort();
      a.first = ds[0]; a.last = ds[ds.length - 1];
      a.best = [...a.days].reduce((m, d) => (d[1] > m[1] ? d : m));
      a.measure = measureOf(a.unit);
      a.mv = measureValue(a.total, a.unit);
    }
    return [...byCrop.values()].sort((a, b) => b.mv - a.mv);
  }

  function renderYear() {
    const crops = aggregate(entries);
    renderTiles(crops);
    renderCharts(crops);
    renderTotals(crops);
    renderLog();
    $('#export-csv').href = `/api/export/harvests.csv?year=${year}`;
  }

  function renderTiles(crops) {
    const days = new Set(entries.map(h => h.date));
    const weight = crops.filter(c => c.measure === 'weight').reduce((s, c) => s + c.mv, 0);
    const counted = crops.filter(c => c.measure !== 'weight');
    const dates = [...days].sort();
    const tiles = [
      ['Total harvest', `${fmt(weight, 1)} lb`, 'all weighed crops, in pounds', true],
      ...counted.length ? [['Counted harvest',
        counted.map(c => c.measure).filter((v, i, a) => a.indexOf(v) === i)
          .map(ms => `${fmt(counted.filter(c => c.measure === ms).reduce((s, c) => s + c.total, 0))} ${ms === 'bunch' ? 'bunches' : 'items'}`).join(' · '),
        'crops measured by count or bunch']] : [],
      ['Harvest days', fmt(days.size), `${entries.length} entries`],
      ['Crops harvested', fmt(crops.length), crops[0] ? `top: ${crops[0].name}` : ''],
      ['Season', dates.length ? `${shortDate(parseDate(dates[0]))} – ${shortDate(parseDate(dates[dates.length - 1]))}` : '–',
        dates.length ? 'first to last harvest' : 'no harvests yet'],
    ];
    $('#year-tiles').innerHTML = tiles.map(([l, v, s, hero]) =>
      `<div class="tile"><div class="label">${esc(l)}</div><div class="value${hero ? ' hero' : ''}">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join('');
  }

  function renderCharts(crops) {
    const host = $('#year-charts');
    host.innerHTML = '';
    if (!entries.length) {
      host.innerHTML = `<div class="card empty" style="grid-column:1/-1"><div class="big">🧺</div><p>No harvests logged for ${year} yet. Charts appear here once you add some.</p></div>`;
      return;
    }
    const card = (title, hint, cls = '') => {
      const c = document.createElement('div');
      c.className = 'card ' + cls;
      c.innerHTML = `<div class="card-head"><div><h2>${esc(title)}</h2>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div><div class="ctl"></div></div><div class="chart"></div>`;
      host.appendChild(c);
      return c;
    };

    // 1. Totals by crop
    const groups = ['weight', 'count', 'bunch'].map(ms => ({
      title: MEASURE_LABEL[ms],
      rows: crops.filter(c => c.measure === ms).map(c => ({
        label: c.name, color: c.color, value: c.mv, display: `${fmt(c.total)} ${c.unit}`,
        tip: `<div class="t-title">${esc(c.name)}</div>` + tipRow(c.color, 'Total', `${fmt(c.total)} ${c.unit}`) +
          tipRow('', 'Pickings', c.picks) + tipRow('', 'Best day', `${shortDate(parseDate(c.best[0]))} · ${fmt(c.best[1])} ${c.unit}`),
      })),
    })).filter(g => g.rows.length);
    charts.bars($('.chart', card('Total by crop', 'Weighed crops are scaled by weight so kg, lb and oz compare fairly')), groups);

    // 2 & 3 share a measure selector
    const measures = ['weight', 'count', 'bunch'].filter(ms => crops.some(c => c.measure === ms));
    if (!measures.includes(measure)) measure = measures[0];
    const inMeasure = entries.filter(h => measureOf(h.unit) === measure);
    const unit = MEASURE_UNIT[measure];
    const ts = inMeasure.map(h => parseDate(h.date));
    let t0 = Math.min(...ts) - 3 * DAY, t1 = Math.max(...ts) + 3 * DAY;
    if (t1 - t0 < 14 * DAY) { const mid = (t0 + t1) / 2; t0 = mid - 7 * DAY; t1 = mid + 7 * DAY; }
    const series = crops.filter(c => c.measure === measure).map(c => ({
      id: c.id, name: c.name, color: c.color,
      points: [...c.days].map(([d, v]) => ({ t: parseDate(d), v: measureValue(v, c.unit) })),
    }));

    const selector = () => measures.length < 2 ? '' :
      `<select class="measure-sel">${measures.map(ms => `<option value="${ms}" ${ms === measure ? 'selected' : ''}>${MEASURE_LABEL[ms]}</option>`).join('')}</select>`;

    const c2 = card('Running total through the season', 'Cumulative harvest; hover to see totals on any date');
    $('.ctl', c2).innerHTML = selector();
    charts.cumulative($('.chart', c2), { key: `cum-${measure}`, series, domain: [t0, t1], unit });

    const c3 = card('Weekly harvest', 'Stacked by crop, weeks start Monday');
    $('.ctl', c3).innerHTML = selector();
    const weekStart = t => { const d = new Date(t).getUTCDay(); return t - ((d + 6) % 7) * DAY; };
    const weeks = [];
    for (let w = weekStart(Math.min(...ts)); w <= Math.max(...ts); w += 7 * DAY) weeks.push({ t: w, parts: [] });
    for (const s of series) {
      for (const w of weeks) {
        const v = s.points.filter(p => p.t >= w.t && p.t < w.t + 7 * DAY).reduce((a, p) => a + p.v, 0);
        w.parts.push({ id: s.id, name: s.name, color: s.color, v });
      }
    }
    charts.weekly($('.chart', c3), { weeks, unit });

    $$('.measure-sel', host).forEach(sel => sel.addEventListener('change', e => { measure = e.target.value; renderCharts(crops); }));

    // 4. Harvest calendar (all crops)
    const all = entries.map(h => parseDate(h.date));
    let a0 = Math.min(...all) - 4 * DAY, a1 = Math.max(...all) + 4 * DAY;
    if (a1 - a0 < 14 * DAY) { const mid = (a0 + a1) / 2; a0 = mid - 7 * DAY; a1 = mid + 7 * DAY; }
    const rows = [...crops].sort((a, b) => a.first.localeCompare(b.first)).map(c => {
      const maxDay = Math.max(...c.days.values());
      return {
        label: c.name, color: c.color,
        events: [...c.days].map(([d, v]) => ({
          t: parseDate(d), size: v / maxDay,
          tip: `<div class="t-title">${esc(longDate(parseDate(d)))}</div>` + tipRow(c.color, c.name, `${fmt(v)} ${c.unit}`),
        })),
      };
    });
    charts.timeline($('.chart', card('Harvest calendar', 'When each crop produced; bigger dot = bigger harvest for that crop', 'wide')), { rows, domain: [a0, a1] });
    $$('.card.wide', host).forEach(c => { c.style.gridColumn = '1 / -1'; });
  }

  function renderTotals(crops) {
    if (!crops.length) { $('#year-totals').innerHTML = '<p class="hint">Nothing logged yet.</p>'; return; }
    $('#year-totals').innerHTML = `<table class="data"><thead><tr>
      <th>Crop</th><th class="num">Total</th><th class="num">Pickings</th><th class="num">Avg / picking</th>
      <th>First harvest</th><th>Last harvest</th><th>Best day</th></tr></thead><tbody>` +
      crops.map(c => `<tr><td><span class="swatch" style="background:${c.color}"></span>${esc(c.name)}</td>
        <td class="num">${fmt(c.total)} ${esc(c.unit)}</td><td class="num">${c.picks}</td>
        <td class="num">${fmt(c.total / c.picks)} ${esc(c.unit)}</td>
        <td>${esc(shortDate(parseDate(c.first)))}</td><td>${esc(shortDate(parseDate(c.last)))}</td>
        <td>${esc(shortDate(parseDate(c.best[0])))} (${fmt(c.best[1])} ${esc(c.unit)})</td></tr>`).join('') +
      '</tbody></table>';
  }

  function renderLog() {
    const present = aggregate(entries);
    const sel = $('#log-filter');
    sel.innerHTML = `<option value="">All crops</option>` + present.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (!present.some(c => String(c.id) === logFilter)) logFilter = '';
    sel.value = logFilter;
    const list = logFilter ? entries.filter(h => String(h.crop_id) === logFilter) : entries;
    if (!list.length) { $('#year-log').innerHTML = '<p class="hint">No entries.</p>'; return; }
    $('#year-log').innerHTML = `<table class="data"><thead><tr><th>Date</th><th>Crop</th><th class="num">Amount</th><th>Notes</th><th></th></tr></thead><tbody>` +
      list.map(h => `<tr class="${h.id === editingId ? 'editing' : ''}"><td>${esc(longDate(parseDate(h.date)))}</td>
        <td><span class="swatch" style="background:${h.color}"></span>${esc(h.crop)}</td>
        <td class="num">${fmt(h.amount, 3)} ${esc(h.unit)}</td><td>${esc(h.notes)}</td>
        <td class="log-actions"><button class="icon-btn" data-edit="${h.id}" title="Edit">✎ Edit</button>
        <button class="icon-btn del" data-del="${h.id}" title="Delete">✕</button></td></tr>`).join('') +
      '</tbody></table>';
  }
  $('#log-filter').addEventListener('change', e => { logFilter = e.target.value; renderLog(); });

  $('#year-log').addEventListener('click', async e => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) {
      const h = entries.find(x => x.id === +ed.dataset.edit);
      if (!h) return;
      editingId = h.id;
      fillCropSelect();
      $('#entry-date').value = h.date;
      $('#entry-crop').value = h.crop_id; updateUnit();
      $('#entry-amount').value = h.amount;
      $('#entry-notes').value = h.notes;
      $('#entry-submit').textContent = 'Save changes';
      $('#entry-cancel').hidden = false;
      $('#entry-title').textContent = 'Edit harvest entry';
      renderLog();
      $('#entry-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#entry-amount').focus();
    } else if (del) {
      const h = entries.find(x => x.id === +del.dataset.del);
      if (!h || !(await confirmDialog('Delete entry?', `${fmt(h.amount)} ${h.unit} of ${h.crop} on ${longDate(parseDate(h.date))}`))) return;
      try {
        await api('DELETE', `/api/harvests/${h.id}`);
        if (editingId === h.id) resetForm();
        await loadYear();
      } catch (err) { toast(err.message, true); }
    }
  });

  // ---------- compare years ----------
  async function renderCompare() {
    const host = $('#harvest-compare');
    const all = await api('GET', '/api/harvests');
    if (!all.length) {
      host.innerHTML = `<div class="card empty"><div class="big">📊</div><p>Once you've logged harvests, you can compare seasons here.</p></div>`;
      return;
    }
    const yrs = [...new Set(all.map(h => +h.date.slice(0, 4)))].sort((a, b) => a - b);
    const palette = isDark() ? SERIES_DARK : SERIES_LIGHT;
    const yearColor = y => palette[yrs.indexOf(y) % palette.length];
    const byYear = new Map(yrs.map(y => [y, aggregate(all.filter(h => +h.date.slice(0, 4) === y))]));
    const cropList = aggregate(all);

    const options = [`<option value="weight">All weighed crops (lb)</option>`].concat(
      cropList.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.unit)})</option>`));
    if (compareCrop !== 'weight' && !cropList.some(c => String(c.id) === compareCrop)) compareCrop = 'weight';

    host.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h2>Season totals by crop</h2><div class="hint">Total harvested and the harvest window (first – last picking) for each year</div></div></div>
        <div class="table-wrap" id="cmp-table"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Season vs season</h2><div class="hint">Running total by date of year; hover to compare</div></div>
          <select id="cmp-crop">${options.join('')}</select></div>
        <div class="chart" id="cmp-cum"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Harvest timing by year</h2><div class="hint">Each dot is a harvest day; bigger dot = bigger harvest</div></div></div>
        <div class="chart" id="cmp-timing"></div>
      </div>
      <div class="row"><a class="btn" href="/api/export/harvests.csv">Export all years (CSV)</a></div>`;
    $('#cmp-crop').value = compareCrop;
    $('#cmp-crop').addEventListener('change', e => { compareCrop = e.target.value; renderCompare(); });

    // table
    const weightTotal = y => byYear.get(y).filter(c => c.measure === 'weight').reduce((s, c) => s + c.mv, 0);
    $('#cmp-table').innerHTML = `<table class="data"><thead><tr><th>Crop</th>${yrs.map(y => `<th class="num">${y}</th>`).join('')}</tr></thead><tbody>` +
      cropList.map(c => `<tr><td><span class="swatch" style="background:${c.color}"></span>${esc(c.name)}</td>` +
        yrs.map(y => {
          const a = byYear.get(y).find(x => x.id === c.id);
          return a ? `<td class="num"><b>${fmt(a.total)} ${esc(a.unit)}</b><div class="hint">${esc(shortDate(parseDate(a.first)))} – ${esc(shortDate(parseDate(a.last)))}</div></td>` : '<td class="num hint">–</td>';
        }).join('') + '</tr>').join('') +
      `<tr><td><b>All weighed crops</b></td>${yrs.map(y => `<td class="num"><b>${fmt(weightTotal(y), 1)} lb</b></td>`).join('')}</tr>` +
      '</tbody></table>';

    // series per year
    const pick = h => (compareCrop === 'weight' ? measureOf(h.unit) === 'weight' : String(h.crop_id) === compareCrop);
    const sel = all.filter(pick);
    const unit = compareCrop === 'weight' ? 'lb' : (cropList.find(c => String(c.id) === compareCrop) || {}).unit || '';
    const series = yrs.map(y => ({
      id: y, name: String(y), color: yearColor(y),
      points: sel.filter(h => +h.date.slice(0, 4) === y).map(h => ({ t: toRefYear(h.date), v: compareCrop === 'weight' ? measureValue(h.amount, h.unit) : h.amount })),
    })).filter(s => s.points.length);
    if (!series.length) {
      $('#cmp-cum').innerHTML = '<p class="hint">No data for this selection.</p>';
      $('#cmp-timing').innerHTML = '';
      return;
    }
    const ts = series.flatMap(s => s.points.map(p => p.t));
    let t0 = Math.min(...ts) - 5 * DAY, t1 = Math.max(...ts) + 5 * DAY;
    if (t1 - t0 < 20 * DAY) { const mid = (t0 + t1) / 2; t0 = mid - 10 * DAY; t1 = mid + 10 * DAY; }
    charts.cumulative($('#cmp-cum'), { key: 'cmp', series, domain: [t0, t1], unit, tipTitle: shortDate });

    // timing rows per year (daily sums)
    const rows = series.map(s => {
      const days = new Map();
      for (const p of s.points) days.set(p.t, (days.get(p.t) || 0) + p.v);
      const max = Math.max(...days.values());
      return {
        label: s.name, color: s.color,
        events: [...days].map(([t, v]) => ({
          t, size: v / max,
          tip: `<div class="t-title">${esc(shortDate(t))}, ${s.name}</div>` + tipRow(s.color, compareCrop === 'weight' ? 'Weighed crops' : (cropList.find(c => String(c.id) === compareCrop) || {}).name, `${fmt(v)} ${unit}`),
        })),
      };
    });
    charts.timeline($('#cmp-timing'), { rows, domain: [t0, t1] });
  }

  return {
    show,
    rerender: () => { if (state.view === 'harvest' && lastRender) lastRender(); },
  };
})();

// ====================================================================
// Crops
// ====================================================================
const cropsView = (() => {
  const unitOptions = sel => UNITS.map(u => `<option value="${u}" ${u === sel ? 'selected' : ''}>${u}</option>`).join('');
  $('#crop-add-unit').innerHTML = unitOptions('lb');

  async function show() {
    await loadCrops();
    const palette = SERIES_LIGHT.concat(['#7a5c3e', '#5a9bb0', '#a3a13a', '#8c4f9f']);
    $('#crop-add-color').value = palette[state.crops.length % palette.length];
    render();
  }

  function render() {
    if (!state.crops.length) {
      $('#crops-table').innerHTML = '<p class="hint">No crops yet. Add tomatoes, cucumbers, beans… above.</p>';
      return;
    }
    $('#crops-table').innerHTML = `<table class="data crops-table"><thead><tr><th>Color</th><th>Name</th><th>Harvest unit</th><th>Used in</th><th></th></tr></thead><tbody>` +
      state.crops.map(c => `<tr data-id="${c.id}">
        <td><input type="color" value="${c.color}" data-f="color"></td>
        <td><input type="text" value="${esc(c.name)}" maxlength="40" data-f="name"></td>
        <td><select data-f="unit">${unitOptions(c.unit)}</select></td>
        <td class="hint">${c.cell_count} ft² planned · ${c.harvest_count} harvests</td>
        <td class="log-actions"><button class="icon-btn del" data-del="${c.id}">✕ Delete</button></td></tr>`).join('') +
      '</tbody></table>';
  }

  $('#crop-add').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await createCrop($('#crop-add-name').value, { color: $('#crop-add-color').value, unit: $('#crop-add-unit').value });
      $('#crop-add-name').value = '';
      await show();
      toast('Crop added');
    } catch (err) { toast(err.message, true); }
  });

  $('#crops-table').addEventListener('change', async e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const crop = state.cropById.get(+tr.dataset.id);
    const body = {
      name: $('[data-f=name]', tr).value, color: $('[data-f=color]', tr).value, unit: $('[data-f=unit]', tr).value,
    };
    if (body.unit !== crop.unit && crop.harvest_count &&
      !(await confirmDialog('Change unit?', `${crop.harvest_count} existing ${crop.name} entries will be relabeled as ${body.unit} (amounts are not converted).`, 'Change unit'))) {
      render();
      return;
    }
    try {
      await api('PUT', `/api/crops/${crop.id}`, body);
      await loadCrops();
      render();
      toast('Saved');
    } catch (err) { toast(err.message, true); await loadCrops(); render(); }
  });

  $('#crops-table').addEventListener('click', async e => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const crop = state.cropById.get(+b.dataset.del);
    if (!(await confirmDialog('Delete crop?', `“${crop.name}” will be removed${crop.cell_count ? ` from ${crop.cell_count} planned squares` : ''}.`))) return;
    try {
      await api('DELETE', `/api/crops/${crop.id}`);
      await show();
    } catch (err) { toast(err.message, true); }
  });

  return { show };
})();

// ====================================================================
// Boot
// ====================================================================
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => harvest.rerender(), 200);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => harvest.rerender());

(async () => {
  try { await loadCrops(); } catch (err) { toast('Cannot reach the server: ' + err.message, true); }
  if (!location.hash) history.replaceState(null, '', '#planner');
  route();
})();
