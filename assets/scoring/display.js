import { db, ensureAuth } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

// ── STATE ─────────────────────────────────────────────────────────────────────

let selectedCompId   = null;
let selectedArena    = null;
let selectedCompTz   = null;   // IANA timezone string for the current competition
let competitionSlots = {};   // slotId → slot data
let currentRuns      = {};   // runId  → run data
let activeRunId      = null;
let lastRunData      = null; // last known run to show while waiting for next
let unsubSlots       = null;
let unsubRuns        = null;

// Live-display state
let timerInterval = null;
let timerState    = null;
let lastScore     = null;
let lastFeedLen   = 0;

// ── SCREENS ───────────────────────────────────────────────────────────────────

function showScreen(id) {
  for (const el of document.querySelectorAll(
    '#screen-loading, #screen-comp, #screen-arena, #screen-waiting, #screen-live'
  )) {
    el.hidden = el.id !== id;
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  showScreen('screen-loading');
  await ensureAuth();

  // If a competition id is in the URL, skip the picker and go straight to arena selection
  const urlParams = new URLSearchParams(window.location.search);
  const preselectedComp = urlParams.get('competition');
  if (preselectedComp) {
    const compSnap = await getDoc(doc(db, 'competitions', preselectedComp));
    if (compSnap.exists()) {
      await selectCompetition({ id: preselectedComp, ...compSnap.data() });
      return;
    }
  }

  await showCompPicker();
}

// ── COMPETITION PICKER ────────────────────────────────────────────────────────

async function showCompPicker() {
  const snap = await getDocs(collection(db, 'competitions'));
  const comps = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.name && c.active)
    .sort((a, b) => {
      if (a.adminCreated !== b.adminCreated) return a.adminCreated ? -1 : 1;
      return (b.year || 0) - (a.year || 0);
    });

  const list = document.getElementById('comp-list');
  list.innerHTML = '';

  for (const comp of comps) {
    const btn = document.createElement('button');
    btn.className = 'picker-item';
    btn.innerHTML = `
      <div>
        <div>${comp.name}</div>
        ${comp.city || comp.country
          ? `<div class="picker-item-sub">${[comp.city, comp.country].filter(Boolean).join(', ')}</div>`
          : ''}
      </div>
      <span class="picker-item-arrow">›</span>
    `;
    btn.addEventListener('click', () => selectCompetition(comp));
    list.appendChild(btn);
  }

  showScreen('screen-comp');
}

// ── ARENA PICKER ──────────────────────────────────────────────────────────────

async function selectCompetition(comp) {
  selectedCompId = comp.id;
  document.getElementById('arena-comp-name').textContent = comp.name;

  // Load full competition doc to get arenas and timezone
  const compSnap    = await getDoc(doc(db, 'competitions', comp.id));
  const compData    = compSnap.exists() ? compSnap.data() : {};
  const arenas      = compData.arenas || [];
  selectedCompTz    = compData.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Load today's slots to show next test times per arena
  const todayStr    = new Intl.DateTimeFormat('sv', { timeZone: selectedCompTz }).format(new Date());
  const nowTime     = new Intl.DateTimeFormat('en-GB', {
    timeZone: selectedCompTz, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date()).replace('.', ':');

  const slotsSnap   = await getDocs(collection(db, 'competitions', comp.id, 'slots'));
  const todaySlots  = slotsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.date === todayStr)
    .sort((a, b) => a.time.localeCompare(b.time));

  // Build hint text per arena: "Now: 14:30" or "Next: 15:00" (test slots only)
  function arenaHint(arena) {
    const arenaSlots = todaySlots.filter(s => s.arena === arena && (s.type || 'test') === 'test');
    if (!arenaSlots.length) return '';
    // Most recent started slot (could still be running)
    const current = [...arenaSlots].reverse().find(s => s.time <= nowTime);
    if (current) return `Now: ${current.time}`;
    // Next upcoming slot
    const next = arenaSlots.find(s => s.time > nowTime);
    if (next) return `Next: ${next.time}`;
    return '';
  }

  const list = document.getElementById('arena-list');
  list.innerHTML = '';

  if (arenas.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);padding:12px 0">No arenas configured for this competition.</div>';
  } else {
    for (const arena of arenas) {
      const hint = arenaHint(arena);
      const btn = document.createElement('button');
      btn.className = 'picker-item';
      btn.innerHTML = `
        <div>
          <div>${arena}</div>
          ${hint ? `<div class="picker-item-sub">${hint}</div>` : ''}
        </div>
        <span class="picker-item-arrow">›</span>
      `;
      btn.addEventListener('click', () => selectArena(arena));
      list.appendChild(btn);
    }
  }

  showScreen('screen-arena');
}

document.getElementById('back-to-comp').addEventListener('click', () => {
  teardownListeners();
  showCompPicker();
});

// ── ARENA LIVE MODE ───────────────────────────────────────────────────────────

function selectArena(arena) {
  teardownListeners();
  selectedArena  = arena;
  activeRunId    = null;
  lastRunData    = null;
  lastScore      = null;
  lastFeedLen    = 0;

  document.getElementById('waiting-arena-badge').textContent = arena;
  document.getElementById('display-arena-badge').textContent  = arena;

  showScreen('screen-waiting');

  // Subscribe to slots — we need these to know which slots belong to this arena
  unsubSlots = onSnapshot(
    collection(db, 'competitions', selectedCompId, 'slots'),
    snap => {
      competitionSlots = {};
      snap.docs.forEach(d => { competitionSlots[d.id] = { id: d.id, ...d.data() }; });
      checkActiveRun();
    }
  );

  // Subscribe to all runs — real-time score/feed/timer updates come through here
  unsubRuns = onSnapshot(
    collection(db, 'competitions', selectedCompId, 'runs'),
    snap => {
      currentRuns = {};
      snap.docs.forEach(d => { currentRuns[d.id] = d.data(); });
      checkActiveRun();
    }
  );
}

function teardownListeners() {
  if (unsubSlots) { unsubSlots(); unsubSlots = null; }
  if (unsubRuns)  { unsubRuns();  unsubRuns  = null; }
  clearInterval(timerInterval);
  timerInterval = null;
  timerState    = null;
  clearInterval(restartInterval);
  restartInterval = null;
  restartState    = null;
}

function checkActiveRun() {
  // Slots that belong to the selected arena
  const arenaSlotIds = new Set(
    Object.entries(competitionSlots)
      .filter(([, s]) => s.arena === selectedArena)
      .map(([id]) => id)
  );

  // Draft runs for those slots, most recently updated first
  const candidates = Object.entries(currentRuns)
    .filter(([, r]) => r.status === 'draft' && r.slotId && arenaSlotIds.has(r.slotId))
    .sort(([, a], [, b]) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));

  const newActiveRunId = candidates[0]?.[0] ?? null;

  if (newActiveRunId !== activeRunId) {
    // Save last run data before switching away
    if (activeRunId && currentRuns[activeRunId]) {
      lastRunData = currentRuns[activeRunId];
    }
    activeRunId   = newActiveRunId;
    lastScore     = null;
    lastFeedLen   = 0;
    clearInterval(timerInterval);
    timerInterval = null;
    timerState    = null;
    clearInterval(restartInterval);
    restartInterval = null;
    restartState    = null;
  }

  if (activeRunId) {
    setStatusBar(false);
    renderRun(currentRuns[activeRunId]);
    showScreen('screen-live');
    return;
  }

  // No active run — find the most recently updated submitted run if we don't
  // already have one from this session.
  if (!lastRunData) {
    const submitted = Object.entries(currentRuns)
      .filter(([, r]) => r.status === 'submitted' && r.slotId && arenaSlotIds.has(r.slotId))
      .sort(([, a], [, b]) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
    if (submitted.length) lastRunData = submitted[0][1];
  }

  if (lastRunData) {
    setStatusBar(true);
    renderRun(lastRunData);
    showScreen('screen-live');
  } else {
    showScreen('screen-waiting');
  }
}

function setStatusBar(visible) {
  document.getElementById('run-status-bar').hidden = !visible;
}

// ── CHANGE ARENA BUTTONS ──────────────────────────────────────────────────────

document.getElementById('change-arena-btn').addEventListener('click', backToArenaPicker);
document.getElementById('live-change-btn').addEventListener('click', backToArenaPicker);

function backToArenaPicker() {
  teardownListeners();
  // Re-show arena picker with current competition
  if (selectedCompId) {
    // Rebuild the arena picker using the competition we already selected
    showScreen('screen-arena');
  } else {
    showCompPicker();
  }
}

// ── RENDER RUN ────────────────────────────────────────────────────────────────

function renderRun(data) {
  document.getElementById('display-test-name').textContent = data.testName || data.testId || '—';
  document.getElementById('display-team-name').textContent = data.teamName || '—';
  updateScore(data.totalScore ?? 0);
  updateTimerState(data.timerState ?? null);
  updateRestartState(data.restartState ?? null, data.restartTaken ?? false);
  updateFeed(data.feed ?? []);
}

// ── SCORE ─────────────────────────────────────────────────────────────────────

function updateScore(score) {
  const el = document.getElementById('live-score');
  el.textContent = score;

  if (lastScore !== null && score !== lastScore) {
    const cls = score > lastScore ? 'flash-positive' : 'flash-negative';
    el.classList.remove('flash-positive', 'flash-negative');
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }
  lastScore = score;
}

// ── TIMER ─────────────────────────────────────────────────────────────────────

function updateTimerState(state) {
  timerState = state;
  if (!timerInterval) {
    timerInterval = setInterval(renderTimer, 500);
  }
  renderTimer();
}

function renderTimer() {
  const el     = document.getElementById('live-timer');
  const card   = document.getElementById('timer-card');
  const status = document.getElementById('timer-status');

  if (!timerState) {
    el.textContent     = '—';
    status.textContent = '';
    card.classList.remove('running', 'paused', 'expired');
    return;
  }

  const { initialSecs, startedAt, elapsedBeforePause } = timerState;
  const isRunning = startedAt !== null;

  let elapsed = elapsedBeforePause || 0;
  if (isRunning) elapsed += (Date.now() - startedAt) / 1000;

  const remaining = Math.max(0, initialSecs - elapsed);
  el.textContent  = fmt(Math.round(remaining));

  card.classList.toggle('running', isRunning && remaining > 0);
  card.classList.toggle('paused',  !isRunning && remaining > 0 && elapsed > 0);
  card.classList.toggle('expired', remaining === 0);

  status.textContent = remaining === 0 ? 'Time up'
                     : isRunning       ? 'Running'
                     : elapsed > 0     ? 'Paused'
                     :                   '';
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── RESTART TIMER ─────────────────────────────────────────────────────────────

let restartInterval = null;
let restartState    = null;

function updateRestartState(state, taken) {
  restartState = state;
  const card   = document.getElementById('restart-card');
  const valEl  = document.getElementById('restart-timer');
  const statEl = document.getElementById('restart-status');

  if (!taken && !state) {
    card.hidden = true;
    clearInterval(restartInterval);
    restartInterval = null;
    return;
  }

  card.hidden = false;
  card.classList.toggle('restart-taken', taken && (!state || (state.startedAt === null && state.elapsedBeforePause === 0)));

  if (!restartInterval) {
    restartInterval = setInterval(renderRestartTimer, 500);
  }
  renderRestartTimer();

  function renderRestartTimer() {
    if (!restartState) {
      valEl.textContent  = '↩';
      statEl.textContent = taken ? 'Used' : '';
      card.classList.remove('running', 'expired');
      return;
    }
    const { initialSecs, startedAt, elapsedBeforePause } = restartState;
    const isRunning = startedAt !== null;
    let elapsed = elapsedBeforePause || 0;
    if (isRunning) elapsed += (Date.now() - startedAt) / 1000;
    const remaining = Math.max(0, initialSecs - elapsed);
    valEl.textContent  = fmt(Math.round(remaining));
    card.classList.toggle('running', isRunning && remaining > 0);
    card.classList.toggle('expired', remaining === 0);
    statEl.textContent = remaining === 0 ? 'Done'
                       : isRunning       ? 'Running'
                       : elapsed > 0     ? 'Paused'
                       : taken           ? 'Used'
                       :                   '';
  }
}

// ── FEED ──────────────────────────────────────────────────────────────────────

const MAX_VISIBLE = 5;

function updateFeed(feed) {
  const list  = document.getElementById('feed-list');
  const empty = document.getElementById('feed-empty');
  const isNew = feed.length > lastFeedLen;
  lastFeedLen = feed.length;

  empty.hidden = feed.length > 0;
  list.innerHTML = '';

  feed.slice(0, MAX_VISIBLE).forEach((entry, idx) => {
    const item = document.createElement('div');
    item.className = 'feed-item';
    if (idx === 0 && isNew)   item.classList.add('feed-new');
    else if (idx >= 3)        item.classList.add('feed-oldest');
    else if (idx >= 1)        item.classList.add('feed-old');

    const sign     = entry.delta >= 0 ? '+' : '';
    const deltaCls = entry.delta >= 0 ? 'positive' : 'negative';
    item.innerHTML = `
      <span class="feed-label">${entry.label}</span>
      <span class="feed-delta ${deltaCls}">${sign}${entry.delta}</span>
    `;
    list.appendChild(item);
  });
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  document.getElementById('screen-loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
