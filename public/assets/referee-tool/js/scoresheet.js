import { db, ensureRefereeAuth } from './firebase.js';
import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

// ── URL params ────────────────────────────────────────────────────────────────
// Usage: scoresheet.html?competition=go2026&slot=slot_1&team=42&teamName=Team+Homer&test=doing_laundry
const p             = new URLSearchParams(window.location.search);
const competitionId = p.get('competition') || 'dev';
const slotId        = p.get('slot')        || 'slot_dev';
const teamId        = p.get('team')        || '0';
const teamName      = p.get('teamName')    || 'Unknown Team';
const testId        = p.get('test')        || 'doing_laundry';
const runId         = `${slotId}_${teamId}`;

const runRef = doc(db, 'competitions', competitionId, 'runs', runId);

let testDef   = null;
let scores    = {};   // live score state
let feed      = [];   // [{label, delta, t, elapsed}] newest-first, written to Firestore for live display
let saveTimer = null;

// Tracks elapsed seconds on the main timer so feed entries can record a timestamp
let getMainTimerElapsed = () => null;

// Timer handles — stored so the reset button can reset all timers
let timerHandles = [];

// Whether the run has been marked as draft — reset so the next timer start re-triggers it
let draftMarked = false;

// Restart timer state synced to Firestore for live display
let restartTaken = false;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await ensureRefereeAuth();

  // Load test definition — competition-specific first, then static fallback
  const testDocSnap = await getDoc(doc(db, 'competitions', competitionId, 'tests', testId));
  if (testDocSnap.exists()) {
    testDef = testDocSnap.data();
  } else {
    testDef = await fetch(`assets/referee-tool/tests/${testId}.json`).then(r => {
      if (!r.ok) throw new Error(`Test definition not found: ${testId}`);
      return r.json();
    });
  }

  // Load existing run state if already started
  const snap = await getDoc(runRef);
  let alreadySubmitted = false;
  if (snap.exists()) {
    const data = snap.data();
    scores       = data.scores       || {};
    feed         = data.feed         || [];
    restartTaken = data.restartTaken || false;
    document.getElementById('notes').value = data.notes || '';
    if (data.status === 'submitted') { lockForm(); alreadySubmitted = true; }
  }

  renderScoreSheet();
  refreshAll();
  updateTotal();

  document.getElementById('test-name').textContent = testDef.name;
  document.getElementById('team-name').textContent = teamName;
  document.getElementById('notes').addEventListener('input', () => scheduleSave());
  document.getElementById('submit-btn').addEventListener('click', submitRun);

  // Reset button with confirm overlay
  document.getElementById('reset-btn').addEventListener('click', () => {
    document.getElementById('reset-confirm').hidden = false;
  });
  document.getElementById('reset-confirm-cancel').addEventListener('click', () => {
    document.getElementById('reset-confirm').hidden = true;
  });
  document.getElementById('reset-confirm-ok').addEventListener('click', async () => {
    document.getElementById('reset-confirm').hidden = true;
    scores = {};
    feed   = [];
    document.getElementById('notes').value = '';
    refreshAll();
    updateTotal();
    timerHandles.forEach(h => h.reset());
    draftMarked = false;
    try { await deleteDoc(runRef); } catch (e) { /* non-critical */ }
    setSaveStatus('Reset.');
    setTimeout(() => setSaveStatus(''), 2000);
  });

  // Back link
  const backLink = document.getElementById('back-link');
  if (backLink) backLink.href = `dashboard.html?competition=${competitionId}`;

  // Prev / Next team links — load slot to find team order
  const slotSnap = await getDoc(doc(db, 'competitions', competitionId, 'slots', slotId));
  if (slotSnap.exists()) {
    const teams = slotSnap.data().teams || [];
    const idx   = teams.findIndex(t => t.teamId === teamId);

    function teamLink(team) {
      return 'scoresheet.html?' + new URLSearchParams({
        competition: competitionId, slot: slotId,
        team: team.teamId, teamName: team.teamName, test: testId
      });
    }

    if (idx > 0) {
      const prevLink = document.getElementById('prev-team-link');
      if (prevLink) { prevLink.href = teamLink(teams[idx - 1]); prevLink.hidden = false; }
    }
    if (idx !== -1 && idx < teams.length - 1) {
      const nextLink = document.getElementById('next-team-link');
      if (nextLink) { nextLink.href = teamLink(teams[idx + 1]); nextLink.hidden = false; }
    }

  }

  // Timers — main timer also syncs state to Firestore for live display
  // and marks the run as draft (activates dashboard dot) on first start.
  draftMarked = alreadySubmitted;
  if (testDef.timeLimit) {
    const mainHandle = makeTimer(testDef.timeLimit * 60,
      document.getElementById('timer'),
      document.getElementById('timer-start-btn'),
      document.getElementById('timer-reset-btn'),
      60,
      async state => {
        try {
          await setDoc(runRef, { timerState: state }, { merge: true });
          if (!draftMarked && state.startedAt !== null) {
            draftMarked = true;
            await saveRun('draft');
          }
        } catch (e) { /* non-critical */ }
      }
    );
    getMainTimerElapsed = mainHandle.getElapsed;
    const restartSync = async state => {
      if (state.startedAt !== null || state.elapsedBeforePause > 0) restartTaken = true;
      try { await setDoc(runRef, { restartState: state, restartTaken }, { merge: true }); } catch (_) {}
    };
    timerHandles = [
      mainHandle,
      makeTimer(30,  document.getElementById('timer-30s'),  document.getElementById('t30-start'), document.getElementById('t30-reset'),  5, restartSync),
      makeTimer(60,  document.getElementById('timer-1min'), document.getElementById('t1m-start'), document.getElementById('t1m-reset'), 10, restartSync),
    ];
  } else {
    const restartSync = async state => {
      if (state.startedAt !== null || state.elapsedBeforePause > 0) restartTaken = true;
      try { await setDoc(runRef, { restartState: state, restartTaken }, { merge: true }); } catch (_) {}
    };
    timerHandles = [
      makeTimer(30,  document.getElementById('timer-30s'),  document.getElementById('t30-start'), document.getElementById('t30-reset'),  5, restartSync),
      makeTimer(60,  document.getElementById('timer-1min'), document.getElementById('t1m-start'), document.getElementById('t1m-reset'), 10, restartSync),
    ];
  }

  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
}

// ── RENDERING ─────────────────────────────────────────────────────────────────

function renderScoreSheet() {
  const body = document.getElementById('sheet-body');
  for (const section of testDef.sections) {
    const sec = document.createElement('div');
    sec.className = 'score-section';

    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = section.heading;
    sec.appendChild(h);

    for (const item of section.items) {
      sec.appendChild(renderItem(item));
    }
    body.appendChild(sec);
  }
}

function renderItem(item) {
  switch (item.type) {
    case 'boolean':           return renderBoolean(item);
    case 'count':             return renderCount(item);
    case 'standalone_penalty':return renderStandalonePenalty(item);
    case 'info':              return renderInfo(item);
    default:                  return document.createElement('div');
  }
}

// ── BOOLEAN ───────────────────────────────────────────────────────────────────

function renderBoolean(item) {
  const el = document.createElement('div');
  el.className = 'score-item';
  el.dataset.id = item.id;

  const btn = document.createElement('button');
  btn.className = 'boolean-toggle';
  btn.innerHTML = `
    <div class="check-circle">
      <svg class="check-icon" width="14" height="11" viewBox="0 0 14 11" fill="none">
        <path d="M1.5 5.5L5.5 9.5L12.5 1.5" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <span class="item-label">${item.label}</span>
    <span class="item-pts">+${item.points}</span>
  `;
  el.appendChild(btn);

  const hasSubs = (item.penalties?.length || 0) + (item.modifiers?.length || 0) > 0;
  if (hasSubs) {
    const panel = document.createElement('div');
    panel.className = 'penalties-panel';
    panel.hidden = true;
    for (const mod of (item.modifiers || [])) panel.appendChild(renderModRow(mod));
    for (const pen of (item.penalties || [])) panel.appendChild(renderPenRow(pen, item));
    el.appendChild(panel);
  }

  btn.addEventListener('click', () => {
    scores[item.id] = !scores[item.id];
    if (!scores[item.id]) clearSubScores(item);
    refreshBoolean(item);
    updateTotal();
    scheduleSave({ label: item.label, delta: scores[item.id] ? item.points : -item.points });
  });

  return el;
}

function clearSubScores(item) {
  for (const pen of (item.penalties || [])) delete scores[pen.id];
  for (const mod of (item.modifiers || [])) delete scores[mod.id];
}

function refreshBoolean(item) {
  const el = itemEl(item.id);
  if (!el) return;
  const achieved = !!scores[item.id];
  el.classList.toggle('achieved', achieved);

  const panel = el.querySelector('.penalties-panel');
  if (panel) panel.hidden = !achieved;

  // Sync penalty/modifier inputs with current scores
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'fixed') {
      const cb = el.querySelector(`[data-pen="${pen.id}"]`);
      if (cb) cb.checked = !!scores[pen.id];
    } else if (pen.type === 'percentage') {
      const inp = el.querySelector(`[data-pen="${pen.id}"]`);
      if (inp) {
        inp.value = scores[pen.id] || 0;
        syncPctDisplay(pen.id, scores[pen.id] || 0, item.points);
      }
    }
  }
  for (const mod of (item.modifiers || [])) {
    const cb = el.querySelector(`[data-mod="${mod.id}"]`);
    if (cb) cb.checked = !!scores[mod.id];
  }

  el.querySelector('.item-pts').textContent = `+${itemPts(item)}`;
}

function renderPenRow(pen, parentItem) {
  const row = document.createElement('div');
  row.className = 'penalty-row';

  if (pen.type === 'fixed') {
    row.innerHTML = `
      <input type="checkbox" class="penalty-check" data-pen="${pen.id}">
      <span class="penalty-label">${pen.label}</span>
      <span class="penalty-pts">−${pen.points}</span>
    `;
    row.querySelector('input').addEventListener('change', e => {
      scores[pen.id] = e.target.checked;
      const ptsEl1 = itemEl(parentItem.id)?.querySelector('.item-pts');
      if (ptsEl1) ptsEl1.textContent = `+${itemPts(parentItem)}`;
      updateTotal();
      scheduleSave({ label: pen.label, delta: e.target.checked ? -pen.points : pen.points });
    });
  } else if (pen.type === 'percentage') {
    row.innerHTML = `
      <span class="penalty-label">${pen.label}</span>
      <div class="pct-group">
        <input type="number" class="pct-input" data-pen="${pen.id}" min="0" max="100" value="0">
        <span class="pct-unit">%</span>
        <span class="penalty-pts" data-pct-display="${pen.id}">−0</span>
      </div>
    `;
    row.querySelector('input').addEventListener('input', e => {
      const oldPct = scores[pen.id] || 0;
      const pct    = clamp(parseInt(e.target.value) || 0, 0, 100);
      scores[pen.id] = pct;
      syncPctDisplay(pen.id, pct, parentItem.points);
      const ptsEl2 = itemEl(parentItem.id)?.querySelector('.item-pts');
      if (ptsEl2) ptsEl2.textContent = `+${itemPts(parentItem)}`;
      updateTotal();
      const delta = Math.round((oldPct - pct) / 100 * parentItem.points);
      scheduleSave(delta !== 0 ? { label: pen.label, delta } : undefined);
    });
  }
  return row;
}

function renderModRow(mod) {
  const row = document.createElement('div');
  row.className = 'penalty-row';
  row.innerHTML = `
    <input type="checkbox" class="penalty-check modifier-check" data-mod="${mod.id}">
    <span class="penalty-label">${mod.label}</span>
    <span class="penalty-pts modifier-pts">+${mod.points}</span>
  `;
  row.querySelector('input').addEventListener('change', e => {
    scores[mod.id] = e.target.checked;
    updateTotal();
    scheduleSave({ label: mod.label, delta: e.target.checked ? mod.points : -mod.points });
  });
  return row;
}

function syncPctDisplay(penId, pct, basePoints) {
  const el = document.querySelector(`[data-pct-display="${penId}"]`);
  if (el) el.textContent = `−${Math.round(pct / 100 * basePoints)}`;
}

// ── COUNT ─────────────────────────────────────────────────────────────────────

function hasPenalties(item) {
  return (item.penalties?.length || 0) + (item.modifiers?.length || 0) > 0;
}

function renderCount(item) {
  const el = document.createElement('div');
  el.className = 'score-item';
  el.dataset.id = item.id;

  const header = document.createElement('div');
  header.className = 'count-header';
  header.innerHTML = `
    <span class="item-label">${item.label}</span>
    <div class="count-controls">
      <button class="count-btn minus" aria-label="decrease">−</button>
      <span class="count-value">0</span>
      <button class="count-btn plus" aria-label="increase">+</button>
    </div>
    <span class="item-pts">+0</span>
  `;
  el.appendChild(header);

  if (hasPenalties(item)) {
    el.appendChild(Object.assign(document.createElement('div'), { className: 'instances-panel' }));
  }

  // Tap count value to edit directly
  header.querySelector('.count-value').addEventListener('click', function () {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = 0; inp.max = item.maxCount || 99;
    const oldCount = getCount(item);
    inp.value = oldCount;
    inp.className = 'count-edit';
    this.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = () => {
      const newCount = clamp(parseInt(inp.value) || 0, 0, item.maxCount || 99);
      setCount(item, newCount);
      refreshCount(item);
      updateTotal();
      scheduleSave({ label: item.label, delta: (newCount - oldCount) * item.points });
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => e.key === 'Enter' && commit());
  });

  header.querySelector('.minus').addEventListener('click', () => {
    if (getCount(item) === 0) return;
    setCount(item, getCount(item) - 1);
    refreshCount(item); updateTotal();
    scheduleSave({ label: item.label, delta: -item.points });
  });

  header.querySelector('.plus').addEventListener('click', () => {
    if (item.maxCount && getCount(item) >= item.maxCount) return;
    setCount(item, getCount(item) + 1);
    refreshCount(item); updateTotal();
    scheduleSave({ label: item.label, delta: item.points });
  });

  return el;
}

function getCount(item) {
  const v = scores[item.id];
  if (!v) return 0;
  return Array.isArray(v) ? v.length : v;
}

function setCount(item, n) {
  if (!hasPenalties(item)) {
    scores[item.id] = n;
    return;
  }
  if (!scores[item.id]) scores[item.id] = [];
  while (scores[item.id].length < n) scores[item.id].push({});
  scores[item.id] = scores[item.id].slice(0, n);
}

function refreshCount(item) {
  const el = itemEl(item.id);
  if (!el) return;

  const count = getCount(item);
  const valEl = el.querySelector('.count-value');
  if (valEl) valEl.textContent = count;
  el.querySelector('.item-pts').textContent = `+${itemPts(item)}`;
  el.querySelector('.minus').disabled = count === 0;
  el.querySelector('.plus').disabled = !!(item.maxCount && count >= item.maxCount);
  el.classList.toggle('achieved', count > 0);

  const panel = el.querySelector('.instances-panel');
  if (!panel) return;
  panel.innerHTML = '';
  (scores[item.id] || []).forEach((_, idx) => panel.appendChild(renderInstance(item, idx)));
}

function renderInstance(item, idx) {
  const inst = scores[item.id][idx];
  const row  = document.createElement('div');
  row.className = 'instance-row open';
  row.dataset.idx = idx;

  const pts = instancePts(item, inst);
  row.innerHTML = `
    <div class="instance-header">
      <span class="instance-number">#${idx + 1}</span>
      <span class="instance-summary">${pts} pts</span>
      <span class="chevron">▲</span>
    </div>
    <div class="instance-penalties"></div>
  `;

  row.querySelector('.instance-header').addEventListener('click', () => row.classList.toggle('open'));

  const penContainer = row.querySelector('.instance-penalties');

  for (const pen of (item.penalties || [])) {
    const penRow = document.createElement('div');
    penRow.className = 'penalty-row';

    if (pen.type === 'fixed') {
      penRow.innerHTML = `
        <input type="checkbox" class="penalty-check" ${inst[pen.id] ? 'checked' : ''}>
        <span class="penalty-label">${pen.label}</span>
        <span class="penalty-pts">−${pen.points}</span>
      `;
      penRow.querySelector('input').addEventListener('change', e => {
        scores[item.id][idx][pen.id] = e.target.checked;
        updateInstanceSummary(item, idx);
        updateTotal();
        scheduleSave({ label: pen.label, delta: e.target.checked ? -pen.points : pen.points });
      });
    } else if (pen.type === 'percentage') {
      const pct = inst[pen.id] || 0;
      penRow.innerHTML = `
        <span class="penalty-label">${pen.label}</span>
        <div class="pct-group">
          <input type="number" class="pct-input" min="0" max="100" value="${pct}">
          <span class="pct-unit">%</span>
          <span class="penalty-pts">−${Math.round(pct / 100 * item.points)}</span>
        </div>
      `;
      penRow.querySelector('input').addEventListener('input', e => {
        const oldPct = scores[item.id][idx][pen.id] || 0;
        const v = clamp(parseInt(e.target.value) || 0, 0, 100);
        scores[item.id][idx][pen.id] = v;
        penRow.querySelector('.penalty-pts').textContent = `−${Math.round(v / 100 * item.points)}`;
        updateInstanceSummary(item, idx);
        updateTotal();
        const delta = Math.round((oldPct - v) / 100 * item.points);
        scheduleSave(delta !== 0 ? { label: pen.label, delta } : undefined);
      });
    }
    penContainer.appendChild(penRow);
  }

  for (const mod of (item.modifiers || [])) {
    const modRow = document.createElement('div');
    modRow.className = 'penalty-row';
    modRow.innerHTML = `
      <input type="checkbox" class="penalty-check modifier-check" ${inst[mod.id] ? 'checked' : ''}>
      <span class="penalty-label">${mod.label}</span>
      <span class="penalty-pts modifier-pts">+${mod.points}</span>
    `;
    modRow.querySelector('input').addEventListener('change', e => {
      scores[item.id][idx][mod.id] = e.target.checked;
      updateInstanceSummary(item, idx);
      updateTotal();
      scheduleSave({ label: mod.label, delta: e.target.checked ? mod.points : -mod.points });
    });
    penContainer.appendChild(modRow);
  }

  return row;
}

function updateInstanceSummary(item, idx) {
  const el = itemEl(item.id);
  if (!el) return;
  const row = el.querySelector(`.instance-row[data-idx="${idx}"]`);
  if (row) row.querySelector('.instance-summary').textContent =
    `${instancePts(item, scores[item.id][idx])} pts`;
  el.querySelector('.item-pts').textContent = `+${itemPts(item)}`;
}

// ── STANDALONE PENALTY ────────────────────────────────────────────────────────

function renderStandalonePenalty(item) {
  const el = document.createElement('div');
  el.className = 'score-item standalone-penalty';
  el.dataset.id = item.id;

  const header = document.createElement('div');
  header.className = 'count-header';
  header.innerHTML = `
    <span class="item-label">${item.label}</span>
    <div class="count-controls">
      <button class="count-btn minus" aria-label="decrease">−</button>
      <span class="count-value">0</span>
      <button class="count-btn plus" aria-label="increase">+</button>
    </div>
    <span class="item-pts">−0</span>
  `;
  el.appendChild(header);

  const max = item.maxCount || 99;
  header.querySelector('.minus').addEventListener('click', () => {
    if (!(scores[item.id] > 0)) return;
    scores[item.id]--;
    refreshPenalty(item); updateTotal();
    scheduleSave({ label: item.label, delta: item.points });   // removing a penalty restores points
  });
  header.querySelector('.plus').addEventListener('click', () => {
    if ((scores[item.id] || 0) >= max) return;
    scores[item.id] = (scores[item.id] || 0) + 1;
    refreshPenalty(item); updateTotal();
    scheduleSave({ label: item.label, delta: -item.points });  // adding a penalty costs points
  });

  return el;
}

function refreshPenalty(item) {
  const el = itemEl(item.id);
  if (!el) return;
  const count = scores[item.id] || 0;
  el.querySelector('.count-value').textContent = count;
  el.querySelector('.item-pts').textContent = `−${count * item.points}`;
}

// ── INFO ITEM ─────────────────────────────────────────────────────────────────

function renderInfo(item) {
  const el = document.createElement('div');
  el.className = 'score-item info-item';
  el.textContent = item.label;
  return el;
}

// ── REFRESH ALL (on initial load from Firestore) ──────────────────────────────

function refreshAll() {
  for (const section of testDef.sections) {
    for (const item of section.items) {
      switch (item.type) {
        case 'boolean':            refreshBoolean(item);  break;
        case 'count':              refreshCount(item);    break;
        case 'standalone_penalty': refreshPenalty(item);  break;
      }
    }
  }
}

// ── SCORE CALCULATION ─────────────────────────────────────────────────────────

function instancePts(item, inst) {
  let pts = item.points;
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'fixed'      && inst[pen.id]) pts -= pen.points;
    if (pen.type === 'percentage' && inst[pen.id]) pts -= Math.round(inst[pen.id] / 100 * item.points);
  }
  for (const mod of (item.modifiers || [])) {
    if (mod.type === 'boolean' && inst[mod.id]) pts += mod.points;
    if (mod.type === 'count')                   pts += (inst[mod.id] || 0) * mod.points;
  }
  return pts;
}

function itemPts(item) {
  if (item.type === 'boolean') {
    if (!scores[item.id]) return 0;
    let pts = item.points;
    for (const pen of (item.penalties || [])) {
      if (pen.type === 'fixed'      && scores[pen.id]) pts -= pen.points;
      if (pen.type === 'percentage' && scores[pen.id]) pts -= Math.round(scores[pen.id] / 100 * item.points);
    }
    for (const mod of (item.modifiers || [])) {
      if (mod.type === 'boolean' && scores[mod.id]) pts += mod.points;
      if (mod.type === 'count')                     pts += (scores[mod.id] || 0) * mod.points;
    }
    return pts;
  }
  if (item.type === 'count') {
    const v = scores[item.id];
    if (!v) return 0;
    if (Array.isArray(v)) return v.reduce((s, inst) => s + instancePts(item, inst), 0);
    return v * item.points;
  }
  if (item.type === 'standalone_penalty') {
    return -((scores[item.id] || 0) * item.points);
  }
  return 0;
}

function calculateTotal() {
  return testDef.sections
    .flatMap(s => s.items)
    .reduce((sum, item) => sum + itemPts(item), 0);
}

function updateTotal() {
  document.getElementById('total-score').textContent = calculateTotal();
}

// ── FIRESTORE ─────────────────────────────────────────────────────────────────

function scheduleSave(feedEvent) {
  if (feedEvent && feedEvent.delta !== 0) {
    // Cancel-out: if the most recent feed entry has the same label and the exact
    // opposite delta, the user is simply undoing their last action — remove it
    // instead of appending a new entry.
    if (feed.length > 0
        && feed[0].label === feedEvent.label
        && feed[0].delta === -feedEvent.delta) {
      feed = feed.slice(1);
    } else {
      const elapsed = getMainTimerElapsed();
      const entry = { label: feedEvent.label, delta: feedEvent.delta, t: Date.now() };
      if (elapsed !== null) entry.elapsed = elapsed;
      feed = [entry, ...feed].slice(0, 30);
    }
  }
  setSaveStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveRun('draft');
    saveTimer = null;
  }, 1200);
}

async function saveRun(status) {
  try {
    await setDoc(runRef, {
      competitionId, slotId, teamId, teamName, testId,
      testName: testDef.name,
      scores,
      feed,
      restartTaken,
      notes:      document.getElementById('notes').value,
      totalScore: calculateTotal(),
      status,
      updatedAt:  serverTimestamp(),
      ...(status === 'draft' ? {} : { submittedAt: serverTimestamp() })
    }, { merge: true });
    if (status === 'draft') {
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(''), 2000);
    }
  } catch (err) {
    setSaveStatus('Save failed — check connection');
    console.error('Save error:', err);
    throw err;
  }
}

async function submitRun() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    await saveRun('submitted');
    lockForm();
  } catch {
    btn.disabled = false;
    btn.textContent = 'Submit Score Sheet';
  }
}

function lockForm() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitted ✓';
  document.getElementById('notes').disabled = true;
  setSaveStatus('Score sheet submitted.');
}

function setSaveStatus(msg) {
  document.getElementById('save-status').textContent = msg;
}

// ── TIMERS ────────────────────────────────────────────────────────────────────

function playBeep(freq, duration) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}

function makeTimer(initialSecs, displayEl, startBtn, resetBtn, warningAt, syncFn) {
  if (!displayEl || !startBtn || !resetBtn) return { getElapsed: () => null };
  let remaining          = initialSecs;
  let interval           = null;
  let elapsedBeforePause = 0;   // seconds accumulated in previous runs
  let startedAtMs        = null; // Date.now() when last started

  function fmt(s) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Returns total elapsed seconds so far (null if timer never started)
  function getElapsed() {
    if (elapsedBeforePause === 0 && startedAtMs === null) return null;
    const live = startedAtMs ? Math.round((Date.now() - startedAtMs) / 1000) : 0;
    return Math.min(initialSecs, elapsedBeforePause + live);
  }

  function render() {
    displayEl.textContent = fmt(remaining);
    displayEl.classList.toggle('warning', interval !== null && remaining > 0 && remaining <= warningAt);
    displayEl.classList.toggle('expired', remaining === 0);
    startBtn.textContent = interval !== null ? '\u23F8\uFE0E' : '▶';
    startBtn.disabled    = remaining === 0;
  }

  startBtn.addEventListener('click', () => {
    if (interval) {
      // Pause — snapshot elapsed before clearing interval
      elapsedBeforePause += Math.round((Date.now() - startedAtMs) / 1000);
      startedAtMs = null;
      clearInterval(interval);
      interval = null;
      render();
      if (syncFn) syncFn({ initialSecs, startedAt: null, elapsedBeforePause });
    } else if (remaining > 0) {
      // Start / Resume
      startedAtMs = Date.now();
      interval = setInterval(() => {
        if (--remaining <= 0) {
          remaining = 0;
          elapsedBeforePause = initialSecs;
          startedAtMs = null;
          clearInterval(interval);
          interval = null;
          playBeep(440, 0.6);   // long low beep at 0
        } else if (remaining <= 3) {
          playBeep(880, 0.12);  // short high beep at 3, 2, 1
        }
        render();
      }, 1000);
      render();
      if (syncFn) syncFn({ initialSecs, startedAt: startedAtMs, elapsedBeforePause });
    }
  });

  function doReset() {
    clearInterval(interval);
    interval           = null;
    remaining          = initialSecs;
    elapsedBeforePause = 0;
    startedAtMs        = null;
    render();
    if (syncFn) syncFn({ initialSecs, startedAt: null, elapsedBeforePause: 0 });
  }

  resetBtn.addEventListener('click', doReset);

  render();
  return { getElapsed, reset: doReset };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

const itemEl = id => document.querySelector(`.score-item[data-id="${id}"]`);
const clamp  = (v, min, max) => Math.min(max, Math.max(min, v));

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  document.getElementById('loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
