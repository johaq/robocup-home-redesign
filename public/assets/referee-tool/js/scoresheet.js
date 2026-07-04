import { db, auth, ensureAuth, ensureRefereeAuth } from './firebase.js';
import {
  doc, collection, getDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp, writeBatch
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

// One id per page load. Every write we send tags itself with this id, so the
// live listener can tell "this snapshot is just my own write echoing back"
// apart from "this is a genuine change from another tab/device" — without
// any time-based guessing, and without ever suppressing a real collaborator's
// update.
const clientId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

// Track authenticated referee for audit logging
let currentReferee = null;
let isOnline = navigator.onLine;
let hasPendingSave = false;
let saveFailed = false;
let isSubmitted = false;
let unlockTimeout = null;
// Public read-only mode: a non-referee opened the sheet while the competition's
// `publicScoresheets` flag is on. The page renders live scores but performs ZERO
// writes (also enforced server-side by firestore.rules) and hides all edit chrome.
let readOnly = false;

let testDef   = null;
let scores    = {};   // live score state
// Append-only Scoring Activity log. We only ever ADD events (an undo is its own
// negative entry), so the persisted feed (runs/{id}/feed subcollection) is a faithful
// trace that can never diverge from local state. This buffer holds events not yet
// written to Firestore.
let pendingFeed = [];  // [{label, delta, t, id, writer, elapsed?, kind?}]
let saveTimer = null;

// Tracks elapsed seconds on the main timer so feed entries can record a timestamp
let getMainTimerElapsed = () => null;

// Named timer handles (not a positional array) so the live listener can
// target the right one directly, regardless of whether this test has a main
// time limit at all.
let mainTimerHandle     = null;
let restartTimerHandles = [];
let timerHandles        = []; // flat list, used by the reset button only

// Whether the run has been marked as draft — reset so the next timer start re-triggers it
let draftMarked = false;

// Restart timer state synced to Firestore for live display
let restartTaken = false;

let unsubscribeRunListener = null;

// ── CONNECTION & OFFLINE STATUS ───────────────────────────────────────────────

function updateConnectionStatus() {
  const statusEl = document.getElementById('connection-status');
  if (!statusEl) return;
  
  if (!isOnline) {
    statusEl.innerHTML = '⚠ Offline – changes will sync when reconnected';
    statusEl.style.display = 'block';
    statusEl.classList.add('offline');
  } else if (saveFailed) {
    statusEl.innerHTML = '⚠ Save failed <button id="retry-save-btn" class="retry-btn">Retry</button>';
    statusEl.style.display = 'block';
    statusEl.classList.add('error');
    document.getElementById('retry-save-btn').addEventListener('click', () => attemptSave('draft'));
  } else {
    statusEl.style.display = 'none';
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  // Decide the access mode WITHOUT forcing a login first.
  // - An existing referee/admin session → full editor (unchanged behaviour).
  // - Otherwise, if the competition allows public score sheets → anonymous read-only.
  // - Otherwise → the referee login wall, exactly as before.
  await auth.authStateReady();
  if (auth.currentUser?.email) {
    currentReferee = { email: auth.currentUser.email, uid: auth.currentUser.uid };
  } else {
    const compSnap = await getDoc(doc(db, 'competitions', competitionId));
    if (compSnap.exists() && compSnap.data().publicScoresheets === true) {
      readOnly = true;
      await ensureAuth();   // anonymous session; never shows the login overlay
      currentReferee = { email: null, uid: auth.currentUser?.uid || null };
    } else {
      const user = await ensureRefereeAuth();
      currentReferee = { email: user.email, uid: user.uid };
    }
  }

  // Set up online/offline detection
  window.addEventListener('online', () => {
    isOnline = true;
    updateConnectionStatus();
    if (saveFailed) {
      // Try automatic retry on reconnect
      setTimeout(() => attemptSave('draft'), 500);
    }
  });
  window.addEventListener('offline', () => {
    isOnline = false;
    updateConnectionStatus();
  });

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

  // Load existing run state if already started. This single read is what
  // makes "accidentally hit back / closed the tab, then reopened" resume
  // correctly — including the timers — with no live listener required.
  const snap = await getDoc(runRef);
  let alreadySubmitted  = false;
  let savedTimerState   = null;
  let savedRestartState = null;
  if (snap.exists()) {
    const data = snap.data();
    scores            = data.scores       || {};
    restartTaken      = data.restartTaken || false;
    savedTimerState   = data.timerState   || null;
    savedRestartState = data.restartState || null;
    document.getElementById('notes').value = data.notes || '';
    if (data.status === 'submitted') { alreadySubmitted = true; if (!readOnly) lockForm(); }
  }

  renderScoreSheet();
  refreshAll();
  updateTotal();

  document.getElementById('test-name').textContent = testDef.name;
  document.getElementById('team-name').textContent = teamName;

  // Team banner at the very top of the scrolling body. On mobile the header team name
  // shrinks to keep the timer visible; this (CSS: mobile-only) makes the team unmistakable
  // when you start scoring. It scrolls away with the content, as requested.
  const teamBanner = document.createElement('div');
  teamBanner.className = 'sheet-body-team';
  teamBanner.textContent = teamName;
  const bodyEl = document.getElementById('sheet-body');
  bodyEl.insertBefore(teamBanner, bodyEl.firstChild);

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
    if (readOnly) return;
    document.getElementById('reset-confirm').hidden = true;
    scores = {};
    pendingFeed = [];
    document.getElementById('notes').value = '';
    refreshAll();
    updateTotal();
    timerHandles.forEach(h => h.reset());
    draftMarked = false;
    isSubmitted = false;
    allowEdits(); // Ensure all controls are re-enabled
    try { await deleteDoc(runRef); } catch (e) { /* non-critical */ }
    setSaveStatus('Reset.');
    setTimeout(() => setSaveStatus(''), 2000);
    // Reset submit button to normal state
    const submitBtn = document.getElementById('submit-btn');
    submitBtn.textContent = 'Submit Score Sheet';
    submitBtn.disabled = false;
    submitBtn.classList.remove('submitted-btn', 'unlock-btn');
    submitBtn.onclick = submitRun;
    if (unlockTimeout) clearTimeout(unlockTimeout);
  });

  // Unlock dialog handlers
  document.getElementById('unlock-confirm-cancel').addEventListener('click', () => {
    document.getElementById('unlock-confirm').hidden = true;
  });
  document.getElementById('unlock-confirm-ok').addEventListener('click', () => {
    document.getElementById('unlock-confirm').hidden = true;
    unlockForm();
  });

  // Back link — honour an explicit ?back= (e.g. opened from the team-scores page),
  // otherwise fall back to the dashboard.
  const backLink = document.getElementById('back-link');
  if (backLink) backLink.href = p.get('back') || `${window.__siteBase || ''}/dashboard?competition=${competitionId}`;

  // Prev / Next team links — load slot to find team order
  const slotSnap = await getDoc(doc(db, 'competitions', competitionId, 'slots', slotId));
  if (slotSnap.exists()) {
    const teams = slotSnap.data().teams || [];
    const idx   = teams.findIndex(t => t.teamId === teamId);

    function teamLink(team) {
      return (window.__siteBase || '') + '/scoresheet?' + new URLSearchParams({
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

  const restartSync = async state => {
    if (readOnly) return;
    if (state.startedAt !== null || state.elapsedBeforePause > 0) restartTaken = true;
    try {
      await setDoc(runRef, { restartState: state, restartTaken, lastWriter: clientId }, { merge: true });
    } catch (_) { /* non-critical */ }
  };

  if (testDef.timeLimit) {
    mainTimerHandle = makeTimer(testDef.timeLimit * 60,
      document.getElementById('timer'),
      document.getElementById('timer-start-btn'),
      document.getElementById('timer-reset-btn'),
      60,
      async state => {
        if (readOnly) return;
        try {
          await setDoc(runRef, { timerState: state, lastWriter: clientId }, { merge: true });
          if (!draftMarked && state.startedAt !== null) {
            draftMarked = true;
            await saveRun('draft');
          }
        } catch (e) { /* non-critical */ }
      },
      savedTimerState
    );
    getMainTimerElapsed = mainTimerHandle.getElapsed;
  }

  restartTimerHandles = [
    makeTimer(30, document.getElementById('timer-30s'),  document.getElementById('t30-start'), document.getElementById('t30-reset'),  5, restartSync, savedRestartState),
    makeTimer(60, document.getElementById('timer-1min'), document.getElementById('t1m-start'), document.getElementById('t1m-reset'), 10, restartSync, savedRestartState),
  ];

  timerHandles = mainTimerHandle ? [mainTimerHandle, ...restartTimerHandles] : restartTimerHandles;

  // If the sheet was opened already-submitted, lockForm() ran (during the initial
  // read above) before these timer handles existed — lock their controls now.
  if (isSubmitted) timerHandles.forEach(h => h.setLocked(true));

  // Public read-only: hide all edit chrome and lock the timers (display only).
  if (readOnly) applyReadOnly();

  // Live sync — a single listener, set up after the timer handles exist so it
  // can call into them directly. We skip any snapshot that's just the echo of
  // our own write (`lastWriter === clientId`) and apply everything else —
  // i.e. a genuine change made from another tab/device — immediately.
  unsubscribeRunListener = onSnapshot(runRef, (remoteSnap) => {
    // Handle document deletion (reset from another tab)
    if (!remoteSnap.exists()) {
      scores = {};
      pendingFeed = [];
      restartTaken = false;
      isSubmitted = false;
      document.getElementById('notes').value = '';
      refreshAll();
      updateTotal();
      timerHandles.forEach(h => h.reset());

      // Edit-only UI reset — skipped in read-only (no submit button / edit controls).
      if (!readOnly) {
        allowEdits();
        const btn = document.getElementById('submit-btn');
        btn.textContent = 'Submit Score Sheet';
        btn.disabled = false;
        btn.classList.remove('submitted-btn', 'unlock-btn');
        btn.onclick = submitRun;
        if (unlockTimeout) clearTimeout(unlockTimeout);
        setSaveStatus('Score sheet reset.');
        setTimeout(() => setSaveStatus(''), 2000);
      }
      return;
    }

    const data = remoteSnap.data();

    // Submit/unlock UI machinery is edit-mode only. In read-only we just display
    // scores; the lock state and unlock button must never appear.
    if (!readOnly) {
      // Handle external submission (another tab submitted)
      if (data.status === 'submitted' && !isSubmitted) {
        isSubmitted = true;
        disallowEdits();
        const btn = document.getElementById('submit-btn');
        btn.textContent = 'Submitted ✓';
        btn.classList.add('submitted-btn');
        setSaveStatus('Score sheet submitted.');

        // Show unlock button after 5 seconds
        if (unlockTimeout) clearTimeout(unlockTimeout);
        unlockTimeout = setTimeout(() => {
          btn.textContent = '🔓 Unlock';
          btn.disabled = false;
          btn.classList.remove('submitted-btn');
          btn.classList.add('unlock-btn');
          btn.onclick = () => {
            document.getElementById('unlock-confirm').hidden = false;
          };
        }, 5000);
      }
      // Handle external unlock (another tab unlocked or reset)
      else if (data.status !== 'submitted' && isSubmitted) {
        // Call unlockForm to handle all button and state updates consistently
        isSubmitted = false;
        unlockFormWithoutPersist();
      }
    }

    if (data.lastWriter === clientId) return;

    if (data.scores) {
      scores = data.scores;
      refreshAll();
      updateTotal();
    }
    // No feed sync needed: the scoresheet doesn't render the activity log, and the
    // append-only runs/{id}/feed subcollection is the single source of truth for /display.

    if (data.restartTaken !== undefined) restartTaken = data.restartTaken;

    const notesEl = document.getElementById('notes');
    if (data.notes !== undefined && notesEl.value !== data.notes) notesEl.value = data.notes;

    if (data.timerState && mainTimerHandle) mainTimerHandle.restoreState(data.timerState);
    if (data.restartState) restartTimerHandles.forEach(h => h.restoreState(data.restartState));
  });

  window.addEventListener('beforeunload', (e) => {
    // Warn user if there are unsaved changes (debounce window active) — but not if submitted
    if (!isSubmitted && hasPendingSave && saveTimer !== null) {
      e.preventDefault();
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
      return e.returnValue;
    }
  });

  window.addEventListener('unload', () => {
    if (unsubscribeRunListener) unsubscribeRunListener();
  });

  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
}

// Public read-only presentation: a CSS class hides all edit chrome (footer/submit/
// reset/notes, timer controls, aux timers) and neutralises the score controls, and we
// lock the timers so they only display. Writes are already gated off (and rules-denied).
function applyReadOnly() {
  document.getElementById('app').classList.add('read-only');
  (timerHandles || []).forEach(h => h.setLocked?.(true));
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
    scheduleSave({ label: item.label, delta: scores[item.id] ? item.points : -item.points, kind: scores[item.id] ? undefined : 'undo' });
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
        syncPctDisplay(pen.id, scores[pen.id] || 0, afterFixedPts(item, scores));
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
      // Fixed penalty changes the base for percentage penalties — refresh their displays
      const base = afterFixedPts(parentItem, scores);
      for (const p of (parentItem.penalties || [])) {
        if (p.type === 'percentage') syncPctDisplay(p.id, scores[p.id] || 0, base);
      }
      updateTotal();
      scheduleSave({ label: pen.label, delta: e.target.checked ? -pen.points : pen.points, kind: e.target.checked ? undefined : 'undo' });
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
      const base = afterFixedPts(parentItem, scores);
      syncPctDisplay(pen.id, pct, base);
      const ptsEl2 = itemEl(parentItem.id)?.querySelector('.item-pts');
      if (ptsEl2) ptsEl2.textContent = `+${itemPts(parentItem)}`;
      updateTotal();
      const delta = Math.round((oldPct - pct) / 100 * base);
      scheduleSave(delta !== 0 ? { label: pen.label, delta, kind: delta > 0 ? 'undo' : undefined } : undefined);
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
    scheduleSave({ label: mod.label, delta: e.target.checked ? mod.points : -mod.points, kind: e.target.checked ? undefined : 'undo' });
  });
  return row;
}

function syncPctDisplay(penId, pct, basePoints) {
  const el = document.querySelector(`[data-pct-display="${penId}"]`);
  if (el) el.textContent = `−${Math.round(pct / 100 * basePoints)}`;
}

// Points remaining on an item after its fixed penalties are applied.
// Percentage penalties use this as their base so they compound on top of fixed deductions.
function afterFixedPts(item, scoreObj) {
  let pts = item.points;
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'fixed' && scoreObj[pen.id]) pts -= pen.points;
  }
  return pts;
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
      <span class="count-value">0</span>${item.maxCount ? `<span class="count-max">/ ${item.maxCount}</span>` : ''}
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
      scheduleSave({ label: item.label, delta: (newCount - oldCount) * item.points, kind: newCount < oldCount ? 'undo' : undefined });
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => e.key === 'Enter' && commit());
  });

  header.querySelector('.minus').addEventListener('click', () => {
    if (getCount(item) === 0) return;
    setCount(item, getCount(item) - 1);
    refreshCount(item); updateTotal();
    scheduleSave({ label: item.label, delta: -item.points, kind: 'undo' });
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
        // Fixed penalty changes the base — refresh percentage displays in this instance
        const instNow = scores[item.id][idx];
        const base = afterFixedPts(item, instNow);
        for (const p of (item.penalties || [])) {
          if (p.type === 'percentage') {
            const span = penContainer.querySelector(`[data-pen-pct="${p.id}"]`);
            if (span) span.textContent = `−${Math.round((instNow[p.id] || 0) / 100 * base)}`;
          }
        }
        updateInstanceSummary(item, idx);
        updateTotal();
        scheduleSave({ label: pen.label, delta: e.target.checked ? -pen.points : pen.points, kind: e.target.checked ? undefined : 'undo' });
      });
    } else if (pen.type === 'percentage') {
      const pct = inst[pen.id] || 0;
      const base = afterFixedPts(item, inst);
      penRow.innerHTML = `
        <span class="penalty-label">${pen.label}</span>
        <div class="pct-group">
          <input type="number" class="pct-input" min="0" max="100" value="${pct}">
          <span class="pct-unit">%</span>
          <span class="penalty-pts" data-pen-pct="${pen.id}">−${Math.round(pct / 100 * base)}</span>
        </div>
      `;
      penRow.querySelector('input').addEventListener('input', e => {
        const oldPct = scores[item.id][idx][pen.id] || 0;
        const v = clamp(parseInt(e.target.value) || 0, 0, 100);
        scores[item.id][idx][pen.id] = v;
        const instNow = scores[item.id][idx];
        const b = afterFixedPts(item, instNow);
        penRow.querySelector(`[data-pen-pct="${pen.id}"]`).textContent = `−${Math.round(v / 100 * b)}`;
        updateInstanceSummary(item, idx);
        updateTotal();
        const delta = Math.round((oldPct - v) / 100 * b);
        scheduleSave(delta !== 0 ? { label: pen.label, delta, kind: delta > 0 ? 'undo' : undefined } : undefined);
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
      scheduleSave({ label: mod.label, delta: e.target.checked ? mod.points : -mod.points, kind: e.target.checked ? undefined : 'undo' });
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
      <span class="count-value">0</span>${item.maxCount ? `<span class="count-max">/ ${item.maxCount}</span>` : ''}
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
    scheduleSave({ label: item.label, delta: item.points, kind: 'undo' });   // removing a penalty restores points
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

// ── REFRESH ALL (on initial load / remote update from Firestore) ─────────────

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
  // Fixed penalties first, then percentage applies to the reduced pts
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'fixed' && inst[pen.id]) pts -= pen.points;
  }
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'percentage' && inst[pen.id]) pts -= Math.round(inst[pen.id] / 100 * pts);
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
    // Fixed penalties first, then percentage applies to the reduced pts
    for (const pen of (item.penalties || [])) {
      if (pen.type === 'fixed' && scores[pen.id]) pts -= pen.points;
    }
    for (const pen of (item.penalties || [])) {
      if (pen.type === 'percentage' && scores[pen.id]) pts -= Math.round(scores[pen.id] / 100 * pts);
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
  const total = testDef.sections
    .flatMap(s => s.items)
    .reduce((sum, item) => sum + itemPts(item), 0);
  // A team's score can never be negative — penalties bring the total down to 0 at most.
  return Math.max(0, total);
}

function updateTotal() {
  document.getElementById('total-score').textContent = calculateTotal();
}

// ── FIRESTORE ─────────────────────────────────────────────────────────────────

function scheduleSave(feedEvent) {
  if (readOnly) return;
  hasPendingSave = true;

  // Append-only: every scoring action — including an undo (which arrives here as its
  // own signed delta) — becomes a new entry. Nothing is ever removed. `kind: 'undo'`
  // marks corrections (set by the handler) so the display can flag them.
  if (feedEvent && feedEvent.delta !== 0) {
    const elapsed = getMainTimerElapsed();
    const t = Date.now();
    const entry = { label: feedEvent.label, delta: feedEvent.delta, t };
    if (elapsed !== null)     entry.elapsed = elapsed;
    if (feedEvent.kind)       entry.kind    = feedEvent.kind;
    entry.id     = `${t}_${Math.random().toString(36).slice(2)}`;
    entry.writer = currentReferee?.email || 'unknown';
    pendingFeed.push(entry);
  }
  setSaveStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await attemptSave('draft');
    saveTimer = null;
  }, 800);
}

// Serialize all writes through one chain so a draft save that is already in flight
// finishes before the next save (e.g. submit) starts — otherwise two concurrent
// merges race and the submit could land before a draft, leaving status as 'draft'.
let saveChain = Promise.resolve();
function serializeSave(status) {
  const next = saveChain.then(() => saveRun(status), () => saveRun(status));
  saveChain = next.catch(() => {});   // keep the chain alive even if a save fails
  return next;
}

async function attemptSave(status) {
  try {
    await serializeSave(status);
  } catch (err) {
    saveFailed = true;
    updateConnectionStatus();
  }
}

async function saveRun(status) {
  if (readOnly) return;
  // Snapshot-and-clear the append buffer before the (async) write so a scoring action
  // during the write goes to the next batch; restore on failure so it retries.
  const toAppend = pendingFeed;
  pendingFeed = [];
  try {
    const updateData = {
      competitionId, slotId, teamId, teamName, testId,
      testName: testDef.name,
      scores,
      restartTaken,
      notes:      document.getElementById('notes').value,
      totalScore: calculateTotal(),
      status,
      lastWriter: clientId,
      lastWriterEmail: currentReferee?.email || 'unknown',
      updatedAt:  serverTimestamp(),
    };

    if (status === 'submitted') {
      updateData.submittedAt = serverTimestamp();
      updateData.submittedBy = currentReferee?.email || 'unknown';
    }

    // Append-only activity log lives in the runs/{id}/feed subcollection — one
    // immutable doc per event (keyed by its stable id, so writes are idempotent).
    // Keeping it out of the run doc stops unrelated pages downloading the whole feed.
    if (toAppend.length > 0) {
      const batch = writeBatch(db);
      batch.set(runRef, updateData, { merge: true });
      for (const { id, ...rest } of toAppend) {
        batch.set(doc(collection(runRef, 'feed'), id), rest);
      }
      await batch.commit();
    } else {
      await setDoc(runRef, updateData, { merge: true });
    }

    hasPendingSave = false;
    saveFailed = false;
    updateConnectionStatus();

    if (status === 'draft') {
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(''), 2000);
    }
  } catch (err) {
    pendingFeed = [...toAppend, ...pendingFeed];   // restore unsaved events for retry
    setSaveStatus('Save failed — check connection');
    console.error('Save error:', err);
    saveFailed = true;
    throw err;
  }
}

async function submitRun() {
  if (readOnly) return;
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  // Cancel any pending debounced draft save. Otherwise it fires ~1.2s later, writes
  // status back to 'draft', and the live listener reverts the button — which is why
  // submit sometimes appeared to need a second press.
  clearTimeout(saveTimer);
  saveTimer = null;
  hasPendingSave = false;
  try {
    await serializeSave('submitted');   // waits for any in-flight draft save first
    lockForm();
  } catch {
    btn.disabled = false;
    btn.textContent = 'Submit Score Sheet';
  }
}

function disallowEdits() {
  // Pause every timer and lock its controls (start/stop/reset) while submitted.
  // render() re-derives the buttons' disabled state from this lock, so it can no
  // longer re-enable them the way plain `btn.disabled = true` was being undone.
  (timerHandles || []).forEach(h => { h.pause?.(); h.setLocked?.(true); });
  
  // Disable all score buttons (boolean, count, penalties, etc.)
  const scoreButtons = document.querySelectorAll('.boolean-toggle, .count-btn, .penalty-check, .pct-input');
  scoreButtons.forEach(btn => {
    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '0.6';
  });
  
  // Disable reset button
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.disabled = true;
  
  // Disable notes textarea
  const notesTA = document.getElementById('notes');
  if (notesTA) notesTA.disabled = true;
  
  // Mark as submitted for visual state
  const app = document.getElementById('app');
  if (app) app.classList.add('submitted-state');
}

function allowEdits() {
  // Unlock every timer's controls (start/stop/reset)
  (timerHandles || []).forEach(h => h.setLocked?.(false));
  
  // Enable all score buttons
  const scoreButtons = document.querySelectorAll('.boolean-toggle, .count-btn, .penalty-check, .pct-input');
  scoreButtons.forEach(btn => {
    btn.disabled = false;
    btn.style.pointerEvents = 'auto';
    btn.style.opacity = '1';
  });
  
  // Enable reset button
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.disabled = false;
  
  // Enable notes textarea
  const notesTA = document.getElementById('notes');
  if (notesTA) notesTA.disabled = false;
  
  // Remove submitted visual state
  const app = document.getElementById('app');
  if (app) app.classList.remove('submitted-state');
}

function lockForm() {
  isSubmitted = true;
  disallowEdits();
  
  const btn = document.getElementById('submit-btn');
  btn.textContent = 'Submitted ✓';
  btn.classList.add('submitted-btn');
  
  setSaveStatus('Score sheet submitted.');
  
  // Show unlock button after 5 seconds
  if (unlockTimeout) clearTimeout(unlockTimeout);
  unlockTimeout = setTimeout(() => {
    btn.textContent = '🔓 Unlock';
    btn.disabled = false;
    btn.classList.remove('submitted-btn');
    btn.classList.add('unlock-btn');
    btn.onclick = () => {
      document.getElementById('unlock-confirm').hidden = false;
    };
  }, 5000);
}

function unlockFormWithoutPersist() {
  // Updates UI state without persisting to Firestore
  // Used both by user-initiated unlocks and listener-detected unlocks
  allowEdits();
  
  const btn = document.getElementById('submit-btn');
  btn.textContent = 'Submit Score Sheet';
  btn.classList.remove('submitted-btn', 'unlock-btn');
  btn.onclick = submitRun;
  btn.disabled = false;
  
  setSaveStatus('Score sheet unlocked.');
  setTimeout(() => setSaveStatus(''), 2000);
  
  // Clear any pending unlock button timeout
  if (unlockTimeout) clearTimeout(unlockTimeout);
}

function unlockForm() {
  if (readOnly) return;
  // User-initiated unlock: update UI and persist to Firestore
  isSubmitted = false;
  unlockFormWithoutPersist();
  
  // Persist unlock to Firestore so other tabs see it
  try {
    setDoc(runRef, { status: 'draft', lastWriter: clientId, updatedAt: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error('Failed to persist unlock:', err);
  }
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

function makeTimer(initialSecs, displayEl, startBtn, resetBtn, warningAt, syncFn, savedState) {
  if (!displayEl || !startBtn || !resetBtn) {
    return { getElapsed: () => null, reset: () => {}, restoreState: () => {}, pause: () => {}, setLocked: () => {} };
  }
  let remaining          = initialSecs;
  let interval           = null;
  let elapsedBeforePause = 0;   // seconds accumulated in previous runs
  let startedAtMs        = null; // Date.now() when last started
  let locked             = false; // when the sheet is submitted: start/stop/reset disabled

  function fmt(s) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function render() {
    displayEl.textContent = fmt(remaining);
    displayEl.classList.toggle('warning', interval !== null && remaining > 0 && remaining <= warningAt);
    displayEl.classList.toggle('expired', remaining === 0);
    startBtn.textContent = interval !== null ? '\u23F8\uFE0E' : '▶';
    startBtn.disabled    = locked || remaining === 0;
    resetBtn.disabled    = locked;
  }

  function tick() {
    // Recompute remaining from wall-clock (elapsed since startedAt) instead of counting
    // down locally. setInterval drifts/stalls when the tab is backgrounded; recomputing
    // keeps this in lock-step with the live /display, which derives time the same way.
    const prev = remaining;
    const elapsed = elapsedBeforePause + Math.round((Date.now() - startedAtMs) / 1000);
    remaining = Math.max(0, initialSecs - elapsed);
    if (remaining === 0) {
      elapsedBeforePause = initialSecs;
      startedAtMs = null;
      clearInterval(interval);
      interval = null;
      if (prev > 0) playBeep(440, 0.6);          // long low beep when first hitting 0
    } else if (remaining <= 3 && remaining < prev) {
      playBeep(880, 0.12);                        // short high beep at 3, 2, 1
    }
    render();
  }

  // Shared by initial restore (savedState) and live restore (restoreState):
  // given a startedAt timestamp + prior elapsed seconds, recompute remaining
  // and resume the interval if there's time left. Always uses this timer's
  // own `initialSecs`, never a value from the incoming state object — that
  // matters because the 30s and 60s timers share one synced `restartState`
  // payload despite having different durations.
  function resumeFrom(startedAt, elapsedBefore) {
    elapsedBeforePause = elapsedBefore;
    // Anchor to the ORIGINAL start timestamp from the run doc — NOT Date.now(). Re-anchoring
    // to now dropped the elapsed-since-start, so a reload (or a second referee opening the run)
    // made the countdown jump back toward full on the next tick. Keeping the server timestamp
    // makes tick()/pause()/getElapsed() lock-step with /display, which derives time the same way.
    startedAtMs = startedAt;
    const elapsedSecs = Math.round((Date.now() - startedAt) / 1000);
    remaining = Math.max(0, initialSecs - elapsedBeforePause - elapsedSecs);

    if (remaining > 0) {
      interval = setInterval(tick, 1000);
    } else {
      startedAtMs = null;
      elapsedBeforePause = initialSecs;
    }
  }

  if (savedState) {
    if (savedState.startedAt !== null) {
      resumeFrom(savedState.startedAt, savedState.elapsedBeforePause || 0);
    } else {
      elapsedBeforePause = savedState.elapsedBeforePause || 0;
      remaining = initialSecs - elapsedBeforePause;
    }
  }

  // Returns total elapsed seconds so far (null if timer never started)
  function getElapsed() {
    if (elapsedBeforePause === 0 && startedAtMs === null) return null;
    const live = startedAtMs ? Math.round((Date.now() - startedAtMs) / 1000) : 0;
    return Math.min(initialSecs, elapsedBeforePause + live);
  }

  // Pause programmatically (used on submit/lock); no-op if already paused. Not gated
  // by `locked` so submitting can still force a running timer to stop.
  function pause() {
    if (!interval) return;
    elapsedBeforePause += Math.round((Date.now() - startedAtMs) / 1000);
    remaining = Math.max(0, initialSecs - elapsedBeforePause);  // match the synced paused value
    startedAtMs = null;
    clearInterval(interval);
    interval = null;
    render();
    if (syncFn) syncFn({ initialSecs, startedAt: null, elapsedBeforePause });
  }

  startBtn.addEventListener('click', () => {
    if (locked) return;
    if (interval) {
      pause();
    } else if (remaining > 0) {
      // Start / Resume
      startedAtMs = Date.now();
      interval = setInterval(tick, 1000);
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

  resetBtn.addEventListener('click', () => { if (locked) return; doReset(); });

  render();
  return {
    getElapsed,
    reset: doReset,
    pause,
    setLocked: (v) => { locked = v; render(); },
    restoreState: (newState) => {
      if (!newState) return;
      clearInterval(interval);
      interval = null;
      if (newState.startedAt !== null) {
        resumeFrom(newState.startedAt, newState.elapsedBeforePause || 0);
      } else {
        elapsedBeforePause = newState.elapsedBeforePause || 0;
        remaining = initialSecs - elapsedBeforePause;
        startedAtMs = null;
      }
      render();
    }
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

const itemEl = id => document.querySelector(`.score-item[data-id="${id}"]`);
const clamp  = (v, min, max) => Math.min(max, Math.max(min, v));

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  document.getElementById('loading').textContent = `Error: ${err.message}`;
  console.error(err);
});