import { db, ensureAuth } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, getDocsFromCache, onSnapshot, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { todayInZone, nowTimeInZone, schedDate } from './comp-utils.js';

// Stream overlay — a transparent variant of the /display page, built for an OBS
// Browser source. It subscribes to the same live run data, but renders only five
// small blocks pinned to the corners; everything else is transparent so the game
// video shows through. Selection is driven by ?competition=&arena= URL params so a
// fixed OBS URL needs no clicking; a picker is shown only when they're absent.

// Slot types that are not scored via /scoresheet — runs on these never go live on the overlay.
const NON_TEST_SLOT_TYPES = new Set(['inspection', 'poster', 'mapping', 'other']);

// ── STATE ─────────────────────────────────────────────────────────────────────

let selectedCompId   = null;
let selectedArena    = null;
let competitionSlots = {};     // slotId → slot data
let currentRuns      = {};     // runId  → run data
let activeRunId      = null;
let unsubSlots       = null;
let unsubRuns        = null;
let unsubComp        = null;
let unsubFeed        = null;   // live listener on the active run's feed subcollection
let feedRunId        = null;   // which run unsubFeed is currently following
let finalResultSecs  = 20;     // post-submit "Final" flash duration (set on /referee)
let selectedCompTz   = null;   // competition timezone (for "now" in the schedule)
let availableTests   = [];     // [{id, name}] for the "Up Next" test name
let nextUpInterval   = null;   // periodic refresh of the idle "Up Next" card

let timerInterval = null;
let timerState    = null;
let lastScore     = null;
let lastFeedLen   = 0;

// Truthy while the ~10s "Final" flash is showing after a submit.
let finalResultTimer = null;

const MAX_VISIBLE = 4;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await ensureAuth();

  const params = new URLSearchParams(window.location.search);
  const comp   = params.get('competition');
  const arena  = params.get('arena');

  if (comp) {
    const compSnap = await getDoc(doc(db, 'competitions', comp));
    if (compSnap.exists()) {
      if (arena) {
        // Both known (e.g. the OBS URL) → straight to the live overlay.
        selectedCompId = comp;
        selectedArena  = arena;
        startArena();
      } else {
        // Competition known (e.g. from the referee menu) → skip the competition
        // picker and go straight to arena selection.
        await selectCompetition({ id: comp, ...compSnap.data() });
        document.getElementById('picker').hidden  = false;
        document.getElementById('overlay').hidden = true;
      }
      return;
    }
  }

  await showCompPicker();
}

// ── OVERLAY VISIBILITY ──────────────────────────────────────────────────────────

function showOverlay() {
  document.getElementById('picker').hidden  = true;
  document.getElementById('overlay').hidden = false;
}

function hideOverlay() {
  // Fully transparent between runs — nothing is shown.
  document.getElementById('overlay').hidden = true;
}

// ── ARENA LIVE MODE ─────────────────────────────────────────────────────────────

function startArena() {
  teardownListeners();
  activeRunId = null;
  lastScore   = null;
  lastFeedLen = 0;

  document.getElementById('picker').hidden  = true;
  // Stay transparent until a run actually appears.
  hideOverlay();

  // Configurable "Final" flash duration + overlay text width, kept live (set on /referee).
  // Test id → name, loaded once for the "Up Next" idle card.
  getDocs(collection(db, 'competitions', selectedCompId, 'tests'))
    .then(snap => {
      availableTests = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));
      if (!activeRunId && !finalResultTimer) showNextUp();  // refresh idle card with names
    })
    .catch(() => { /* names fall back to testId */ });

  unsubComp = onSnapshot(doc(db, 'competitions', selectedCompId), snap => {
    const data = snap.data() || {};
    const v = Number(data.finalResultSecs);
    finalResultSecs = Number.isFinite(v) && v >= 0 ? v : 20;
    selectedCompTz  = data.timezone || null;

    const overlayEl = document.getElementById('overlay');

    // streamOccupancy: 30–100 (%). Unset/invalid ⇒ 100. Scales the name pills' width.
    let occ = Number(data.streamOccupancy);
    if (!Number.isFinite(occ)) occ = 100;
    occ = Math.min(100, Math.max(30, occ));
    overlayEl.style.setProperty('--ov-occupancy', occ / 100);

    // streamPillOpacity: 30–100 (%). Unset/invalid ⇒ 72 (the original look).
    // Controls how opaque/black the info-pill backgrounds are.
    let alpha = Number(data.streamPillOpacity);
    if (!Number.isFinite(alpha)) alpha = 72;
    alpha = Math.min(100, Math.max(30, alpha));
    overlayEl.style.setProperty('--pill-alpha', alpha / 100);

    if (activeRunId) fitTestName();   // available width changed — re-fit the name
  });

  // This arena's slots only — the overlay never shows other arenas.
  unsubSlots = onSnapshot(
    query(collection(db, 'competitions', selectedCompId, 'slots'), where('arena', '==', selectedArena)),
    snap => {
      competitionSlots = {};
      snap.docs.forEach(d => { competitionSlots[d.id] = { id: d.id, ...d.data() }; });
      checkActiveRun();
    }
  );

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
  if (unsubComp)  { unsubComp();  unsubComp  = null; }
  if (unsubFeed)  { unsubFeed();  unsubFeed  = null; feedRunId = null; }
  clearInterval(timerInterval);
  timerInterval = null;
  timerState    = null;
  clearTimeout(finalResultTimer);
  finalResultTimer = null;
  if (nextUpInterval) { clearInterval(nextUpInterval); nextUpInterval = null; }
}

function checkActiveRun() {
  // Slots that belong to the selected arena
  const arenaSlotIds = new Set(
    Object.entries(competitionSlots)
      .filter(([, s]) => s.arena === selectedArena)
      .map(([id]) => id)
  );

  // Draft runs for those slots, most recently updated first.
  // Exclude runs on non-scored slot types (inspection/poster/mapping/other) — an
  // in-progress inspection writes a draft run doc but has no test/score/timer, so it
  // must never take over the live screen. Exclusion list (not a 'test' whitelist) so
  // Finals and any future scored slot type keep working.
  const candidates = Object.entries(currentRuns)
    .filter(([, r]) => r.status === 'draft' && r.slotId && arenaSlotIds.has(r.slotId)
      && !NON_TEST_SLOT_TYPES.has(competitionSlots[r.slotId]?.type))
    .sort(([, a], [, b]) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));

  const newActiveRunId = candidates[0]?.[0] ?? null;

  // The run we were showing just dropped out of the draft list. If it was submitted,
  // flash its final result (for the configured duration) before going transparent / next.
  // A duration of 0 disables the final card entirely — fall through to idle / next run.
  if (activeRunId && newActiveRunId !== activeRunId && finalResultSecs > 0
      && currentRuns[activeRunId]?.status === 'submitted') {
    showFinalResult(currentRuns[activeRunId]);
    activeRunId = newActiveRunId;
    return;
  }

  // Hold on the final flash until its timer elapses.
  if (finalResultTimer) {
    activeRunId = newActiveRunId;
    return;
  }

  if (newActiveRunId !== activeRunId) {
    activeRunId   = newActiveRunId;
    lastScore     = null;
    lastFeedLen   = 0;
    clearInterval(timerInterval);
    timerInterval = null;
    timerState    = null;
  }

  if (activeRunId) {
    clearNextUp();
    renderRun(currentRuns[activeRunId]);
    subscribeFeed(activeRunId);
    showOverlay();
    return;
  }

  // No active run — show the "Up Next" card (or go transparent if nothing's scheduled).
  subscribeFeed(null);
  showNextUp();
}

// ── UP NEXT (idle) ──────────────────────────────────────────────────────────────

// The next upcoming test slot for this arena — same selection as /display's idle "Up Next".
function computeNextSlot() {
  const tz = selectedCompTz || undefined;   // undefined → system tz; null would throw in Intl
  const nowDate = todayInZone(tz);
  const nowTime = nowTimeInZone(tz);
  return Object.values(competitionSlots)
    .filter(s => s.arena === selectedArena && (s.type || 'test') === 'test'
      && (s.date > nowDate || (s.date === nowDate && s.time > nowTime)))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0] || null;
}

function to12h(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${String(m ?? 0).padStart(2, '0')} ${ampm}`;
}

function showNextUp() {
  const overlay = document.getElementById('overlay');
  const card    = document.getElementById('ov-nextup');
  const slot    = competitionSlots && Object.keys(competitionSlots).length ? computeNextSlot() : null;

  if (!slot) { clearNextUp(); hideOverlay(); return; }

  const testName = availableTests.find(t => t.id === slot.testId)?.name || slot.testId || '—';
  const teams    = (slot.teams || []).map(t => t.teamName).filter(Boolean).join(' · ');
  const when     = [to12h(slot.time), schedDate(slot.date)].filter(Boolean).join('  ·  ');

  document.getElementById('ov-nextup-test').textContent  = testName;
  document.getElementById('ov-nextup-when').textContent  = when;
  document.getElementById('ov-nextup-teams').textContent = teams;

  card.hidden = false;
  overlay.classList.add('idle-nextup');   // CSS hides the live pills, shows only this card
  showOverlay();

  if (!nextUpInterval) {
    // "Next" advances with wall-clock even without a Firestore change; recompute periodically.
    nextUpInterval = setInterval(() => { if (!activeRunId && !finalResultTimer) showNextUp(); }, 30000);
  }
}

function clearNextUp() {
  document.getElementById('overlay').classList.remove('idle-nextup');
  document.getElementById('ov-nextup').hidden = true;
  if (nextUpInterval) { clearInterval(nextUpInterval); nextUpInterval = null; }
}

// Show a run's final result for the configured duration, then re-evaluate (idle or next run).
function showFinalResult(run) {
  clearInterval(timerInterval);
  timerInterval = null;
  clearNextUp();   // final card must not be hidden by the idle-nextup rule

  // Freeze the corner blocks on the run's final values, then swap feed → final card.
  renderRun(run);
  document.getElementById('ov-final-team').textContent  = run.teamName || '—';
  document.getElementById('ov-final-score').textContent = run.totalScore ?? 0;
  document.getElementById('ov-feed').hidden  = true;
  document.getElementById('ov-final').hidden = false;
  showOverlay();

  clearTimeout(finalResultTimer);
  finalResultTimer = setTimeout(() => {
    finalResultTimer = null;
    document.getElementById('ov-final').hidden = true;
    document.getElementById('ov-feed').hidden  = false;
    checkActiveRun();
  }, finalResultSecs * 1000);
}

// ── RENDER RUN ────────────────────────────────────────────────────────────────

function renderRun(data) {
  document.getElementById('ov-test').textContent = data.testName || data.testId || '—';
  document.getElementById('ov-team').textContent = data.teamName || '—';
  fitTestName();
  updateScore(data.totalScore ?? 0);
  updateTimerState(data.timerState ?? null);
  // The feed comes from its own subcollection listener (subscribeFeed), not the run doc.
}

// Shrink the top-left test name to fit on one line. The pill is nowrap + max-width
// capped, so overflow (scrollWidth > clientWidth) only happens for genuinely long
// names — short ones keep the full CSS font size. Runs after layout via rAF; re-run
// whenever the name or the occupancy width changes.
function fitTestName() {
  const el = document.getElementById('ov-test');
  if (!el) return;
  requestAnimationFrame(() => {
    el.style.fontSize = '';                                    // back to the CSS base
    let size = parseFloat(getComputedStyle(el).fontSize) || 20;
    const MIN = 12;
    while (el.scrollWidth > el.clientWidth && size > MIN) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  });
}

// Follow the active run's append-only feed (runs/{id}/feed) as a scoped listener, so the
// feed isn't carried on every run doc and unrelated updates don't re-fetch it.
function subscribeFeed(runId) {
  if (runId === feedRunId) return;
  if (unsubFeed) { unsubFeed(); unsubFeed = null; }
  feedRunId = runId;
  if (!runId) { updateFeed([]); return; }

  const feedRef = collection(db, 'competitions', selectedCompId, 'runs', runId, 'feed');
  unsubFeed = onSnapshot(query(feedRef, orderBy('t', 'desc'), limit(30)), snap => {
    if (!snap.empty) {
      updateFeed(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } else {
      // Backward-compat: older runs stored the feed inline as `feedEntries`.
      const legacy = currentRuns[runId]?.feedEntries;
      updateFeed(legacy ? [...legacy].sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 30) : []);
    }
  });
}

// ── SCORE ─────────────────────────────────────────────────────────────────────

function updateScore(score) {
  const el = document.getElementById('ov-score-value');
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
  const el     = document.getElementById('ov-time-value');
  const card   = document.getElementById('ov-time');
  const status = document.getElementById('ov-time-status');

  if (!timerState) {
    el.textContent     = '—';
    status.textContent = 'TIME';
    card.classList.remove('running', 'paused', 'expired');
    return;
  }

  const { initialSecs, startedAt, elapsedBeforePause } = timerState;
  const isRunning = startedAt !== null;

  // Live wall-clock computation — keeps the overlay in sync with /display.
  let elapsed = elapsedBeforePause || 0;
  if (isRunning) elapsed += (Date.now() - startedAt) / 1000;

  const remaining = Math.max(0, initialSecs - elapsed);
  el.textContent  = fmt(Math.round(remaining));

  card.classList.toggle('running', isRunning && remaining > 0);
  card.classList.toggle('paused',  !isRunning && remaining > 0 && elapsed > 0);
  card.classList.toggle('expired', remaining === 0);

  status.textContent = remaining === 0 ? 'TIME UP'
                     : isRunning       ? 'RUNNING'
                     : elapsed > 0     ? 'PAUSED'
                     :                   'TIME';
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── FEED ──────────────────────────────────────────────────────────────────────

function updateFeed(feed) {
  const pill = document.getElementById('ov-feed');
  const list = document.getElementById('ov-feed-list');
  const isNew = feed.length > lastFeedLen;
  lastFeedLen = feed.length;

  pill.hidden = feed.length === 0;
  list.innerHTML = '';

  feed.slice(0, MAX_VISIBLE).forEach((entry, idx) => {
    const item = document.createElement('div');
    item.className = 'feed-item';
    if (idx === 0 && isNew) item.classList.add('feed-new');
    else if (idx >= 2)      item.classList.add('feed-oldest');
    else if (idx >= 1)      item.classList.add('feed-old');

    // Corrections (an undone/removed action) are tagged so viewers can tell them
    // apart from a real penalty. The signed delta + colour still show the change.
    const isUndo   = entry.kind === 'undo';
    if (isUndo) item.classList.add('feed-undo');
    const sign     = entry.delta >= 0 ? '+' : '';
    const deltaCls = entry.delta >= 0 ? 'positive' : 'negative';
    item.innerHTML = `
      <span class="feed-label">${isUndo ? '<span class="feed-undo-mark">↩</span> ' : ''}${entry.label}</span>
      <span class="feed-delta ${deltaCls}">${sign}${entry.delta}</span>
    `;
    list.appendChild(item);
  });
}

// ── SETUP PICKER (only when ?competition / ?arena are absent) ────────────────────

async function showCompPicker() {
  const compsRef = collection(db, 'competitions');

  // Paint from cache instantly (from a prior visit / another page), then refresh from the
  // server. build() clears and re-renders, so calling it twice is safe.
  const build = (docs) => {
    const comps = docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.name && c.active)
      .sort((a, b) => {
        if (a.adminCreated !== b.adminCreated) return a.adminCreated ? -1 : 1;
        return (b.year || 0) - (a.year || 0);
      });

    const list = document.getElementById('pk-comp-list');
    list.innerHTML = '';
    for (const comp of comps) {
      const btn = document.createElement('button');
      btn.className = 'pk-item';
      btn.innerHTML = `
        <div>
          <div>${comp.name}</div>
          ${comp.city || comp.country
            ? `<div class="pk-item-sub">${[comp.city, comp.country].filter(Boolean).join(', ')}</div>`
            : ''}
        </div>
        <span class="pk-item-arrow">›</span>
      `;
      btn.addEventListener('click', () => selectCompetition(comp));
      list.appendChild(btn);
    }

    document.getElementById('pk-comp-list').hidden     = false;
    document.getElementById('pk-arena-section').hidden = true;
    document.getElementById('pk-obs').hidden           = true;
    document.getElementById('pk-sub').textContent      = 'Select a competition';
    document.getElementById('picker').hidden           = false;
    document.getElementById('overlay').hidden          = true;
  };

  try {
    const cached = await getDocsFromCache(compsRef);
    if (!cached.empty) build(cached.docs);
  } catch (_) { /* no cache yet */ }

  const fresh = await getDocs(compsRef);
  build(fresh.docs);
}

async function selectCompetition(comp) {
  selectedCompId = comp.id;

  const compSnap = await getDoc(doc(db, 'competitions', comp.id));
  const arenas   = (compSnap.exists() ? compSnap.data().arenas : []) || [];

  const list = document.getElementById('pk-arena-list');
  list.innerHTML = '';

  if (arenas.length === 0) {
    list.innerHTML = '<div class="pk-empty">No arenas configured for this competition.</div>';
  } else {
    for (const arena of arenas) {
      const btn = document.createElement('button');
      btn.className = 'pk-item';
      btn.innerHTML = `<div>${arena}</div><span class="pk-item-arrow">›</span>`;
      btn.addEventListener('click', () => selectArena(arena));
      list.appendChild(btn);
    }
  }

  document.getElementById('pk-comp-list').hidden     = true;
  document.getElementById('pk-arena-section').hidden = false;
  document.getElementById('pk-obs').hidden           = true;
  document.getElementById('pk-sub').textContent      = comp.name;
}

function selectArena(arena) {
  selectedArena = arena;

  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ competition: selectedCompId, arena }).toString();
  const urlStr = url.toString();

  // Reflect the choice in the address bar so a refresh keeps the selection.
  history.replaceState(null, '', urlStr);

  document.getElementById('pk-obs-url').value   = urlStr;
  document.getElementById('pk-arena-section').hidden = true;
  document.getElementById('pk-obs').hidden           = false;
  document.getElementById('pk-sub').textContent      =
    `${selectedArena} — ready for OBS`;
}

document.getElementById('pk-back-to-comp').addEventListener('click', showCompPicker);

document.getElementById('pk-obs-copy').addEventListener('click', async () => {
  const input = document.getElementById('pk-obs-url');
  const btn   = document.getElementById('pk-obs-copy');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
});

document.getElementById('pk-obs-open').addEventListener('click', () => {
  startArena();
});

// ── GO ────────────────────────────────────────────────────────────────────────

// Space Mono metrics can change the name's width once the font loads — re-fit then.
if (document.fonts?.ready) {
  document.fonts.ready.then(() => { if (activeRunId) fitTestName(); });
}

init().catch(err => console.error(err));
