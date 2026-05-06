import { db, ensureAuth } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

// ── STATE ─────────────────────────────────────────────────────────────────────

let selectedCompId   = null;
let selectedArena    = null;
let selectedCompTz   = null;   // IANA timezone string for the current competition
let availableTests   = [];     // [{id, name}] for test name lookup
let competitionSlots = {};     // slotId → slot data
let currentRuns      = {};     // runId  → run data
let activeRunId      = null;
let unsubSlots       = null;
let unsubRuns        = null;

// Live-display state
let timerInterval = null;
let timerState    = null;
let lastScore     = null;
let lastFeedLen   = 0;

// Idle rotation state
let idleInterval      = null;
let idleSlideIdx      = 0;
let idleSlides        = [];
const IDLE_SLIDE_SECS = 9;

// ── SCREENS ───────────────────────────────────────────────────────────────────

function showScreen(id) {
  for (const el of document.querySelectorAll(
    '#screen-loading, #screen-comp, #screen-arena, #screen-waiting, #screen-idle, #screen-live'
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

  const testsSnap   = await getDocs(collection(db, 'competitions', comp.id, 'tests'));
  availableTests    = testsSnap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));

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
  lastScore      = null;
  lastFeedLen    = 0;

  document.getElementById('waiting-arena-badge').textContent = arena;
  document.getElementById('idle-arena-badge').textContent    = arena;
  document.getElementById('display-arena-badge').textContent = arena;

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
  stopIdleRotation();
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
    stopIdleRotation();
    renderRun(currentRuns[activeRunId]);
    showScreen('screen-live');
    return;
  }

  // No active run — idle rotation
  const slides = buildIdleSlides();
  if (slides.length > 0) {
    startIdleRotation(slides);
  } else {
    stopIdleRotation();
    showScreen('screen-waiting');
  }
}

// ── IDLE ROTATION ─────────────────────────────────────────────────────────────

function buildIdleSlides() {
  const slides = [];

  // Per-task leaderboards — best run per team per test, across all arenas
  const submittedRuns = Object.values(currentRuns)
    .filter(r => r.status === 'submitted' && r.teamId && r.testId);

  const byTest = {};
  for (const { testId, testName, teamId, teamName, totalScore } of submittedRuns) {
    if (!byTest[testId]) byTest[testId] = { testName: testName || testId, best: {} };
    const score = totalScore || 0;
    if (!byTest[testId].best[teamId] || score > byTest[testId].best[teamId].score) {
      byTest[testId].best[teamId] = { teamName: teamName || teamId, score };
    }
  }

  const overallTotals = {};
  for (const [, { testName, best }] of Object.entries(byTest)) {
    const ranked = Object.values(best).sort((a, b) => b.score - a.score);
    slides.push({ type: 'task', testName, ranked });
    for (const [teamId, { teamName, score }] of Object.entries(best)) {
      if (!overallTotals[teamId]) overallTotals[teamId] = { teamName, score: 0 };
      overallTotals[teamId].score += score;
    }
  }

  // Overall standings (only useful with ≥ 2 tests or if one test shows differently)
  const overall = Object.values(overallTotals).sort((a, b) => b.score - a.score);
  if (overall.length >= 2 && slides.length >= 1) {
    slides.push({ type: 'overall', ranked: overall });
  }

  // Next scheduled test in this arena
  const nowDate = new Intl.DateTimeFormat('sv', { timeZone: selectedCompTz }).format(new Date());
  const nowTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: selectedCompTz, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date()).replace('.', ':');

  const nextSlot = Object.values(competitionSlots)
    .filter(s => s.arena === selectedArena && (s.type || 'test') === 'test'
              && (s.date > nowDate || (s.date === nowDate && s.time > nowTime)))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0] ?? null;

  if (nextSlot) slides.push({ type: 'nextup', slot: nextSlot });

  return slides;
}

function startIdleRotation(slides) {
  idleSlides = slides;
  document.getElementById('idle-arena-badge').textContent = selectedArena;

  if (idleInterval) {
    // Already rotating: refresh data for current slide without resetting timer
    if (idleSlideIdx >= idleSlides.length) idleSlideIdx = 0;
    renderIdleSlide(false);
    return;
  }

  idleSlideIdx = 0;
  showScreen('screen-idle');
  renderIdleSlide(true);

  idleInterval = setInterval(() => {
    idleSlideIdx = (idleSlideIdx + 1) % idleSlides.length;
    renderIdleSlide(true);
  }, IDLE_SLIDE_SECS * 1000);
}

function stopIdleRotation() {
  clearInterval(idleInterval);
  idleInterval = null;
  idleSlideIdx = 0;
  idleSlides   = [];
}

function renderIdleSlide(animate) {
  const slide = idleSlides[idleSlideIdx];
  if (!slide) return;

  // Dots
  document.getElementById('idle-dots').innerHTML = idleSlides
    .map((_, i) => `<span class="idle-dot${i === idleSlideIdx ? ' active' : ''}"></span>`)
    .join('');

  const titleEl = document.getElementById('idle-slide-title');
  const bodyEl  = document.getElementById('idle-slide-body');

  if (slide.type === 'task') {
    titleEl.textContent = slide.testName;
    bodyEl.innerHTML    = buildRankHtml(slide.ranked.slice(0, 8));
  } else if (slide.type === 'overall') {
    titleEl.textContent = 'Overall Standings';
    bodyEl.innerHTML    = buildRankHtml(slide.ranked.slice(0, 8));
  } else if (slide.type === 'nextup') {
    const { slot } = slide;
    const testName = availableTests.find(t => t.id === slot.testId)?.name || slot.testId || '—';
    const teams    = (slot.teams || []).map(t => t.teamName).join(' · ');
    titleEl.textContent = 'Up Next';
    bodyEl.innerHTML = `
      <div class="idle-nextup">
        <div class="idle-nextup-time">${slot.time || '—'}</div>
        <div class="idle-nextup-test">${testName}</div>
        ${teams ? `<div class="idle-nextup-teams">${teams}</div>` : ''}
      </div>
    `;
  }

  if (animate) {
    bodyEl.classList.remove('slide-in');
    void bodyEl.offsetWidth;
    bodyEl.classList.add('slide-in');

    const fill = document.getElementById('idle-progress-fill');
    fill.style.transition = 'none';
    fill.style.width      = '0%';
    void fill.offsetWidth;
    fill.style.transition = `width ${IDLE_SLIDE_SECS}s linear`;
    fill.style.width      = '100%';
  }
}

function buildRankHtml(ranked) {
  return ranked.map((entry, i) => `
    <div class="idle-rank-item">
      <span class="idle-rank-pos">${i + 1}</span>
      <span class="idle-rank-name">${entry.teamName}</span>
      <span class="idle-rank-score">${entry.score} pts</span>
    </div>
  `).join('');
}

// ── CHANGE ARENA BUTTONS ──────────────────────────────────────────────────────

document.getElementById('change-arena-btn').addEventListener('click', backToArenaPicker);
document.getElementById('idle-change-btn').addEventListener('click', backToArenaPicker);
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
