import { db, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from './firebase.js';
import {
  collection, doc, addDoc, getDocs, getDoc, setDoc, updateDoc, deleteDoc,
  writeBatch, query, where, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { convertTexToTest } from './admin-tex.js';
import { bestRunsPerTeamTest } from './score-utils.js';

// Slot types not scored via /scoresheet — mirrors display.js so "Now on display"
// reflects exactly what the live screen picks.
const NON_TEST_SLOT_TYPES = new Set(['inspection', 'poster', 'mapping', 'other']);

// ── STATE ─────────────────────────────────────────────────────────────────────

let currentCompetitionId   = null;
let currentSlotId          = null;
let editingCompId          = null;   // null = create mode, string = edit mode
let editingSlotId          = null;
let currentCompArenas      = [];     // arenas for the current competition
let allTeams               = [];     // loaded once, used for search
let compTests              = [];     // tests for the current competition
let showInactive           = false;  // competitions filter

// ── INIT ──────────────────────────────────────────────────────────────────────

// Admin access requires the `admin` custom claim — the same signal firestore.rules
// checks (isAdmin()). Being signed in with an email is not enough: referees are
// email users WITHOUT the claim, and must not reach the admin app.
async function isAdminUser(user) {
  if (!user?.email) return false;
  try { return (await user.getIdTokenResult()).claims.admin === true; }
  catch { return false; }
}

async function init() {
  // authStateReady() waits until persistent auth state is fully loaded,
  // avoiding a flash of the login screen when the admin reloads the page.
  await auth.authStateReady();

  if (await isAdminUser(auth.currentUser)) {
    showAdminApp();
    await showCompetitions();
  } else {
    showLoginScreen();
  }
}

function showLoginScreen() {
  document.getElementById('screen-login').hidden = false;
  document.getElementById('admin-app').hidden    = true;

  const form      = document.getElementById('login-form');
  const errorEl   = document.getElementById('login-error');
  const loginBtn  = document.getElementById('login-btn');

  form.onsubmit = async e => {
    e.preventDefault();
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    errorEl.hidden = true;
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      if (await isAdminUser(cred.user)) {
        showAdminApp();
        await showCompetitions();
      } else {
        // Valid credentials but not an admin (e.g. a referee account) — don't leave
        // them in a half-signed-in state where every write would fail server-side.
        await signOut(auth);
        errorEl.textContent = 'This account does not have admin access.';
        errorEl.hidden = false;
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign in';
      }
    } catch (err) {
      errorEl.textContent = friendlyAuthError(err.code);
      errorEl.hidden = false;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign in';
    }
  };
}

function showAdminApp() {
  document.getElementById('screen-login').hidden = true;
  document.getElementById('admin-app').hidden    = false;

  document.getElementById('logout-btn').onclick = async () => {
    await signOut(auth);
    document.getElementById('admin-app').hidden    = true;
    document.getElementById('screen-login').hidden = false;
    // Clear login form
    document.getElementById('login-form').reset();
    document.getElementById('login-error').hidden = true;
    document.getElementById('login-btn').disabled = false;
    document.getElementById('login-btn').textContent = 'Sign in';
  };
}

function friendlyAuthError(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.';
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Try again later.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}

// ── BACK BUTTON ───────────────────────────────────────────────────────────────

function setBack(fn) {
  const btn = document.getElementById('back-btn');
  btn.hidden = !fn;
  btn.onclick = fn || null;
}

// ── BREADCRUMB ────────────────────────────────────────────────────────────────

function setBreadcrumb(parts) {
  // parts: [{label, onClick}]
  const el = document.getElementById('breadcrumb');
  el.innerHTML = '';
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      el.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = 'crumb';
    span.textContent = part.label;
    if (part.onClick) span.addEventListener('click', part.onClick);
    else span.style.cursor = 'default';
    el.appendChild(span);
  });
}

// ── SCREEN SWITCHING ──────────────────────────────────────────────────────────

let _screenCleanup = null;

function showScreen(id) {
  if (_screenCleanup) { _screenCleanup(); _screenCleanup = null; }
  document.querySelectorAll('.screen').forEach(s => s.hidden = true);
  document.getElementById(`screen-${id}`).hidden = false;
}

// ── COMPETITIONS SCREEN ───────────────────────────────────────────────────────

async function showCompetitions(afterFn) {
  currentCompetitionId = null;
  currentSlotId        = null;
  setBack(null);
  showScreen('competitions');
  setBreadcrumb([{ label: 'Admin' }, { label: 'Competitions' }]);

  const form      = document.getElementById('comp-form');
  const newBtn    = document.getElementById('new-comp-btn');
  const cancelBtn = document.getElementById('cancel-comp-btn');

  newBtn.onclick = () => {
    editingCompId = null;
    document.getElementById('comp-form-title').textContent = 'New Competition';
    document.querySelector('#comp-form .form-actions .btn-primary').textContent = 'Create';
    document.getElementById('comp-id-field').hidden = false;
    document.getElementById('comp-id').required = true;
    document.getElementById('comp-podium-section').hidden = true;
    document.getElementById('comp-podium-list').innerHTML = '';
    form.reset();
    form.hidden = false;
    newBtn.hidden = true;
  };

  cancelBtn.onclick = () => {
    editingCompId = null;
    document.getElementById('comp-podium-section').hidden = true;
    document.getElementById('comp-podium-list').innerHTML = '';
    form.hidden = true;
    newBtn.hidden = false;
    form.reset();
  };

  form.onsubmit = async e => { e.preventDefault(); await saveCompetition(); };

  // Auto-fill timezone from country when timezone field is empty
  const COUNTRY_TZ = {
    'germany': 'Europe/Berlin', 'austria': 'Europe/Vienna', 'switzerland': 'Europe/Zurich',
    'france': 'Europe/Paris', 'belgium': 'Europe/Brussels', 'luxembourg': 'Europe/Luxembourg',
    'portugal': 'Europe/Lisbon', 'spain': 'Europe/Madrid',
    'italy': 'Europe/Rome', 'netherlands': 'Europe/Amsterdam',
    'poland': 'Europe/Warsaw', 'czech republic': 'Europe/Prague', 'czechia': 'Europe/Prague',
    'hungary': 'Europe/Budapest', 'slovakia': 'Europe/Bratislava',
    'romania': 'Europe/Bucharest', 'bulgaria': 'Europe/Sofia',
    'greece': 'Europe/Athens', 'turkey': 'Europe/Istanbul',
    'sweden': 'Europe/Stockholm', 'norway': 'Europe/Oslo',
    'denmark': 'Europe/Copenhagen', 'finland': 'Europe/Helsinki',
    'uk': 'Europe/London', 'united kingdom': 'Europe/London', 'ireland': 'Europe/Dublin',
    'usa': 'America/New_York', 'united states': 'America/New_York',
    'canada': 'America/Toronto', 'mexico': 'America/Mexico_City',
    'brazil': 'America/Sao_Paulo', 'argentina': 'America/Argentina/Buenos_Aires',
    'chile': 'America/Santiago', 'colombia': 'America/Bogota', 'peru': 'America/Lima',
    'japan': 'Asia/Tokyo', 'south korea': 'Asia/Seoul', 'korea': 'Asia/Seoul',
    'china': 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong', 'taiwan': 'Asia/Taipei',
    'singapore': 'Asia/Singapore', 'thailand': 'Asia/Bangkok',
    'india': 'Asia/Kolkata', 'pakistan': 'Asia/Karachi',
    'uae': 'Asia/Dubai', 'united arab emirates': 'Asia/Dubai',
    'australia': 'Australia/Sydney', 'new zealand': 'Pacific/Auckland',
    'egypt': 'Africa/Cairo', 'south africa': 'Africa/Johannesburg', 'kenya': 'Africa/Nairobi',
  };
  document.getElementById('comp-country').addEventListener('blur', () => {
    const tzField = document.getElementById('comp-timezone');
    if (tzField.value.trim()) return; // don't overwrite if already set
    const country = document.getElementById('comp-country').value.trim().toLowerCase();
    const tz = COUNTRY_TZ[country];
    if (tz) tzField.value = tz;
  });

  await loadCompetitions();
  if (afterFn) afterFn();
}

async function loadCompetitions() {
  const list = document.getElementById('comp-list');
  list.innerHTML = '';

  const snap = await getDocs(collection(db, 'competitions'));

  // All named competitions, adminCreated first then by year desc
  const all = snap.docs
    .map(d => d.data())
    .filter(c => c.name)
    .sort((a, b) => {
      if (a.adminCreated !== b.adminCreated) return a.adminCreated ? -1 : 1;
      return (b.year || 0) - (a.year || 0);
    });

  const inactiveCount = all.filter(c => !c.active).length;
  const comps = showInactive ? all : all.filter(c => c.active);

  // Inactive toggle link
  const toggleWrap = document.getElementById('comp-inactive-toggle');
  if (inactiveCount > 0) {
    toggleWrap.hidden = false;
    const btn = document.createElement('button');
    btn.textContent = showInactive
      ? 'Hide inactive competitions'
      : `${inactiveCount} inactive competition${inactiveCount !== 1 ? 's' : ''} hidden — Show all`;
    btn.onclick = () => { showInactive = !showInactive; loadCompetitions(); };
    toggleWrap.innerHTML = '';
    toggleWrap.appendChild(btn);
  } else {
    toggleWrap.hidden = true;
  }

  if (!comps.length) {
    list.innerHTML = '<div class="empty-state">No active competitions. Create one above or show inactive.</div>';
    return;
  }

  for (const comp of comps) {
    const isActive = !!comp.active;
    const item = document.createElement('div');
    item.className = 'list-item' + (isActive ? '' : ' inactive-comp');
    item.innerHTML = `
      <div class="list-item-main">
        <div class="list-item-title">${comp.name}</div>
        <div class="list-item-sub">${comp.city || ''}${comp.city && comp.country ? ', ' : ''}${comp.country || ''}</div>
      </div>
      <span class="badge">${comp.id}</span>
      <button class="status-pill ${isActive ? 'active' : 'inactive'}" data-action="toggle-active" title="Toggle active status">
        ${isActive ? '● Active' : '○ Inactive'}
      </button>
      <div class="list-item-actions">
        <button class="btn-icon" data-action="edit"   title="Edit">✎</button>
        <button class="btn-icon danger" data-action="delete" title="Delete">×</button>
      </div>
      <span class="list-item-arrow">›</span>
    `;
    item.addEventListener('click', () => showSlots(comp.id, comp.name));

    item.querySelector('[data-action="toggle-active"]').addEventListener('click', e => {
      e.stopPropagation();
      toggleCompActive(comp);
    });

    item.querySelector('[data-action="edit"]').addEventListener('click', e => {
      e.stopPropagation();
      startEditCompetition(comp);
    });

    item.querySelector('[data-action="delete"]').addEventListener('click', e => {
      e.stopPropagation();
      deleteCompetition(comp);
    });

    list.appendChild(item);
  }
}

async function toggleCompActive(comp) {
  const updates = { active: !comp.active };

  if (comp.active) {
    // Deactivating — build podium from final scores, then merge all teams into participatingTeams
    const [runsSnap, slotsSnap] = await Promise.all([
      getDocs(collection(db, 'competitions', comp.id, 'runs')),
      getDocs(collection(db, 'competitions', comp.id, 'slots')),
    ]);

    const slotLeague = {};
    const posterSlotIds = [];
    for (const d of slotsSnap.docs) {
      const data = d.data();
      slotLeague[d.id] = data.league || 'OPL';
      if (data.type === 'poster') posterSlotIds.push(d.id);
    }

    // Load poster scores from all poster slots
    const rawPosterByPresenter = {};
    for (const slotId of posterSlotIds) {
      const psSnap = await getDocs(
        collection(db, 'competitions', comp.id, 'slots', slotId, 'posterScores')
      );
      psSnap.docs.forEach(d => {
        const { judgeTeamId, scores = {} } = d.data();
        for (const [presenterTeamId, raw] of Object.entries(scores)) {
          if (presenterTeamId === judgeTeamId) continue;
          if (!rawPosterByPresenter[presenterTeamId]) rawPosterByPresenter[presenterTeamId] = [];
          rawPosterByPresenter[presenterTeamId].push(raw);
        }
      });
    }
    const posterFinal = {};  // teamId → final score
    for (const [teamId, raws] of Object.entries(rawPosterByPresenter)) {
      const scaled = raws.map(s => s * 5);
      let score;
      if (scaled.length <= 2 * POSTER_OUTLIER_N) {
        score = scaled.reduce((a, b) => a + b, 0) / scaled.length;
      } else {
        const sorted  = [...scaled].sort((a, b) => a - b);
        const trimmed = sorted.slice(POSTER_OUTLIER_N, sorted.length - POSTER_OUTLIER_N);
        score = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
      }
      posterFinal[teamId] = score;
    }

    const submittedRuns = runsSnap.docs.map(d => d.data()).filter(r => r.status === 'submitted');

    if (submittedRuns.length || Object.keys(posterFinal).length) {
      // Best score per team+test, track league via slot
      const bestByTeamTest = bestRunsPerTeamTest(submittedRuns);

      // Sum per team (test runs)
      const totals = {};
      for (const run of Object.values(bestByTeamTest)) {
        const { teamId, teamName, slotId, flooredScore } = run;
        const league = slotLeague[slotId] || 'OPL';
        if (!totals[teamId]) totals[teamId] = { teamName: teamName || teamId, total: 0, leagueCounts: {} };
        totals[teamId].total += flooredScore;
        totals[teamId].leagueCounts[league] = (totals[teamId].leagueCounts[league] || 0) + 1;
      }

      // Add poster scores
      const participatingMap = {};
      (comp.participatingTeams || []).forEach(t => { participatingMap[t.teamId] = t.teamName; });
      for (const [teamId, score] of Object.entries(posterFinal)) {
        const teamName = participatingMap[teamId] || teamId;
        if (!totals[teamId]) totals[teamId] = { teamName, total: 0, leagueCounts: { OPL: 1 } };
        totals[teamId].total += score;
      }

      // Rank within each league
      const byLeague = {};
      for (const [teamId, d] of Object.entries(totals)) {
        const league = Object.entries(d.leagueCounts).sort((a, b) => b[1] - a[1])[0][0];
        if (!byLeague[league]) byLeague[league] = [];
        byLeague[league].push({ teamId, teamName: d.teamName, total: d.total, league });
      }

      const podium = [];
      for (const [league, teams] of Object.entries(byLeague)) {
        teams.sort((a, b) => b.total - a.total);
        teams.forEach((t, i) => podium.push({ place: i + 1, league, teamId: t.teamId, teamName: t.teamName }));
      }
      updates.podium = podium.sort((a, b) => a.place - b.place || a.league.localeCompare(b.league));

      // Merge all ranked teams into participatingTeams
      const existing = comp.participatingTeams || [];
      const existingIds = new Set(existing.map(t => t.teamId));
      const toAdd = Object.entries(totals)
        .filter(([id]) => !existingIds.has(id))
        .map(([teamId, d]) => ({ teamId, teamName: d.teamName }));
      updates.participatingTeams = [...existing, ...toAdd]
        .sort((a, b) => a.teamName.localeCompare(b.teamName));
    } else {
      // No runs — fall back to merging any existing podium into participatingTeams
      const podium = comp.podium || [];
      const existing = comp.participatingTeams || [];
      const existingIds = new Set(existing.map(t => t.teamId));
      const toAdd = podium
        .filter(p => p.teamId && !existingIds.has(p.teamId))
        .map(p => ({ teamId: p.teamId, teamName: p.teamName }));
      if (toAdd.length) {
        updates.participatingTeams = [...existing, ...toAdd]
          .sort((a, b) => a.teamName.localeCompare(b.teamName));
      }
    }
  }

  await updateDoc(doc(db, 'competitions', comp.id), updates);
  await loadCompetitions();
}

function startEditCompetition(comp) {
  editingCompId = comp.id;
  document.getElementById('comp-form-title').textContent = `Edit — ${comp.id}`;
  document.querySelector('#comp-form .form-actions .btn-primary').textContent = 'Save Changes';
  document.getElementById('comp-id-field').hidden = true;
  document.getElementById('comp-id').required = false;
  document.getElementById('comp-name').value       = comp.name       || '';
  document.getElementById('comp-city').value       = comp.city       || '';
  document.getElementById('comp-country').value    = comp.country    || '';
  document.getElementById('comp-year').value       = comp.year       || '';
  document.getElementById('comp-active').checked   = !!comp.active;
  document.getElementById('comp-public-scoresheets').checked = !!comp.publicScoresheets;
  document.getElementById('comp-show-results-qr').checked     = !!comp.showResultsQr;
  document.getElementById('comp-start-date').value = comp.startDate  || '';
  document.getElementById('comp-end-date').value   = comp.endDate    || '';
  document.getElementById('comp-timezone').value    = comp.timezone    || '';
  document.getElementById('comp-stream-url').value  = comp.streamUrl   || '';
  document.getElementById('comp-referee-pin').value = comp.refereePin  || '';

  const podiumSection = document.getElementById('comp-podium-section');
  podiumSection.hidden = false;
  renderPodiumList(comp.podium || []);

  document.getElementById('comp-form').hidden = false;
  document.getElementById('new-comp-btn').hidden = true;
  document.getElementById('comp-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPodiumList(entries) {
  document.getElementById('comp-podium-list').innerHTML = '';
  entries.forEach(e => addPodiumRow(e));
}

function addPodiumRow(entry = {}) {
  const list = document.getElementById('comp-podium-list');
  const row  = document.createElement('div');
  row.className = 'podium-entry';
  row.style.cssText = 'display:flex;gap:6px;align-items:center';
  row.innerHTML = `
    <input class="podium-place" type="number" min="1" max="99" value="${entry.place || ''}" placeholder="#" style="width:52px">
    <select class="podium-league" style="flex-shrink:0">
      <option value="OPL"  ${(entry.league || 'OPL') === 'OPL'  ? 'selected' : ''}>OPL</option>
      <option value="DSPL" ${entry.league === 'DSPL' ? 'selected' : ''}>DSPL</option>
      <option value="SSPL" ${entry.league === 'SSPL' ? 'selected' : ''}>SSPL</option>
    </select>
    <input class="podium-team-name" type="text" value="${entry.teamName || ''}" placeholder="Team name" style="flex:1">
    <input class="podium-team-id"   type="text" value="${entry.teamId   || ''}" placeholder="Team ID (optional)" style="width:140px">
    <button type="button" class="btn-icon danger">×</button>
  `;
  row.querySelector('.btn-icon').onclick = () => row.remove();
  list.appendChild(row);
}

document.getElementById('add-podium-btn').addEventListener('click', () => addPodiumRow());

function readPodiumFromForm() {
  return [...document.querySelectorAll('#comp-podium-list .podium-entry')]
    .map(row => ({
      place:    parseInt(row.querySelector('.podium-place').value)    || 0,
      league:   row.querySelector('.podium-league').value,
      teamName: row.querySelector('.podium-team-name').value.trim(),
      teamId:   row.querySelector('.podium-team-id').value.trim(),
    }))
    .filter(e => e.teamName && e.place)
    .map(e => ({ ...e, teamId: e.teamId || e.teamName }))
    .sort((a, b) => a.place - b.place);
}

async function saveCompetition() {
  const name      = document.getElementById('comp-name').value.trim();
  const city      = document.getElementById('comp-city').value.trim();
  const country   = document.getElementById('comp-country').value.trim();
  const year      = parseInt(document.getElementById('comp-year').value) || null;
  const active    = document.getElementById('comp-active').checked;
  const publicScoresheets = document.getElementById('comp-public-scoresheets').checked;
  const showResultsQr     = document.getElementById('comp-show-results-qr').checked;
  const startDate = document.getElementById('comp-start-date').value || null;
  const endDate   = document.getElementById('comp-end-date').value   || null;
  const timezone  = document.getElementById('comp-timezone').value.trim() || null;
  const streamUrl   = document.getElementById('comp-stream-url').value.trim()   || null;
  const refereePin  = document.getElementById('comp-referee-pin').value.trim()  || null;

  if (!name) return;

  if (editingCompId) {
    const update = { name, city, country, year, active, publicScoresheets, showResultsQr, startDate, endDate, timezone, streamUrl, refereePin };
    if (!document.getElementById('comp-podium-section').hidden) {
      update.podium = readPodiumFromForm();
    }
    await updateDoc(doc(db, 'competitions', editingCompId), update);
  } else {
    const id = document.getElementById('comp-id').value.trim();
    if (!id) return;
    await setDoc(doc(db, 'competitions', id), { id, name, city, country, year, active, publicScoresheets, showResultsQr, startDate, endDate, timezone, streamUrl, refereePin, adminCreated: true });
  }

  editingCompId = null;
  document.getElementById('comp-form').hidden = true;
  document.getElementById('new-comp-btn').hidden = false;
  document.getElementById('comp-form').reset();
  await loadCompetitions();
}

async function deleteCompetition(comp) {
  const confirmed = window.confirm(
    `Delete "${comp.name}" (${comp.id})?\n\nThis will permanently remove all slots, scores, tests, and inspections for this competition. This cannot be undone.`
  );
  if (!confirmed) return;

  // Delete all subcollections before the parent doc
  await deleteSubcollection('competitions', comp.id, 'slots');
  await deleteSubcollection('competitions', comp.id, 'runs');
  await deleteSubcollection('competitions', comp.id, 'tests');
  await deleteSubcollection('competitions', comp.id, 'inspections');
  await deleteDoc(doc(db, 'competitions', comp.id));
  await loadCompetitions();
}

async function deleteSubcollection(...pathSegments) {
  const snap  = await getDocs(collection(db, ...pathSegments));
  if (!snap.empty) {
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

// ── SLOTS SCREEN ──────────────────────────────────────────────────────────────

async function showSlots(competitionId, competitionName) {
  currentCompetitionId = competitionId;
  currentSlotId        = null;
  editingSlotId        = null;
  setBack(showCompetitions);
  showScreen('slots');
  setBreadcrumb([
    { label: 'Competitions', onClick: showCompetitions },
    { label: competitionName }
  ]);
  document.getElementById('slots-title').textContent = competitionName;

  document.getElementById('new-slot-btn').onclick = () => showSchedule(competitionId, competitionName);
  document.getElementById('live-control-btn').onclick = () => showLive(competitionId, competitionName);

  // Arena management
  document.getElementById('add-arena-btn').onclick = addArena;
  document.getElementById('new-arena-name').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); addArena(); }
  };

  // Test file upload
  document.getElementById('test-file-input').onchange = handleTestFileUpload;

  await loadArenas();
  await loadParticipatingTeams();
  await loadTests();
}

// ── LIVE CONTROL ───────────────────────────────────────────────────────────────

let liveRuns   = {};
let liveSlots  = {};
let liveArenas = [];
let closeModalOpen = false;

function liveEsc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function showLive(compId, compName) {
  currentCompetitionId = compId;
  setBack(() => showSlots(compId, compName));
  showScreen('live');
  setBreadcrumb([
    { label: 'Competitions', onClick: showCompetitions },
    { label: compName, onClick: () => showSlots(compId, compName) },
    { label: 'Live control' }
  ]);

  liveRuns = {}; liveSlots = {}; closeModalOpen = false;
  document.getElementById('close-runs-overlay').hidden = true;
  const compSnap = await getDoc(doc(db, 'competitions', compId));
  liveArenas = compSnap.data()?.arenas || [];

  document.getElementById('close-all-runs-btn').onclick   = openCloseRunsModal;
  document.getElementById('close-runs-modal-close').onclick = closeCloseRunsModal;
  document.getElementById('close-runs-cancel').onclick    = closeCloseRunsModal;
  const overlay = document.getElementById('close-runs-overlay');
  overlay.onclick = e => { if (e.target === overlay) closeCloseRunsModal(); };
  document.getElementById('close-runs-confirm').onclick   = () => closeAllRunning(compId);

  const unsubRuns = onSnapshot(collection(db, 'competitions', compId, 'runs'), snap => {
    liveRuns = {};
    snap.docs.forEach(d => { liveRuns[d.id] = d.data(); });
    renderLiveNow(compId);
    if (closeModalOpen) renderCloseRunsList(compId);
  });
  const unsubSlots = onSnapshot(collection(db, 'competitions', compId, 'slots'), snap => {
    liveSlots = {};
    snap.docs.forEach(d => { liveSlots[d.id] = { id: d.id, ...d.data() }; });
    renderLiveNow(compId);
    if (closeModalOpen) renderCloseRunsList(compId);
  });
  _screenCleanup = () => {
    unsubRuns(); unsubSlots();
    closeModalOpen = false;
    document.getElementById('close-runs-overlay').hidden = true;
  };
}

// Describe a run for the live lists (team / test label / arena / score).
function liveRunInfo(runId) {
  const run  = liveRuns[runId] || {};
  const slot = liveSlots[run.slotId] || {};
  const type = slot.type || 'test';
  let testLabel;
  if      (type === 'inspection') testLabel = 'Inspection';
  else if (type === 'poster')     testLabel = 'Poster session';
  else if (type === 'mapping')    testLabel = 'Arena mapping';
  else if (type === 'other')      testLabel = slot.label || 'Other';
  else testLabel = run.testName || run.testId || slot.testId || 'Test';
  return {
    type,
    arena: slot.arena || '—',
    team:  run.teamName || run.teamId || '—',
    score: run.totalScore ?? 0,
    testLabel,
  };
}

// The draft run each arena's /display is currently showing — same selection as display.js.
function displayedRunForArena(arena) {
  const candidates = Object.entries(liveRuns)
    .filter(([, r]) => r.status === 'draft' && r.slotId
      && liveSlots[r.slotId]?.arena === arena
      && !NON_TEST_SLOT_TYPES.has(liveSlots[r.slotId]?.type))
    .sort(([, a], [, b]) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
  return candidates[0]?.[0] ?? null;
}

function renderLiveNow(compId) {
  const el = document.getElementById('live-now-list');
  if (!el) return;
  const arenaSet = new Set(liveArenas);
  Object.values(liveSlots).forEach(s => { if (s.arena) arenaSet.add(s.arena); });
  const arenas = [...arenaSet].sort();

  el.innerHTML = '';
  if (!arenas.length) {
    el.innerHTML = '<div class="live-row-idle">No arenas configured.</div>';
    return;
  }
  for (const arena of arenas) {
    const runId = displayedRunForArena(arena);
    const row = document.createElement('div');
    row.className = 'live-row';
    if (!runId) {
      row.innerHTML = `<span class="live-row-arena">${liveEsc(arena)}</span><span class="live-row-idle">— idle —</span>`;
    } else {
      const info = liveRunInfo(runId);
      row.innerHTML = `
        <span class="live-row-arena">${liveEsc(arena)}</span>
        <div class="live-row-main">
          <span class="live-row-team">${liveEsc(info.team)}</span>
          <span class="live-row-test">${liveEsc(info.testLabel)}</span>
        </div>
        <span class="live-row-score">${info.score}</span>
        <button class="btn-ghost btn-sm" data-action="end">End</button>
      `;
      row.querySelector('[data-action="end"]').onclick = () => endRun(compId, runId);
    }
    el.appendChild(row);
  }
}

async function endRun(compId, runId) {
  const info = liveRunInfo(runId);
  if (!window.confirm(`Force "${info.team} — ${info.testLabel}" off the display? This does not submit a score.`)) return;
  try {
    await updateDoc(doc(db, 'competitions', compId, 'runs', runId), {
      status: 'closed', updatedAt: serverTimestamp(),
    });
  } catch (err) {
    alert(`Could not close run: ${err.message}`);
  }
}

// All currently-running (draft) runs, newest first — for the emergency close-all modal.
function runningRunIds() {
  return Object.entries(liveRuns)
    .filter(([, r]) => r.status === 'draft')
    .map(([id]) => id)
    .sort((a, b) => (liveRuns[b].updatedAt?.seconds ?? 0) - (liveRuns[a].updatedAt?.seconds ?? 0));
}

function openCloseRunsModal() {
  closeModalOpen = true;
  document.getElementById('close-runs-overlay').hidden = false;
  renderCloseRunsList(currentCompetitionId);
}

function closeCloseRunsModal() {
  closeModalOpen = false;
  document.getElementById('close-runs-overlay').hidden = true;
}

function renderCloseRunsList(compId) {
  const el = document.getElementById('close-runs-list');
  const confirmBtn = document.getElementById('close-runs-confirm');
  if (!el) return;
  const ids = runningRunIds();
  el.innerHTML = '';
  if (!ids.length) {
    el.innerHTML = '<div class="live-row-idle">No runs are currently running.</div>';
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Close ALL running';
    return;
  }
  confirmBtn.disabled = false;
  confirmBtn.textContent = `Close ALL running (${ids.length})`;
  for (const runId of ids) {
    const info = liveRunInfo(runId);
    const row = document.createElement('div');
    row.className = 'live-row';
    row.innerHTML = `
      <span class="live-row-arena">${liveEsc(info.arena)}</span>
      <div class="live-row-main">
        <span class="live-row-team">${liveEsc(info.team)}</span>
        <span class="live-row-test">${liveEsc(info.testLabel)}</span>
      </div>
      <span class="live-row-score">${info.score}</span>
      <button class="btn-ghost btn-sm" data-action="end">End</button>
    `;
    row.querySelector('[data-action="end"]').onclick = () => endRun(compId, runId);
    el.appendChild(row);
  }
}

async function closeAllRunning(compId) {
  const ids = runningRunIds();
  if (!ids.length) { closeCloseRunsModal(); return; }
  if (!window.confirm(`Close ${ids.length} running run${ids.length !== 1 ? 's' : ''}? They will be removed from the display and will NOT count on the results leaderboard.`)) return;
  try {
    const batch = writeBatch(db);
    ids.forEach(id => batch.update(doc(db, 'competitions', compId, 'runs', id), {
      status: 'closed', updatedAt: serverTimestamp(),
    }));
    await batch.commit();
    closeCloseRunsModal();
  } catch (err) {
    alert(`Could not close runs: ${err.message}`);
  }
}

// ── ARENA MANAGEMENT ─────────────────────────────────────────────────────────

async function loadArenas() {
  const snap = await getDoc(doc(db, 'competitions', currentCompetitionId));
  currentCompArenas = snap.data()?.arenas || [];

  // Enable/disable the schedule button based on arena count
  const schedBtn = document.getElementById('new-slot-btn');
  if (schedBtn) {
    schedBtn.disabled = currentCompArenas.length === 0;
    schedBtn.title    = currentCompArenas.length === 0
      ? 'Add at least one arena before editing the schedule'
      : '';
  }

  const chipsEl = document.getElementById('arena-chips');
  if (!currentCompArenas.length) {
    chipsEl.innerHTML = '<span style="color:var(--muted);font-size:0.85rem">No arenas added yet.</span>';
  } else {
    chipsEl.innerHTML = '';
    for (const a of currentCompArenas) {
      const chip = document.createElement('span');
      chip.className = 'arena-chip';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'arena-chip-name';
      nameSpan.textContent = a;
      nameSpan.title = 'Click to rename';
      nameSpan.style.cursor = 'text';

      nameSpan.addEventListener('click', () => {
        // Replace the name span with an inline input
        const inp = document.createElement('input');
        inp.className = 'arena-chip-input';
        inp.value = a;
        chip.replaceChild(inp, nameSpan);
        inp.focus();
        inp.select();

        async function commit() {
          const newName = inp.value.trim();
          chip.replaceChild(nameSpan, inp);
          if (!newName || newName === a) return;
          await renameArena(a, newName);
        }
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter')  { e.preventDefault(); inp.blur(); }
          if (e.key === 'Escape') { inp.value = a; inp.blur(); }
        });
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'arena-chip-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => removeArena(a));

      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);
      chipsEl.appendChild(chip);
    }
  }
}

async function addArena() {
  const input = document.getElementById('new-arena-name');
  const name  = input.value.trim();
  if (!name || currentCompArenas.includes(name)) return;
  await updateDoc(doc(db, 'competitions', currentCompetitionId), {
    arenas: [...currentCompArenas, name]
  });
  input.value = '';
  await loadArenas();
}

async function renameArena(oldName, newName) {
  if (currentCompArenas.includes(newName)) {
    alert(`Arena "${newName}" already exists.`);
    await loadArenas(); // re-render to restore chip
    return;
  }

  // Update the arena list on the competition doc
  const newArenas = currentCompArenas.map(a => a === oldName ? newName : a);
  await updateDoc(doc(db, 'competitions', currentCompetitionId), { arenas: newArenas });

  // Update all slots that reference the old arena name
  const slotsSnap = await getDocs(collection(db, 'competitions', currentCompetitionId, 'slots'));
  const batch = writeBatch(db);
  slotsSnap.docs.forEach(d => {
    if (d.data().arena === oldName) batch.update(d.ref, { arena: newName });
  });
  await batch.commit();
  await loadArenas();
}

async function removeArena(name) {
  // Check if any slots are assigned to this arena
  const slotsSnap = await getDocs(collection(db, 'competitions', currentCompetitionId, 'slots'));
  const assigned  = slotsSnap.docs.filter(d => d.data().arena === name);
  if (assigned.length) {
    alert(`Cannot remove arena "${name}" — ${assigned.length} slot${assigned.length !== 1 ? 's are' : ' is'} assigned to it. Move or delete those slots first.`);
    return;
  }
  await updateDoc(doc(db, 'competitions', currentCompetitionId), {
    arenas: currentCompArenas.filter(a => a !== name)
  });
  await loadArenas();
}

// ── TESTS MANAGEMENT ──────────────────────────────────────────────────────────

async function loadTests() {
  const snap = await getDocs(collection(db, 'competitions', currentCompetitionId, 'tests'));
  // compTests only holds real Firestore tests — full data with sections
  compTests = snap.docs.map(d => d.data()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  renderTestList();
}

function renderTestList() {
  const el = document.getElementById('test-list');
  if (!compTests.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:4px 0 8px">No tests added yet.</div>';
    return;
  }
  el.innerHTML = '';
  for (const test of compTests) {
    const row = document.createElement('div');
    row.className = 'test-list-item';
    row.innerHTML = `
      <div class="test-name">${test.name}</div>
      <div class="test-id">${test.id}</div>
      <button class="btn-icon" data-action="preview" title="Preview">⊙</button>
      <button class="btn-icon danger" data-action="delete" title="Delete">×</button>
    `;
    row.querySelector('[data-action="preview"]').addEventListener('click', () => {
      showTestPreview(test, false);
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete test "${test.name}" from this competition?\n\nExisting slots referencing this test will still work but won't show the name.`)) return;
      await deleteDoc(doc(db, 'competitions', currentCompetitionId, 'tests', test.id));
      await loadTests();
    });
    el.appendChild(row);
  }
}

// pendingTestData holds a parsed test object waiting for user confirmation
let pendingTestData = null;
let pendingFileQueue = []; // remaining files to process after current preview

async function handleTestFileUpload(e) {
  const files = Array.from(e.target.files);
  e.target.value = '';   // reset so same files can be re-uploaded
  if (!files.length) return;

  pendingFileQueue = files.slice(1);
  await processNextTexFile(files[0]);
}

async function processNextTexFile(file) {
  if (!file) return;
  const text = await file.text();
  let parsed;
  try {
    parsed = convertTexToTest(text, file.name);
  } catch (err) {
    alert(`Could not parse "${file.name}":\n${err.message}`);
    // Try next file in queue
    const next = pendingFileQueue.shift();
    if (next) await processNextTexFile(next);
    return;
  }

  pendingTestData = parsed;
  showTestPreview(parsed, true);
}

function showTestPreview(test, isUpload) {
  const overlay     = document.getElementById('test-preview-overlay');
  const title       = document.getElementById('test-preview-title');
  const meta        = document.getElementById('test-preview-meta');
  const body        = document.getElementById('test-preview-body');
  const jsonEl      = document.getElementById('test-preview-json');
  const jsonToggle  = document.getElementById('test-preview-json-toggle');
  const actions     = document.getElementById('test-preview-actions');
  const saveBtn     = document.getElementById('test-preview-save');
  const cancelBtn   = document.getElementById('test-preview-cancel');
  const closeBtn    = document.getElementById('test-preview-close');

  // Reset JSON toggle state
  body.hidden = false;
  jsonEl.hidden = true;
  jsonToggle.textContent = '{ } JSON';
  jsonToggle.onclick = () => {
    const showingJson = !jsonEl.hidden;
    jsonEl.hidden  = showingJson;
    body.hidden    = !showingJson;
    jsonToggle.textContent = showingJson ? '{ } JSON' : '⊙ Visual';
    if (!jsonEl.hidden) jsonEl.textContent = JSON.stringify(test, null, 2);
  };

  title.textContent = test.name;
  const itemCount = (test.sections || []).reduce((n, s) => n + s.items.length, 0);
  const parts = [];
  if (test.timeLimit) parts.push(`${test.timeLimit} min`);
  parts.push(`${(test.sections || []).length} section${test.sections.length !== 1 ? 's' : ''}`);
  parts.push(`${itemCount} item${itemCount !== 1 ? 's' : ''}`);
  meta.textContent = parts.join(' · ');

  body.innerHTML = '';
  for (const section of (test.sections || [])) {
    const sec = document.createElement('div');
    sec.className = 'test-preview-section';

    const heading = document.createElement('div');
    heading.className = 'test-preview-section-heading';
    heading.textContent = section.heading;
    sec.appendChild(heading);

    for (const item of section.items) {
      sec.appendChild(buildPreviewItem(item, false));
      if (item.modifiers) {
        for (const mod of item.modifiers) sec.appendChild(buildPreviewItem(mod, true, 'mod'));
      }
      if (item.penalties) {
        for (const pen of item.penalties) sec.appendChild(buildPreviewItem(pen, true, 'pen'));
      }
    }
    body.appendChild(sec);
  }

  actions.hidden = !isUpload;

  if (isUpload) {
    saveBtn.onclick = async () => {
      if (!pendingTestData) return;
      await setDoc(
        doc(db, 'competitions', currentCompetitionId, 'tests', pendingTestData.id),
        pendingTestData
      );
      pendingTestData = null;
      overlay.hidden = true;
      await loadTests();
      const next = pendingFileQueue.shift();
      if (next) await processNextTexFile(next);
    };
    cancelBtn.onclick = async () => {
      pendingTestData = null;
      overlay.hidden = true;
      const next = pendingFileQueue.shift();
      if (next) await processNextTexFile(next);
    };
  }

  closeBtn.onclick = () => { overlay.hidden = true; pendingTestData = null; pendingFileQueue = []; };
  overlay.onclick  = e => { if (e.target === overlay) { overlay.hidden = true; pendingTestData = null; pendingFileQueue = []; } };

  overlay.hidden = false;
}

function buildPreviewItem(item, isSub, role) {
  const row = document.createElement('div');
  row.className = 'test-preview-item' + (isSub ? ' sub' : '');

  let ptsText = '', ptsClass = '';
  if (item.type === 'info') {
    ptsText = '—'; ptsClass = 'info';
  } else if (role === 'pen') {
    ptsText = item.type === 'percentage' ? '−%' : `−${item.points}`;
    ptsClass = 'neg';
  } else if (role === 'mod') {
    ptsText = `+${item.points}`; ptsClass = 'pos';
  } else if (item.type === 'standalone_penalty') {
    ptsText = `−${item.points}`; ptsClass = 'neg';
  } else {
    ptsText = `+${item.points}`; ptsClass = 'pos';
  }

  let typeLabel = '';
  if (item.type === 'count') typeLabel = `×${item.maxCount}`;
  else if (item.type === 'boolean') typeLabel = '';
  else if (item.type === 'info') typeLabel = 'info';
  else if (item.type === 'standalone_penalty') typeLabel = item.maxCount > 1 ? `×${item.maxCount}` : '';
  else if (item.type === 'percentage') typeLabel = 'penalty %';
  else if (item.type === 'fixed' && item.maxCount > 1) typeLabel = `×${item.maxCount}`;

  row.innerHTML = `
    <span class="item-pts ${ptsClass}">${ptsText}</span>
    <span class="item-label">${item.label}</span>
    ${typeLabel ? `<span class="item-type">${typeLabel}</span>` : ''}
  `;
  return row;
}

// ── PARTICIPATING TEAMS ───────────────────────────────────────────────────────

let compTeams = [];          // [{teamId, teamName}] for the current competition
let _onTeamListChanged = null; // set by showSlotTeams so renderTeamList can refresh the add button

async function loadParticipatingTeams() {
  const snap = await getDoc(doc(db, 'competitions', currentCompetitionId));
  compTeams = snap.data()?.participatingTeams || [];
  renderCompTeamChips();
  setupCompTeamSearch();
}

function renderCompTeamChips() {
  const el = document.getElementById('comp-team-chips');
  if (!compTeams.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:0.85rem">No teams added yet.</span>';
    return;
  }
  el.innerHTML = compTeams.map(t => `
    <span class="arena-chip${t.humanoid ? ' humanoid' : ''}">
      <button class="team-humanoid-toggle" data-id="${t.teamId}" title="Mark as a humanoid robot (for the Humanoid award)">🤖</button>
      ${t.teamName}
      <button class="arena-chip-remove" data-id="${t.teamId}" title="Remove">×</button>
    </span>
  `).join('');
  el.querySelectorAll('.arena-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => removeCompTeam(btn.dataset.id));
  });
  el.querySelectorAll('.team-humanoid-toggle').forEach(btn => {
    btn.addEventListener('click', () => toggleCompTeamHumanoid(btn.dataset.id));
  });
}

async function toggleCompTeamHumanoid(teamId) {
  compTeams = compTeams.map(t => t.teamId === teamId ? { ...t, humanoid: !t.humanoid } : t);
  await updateDoc(doc(db, 'competitions', currentCompetitionId), { participatingTeams: compTeams });
  renderCompTeamChips();
}

function setupCompTeamSearch() {
  const input      = document.getElementById('comp-team-search');
  const dropdown   = document.getElementById('comp-team-results');

  // Ensure teams are loaded
  async function ensureTeams() {
    if (!allTeams.length) {
      const snap = await getDocs(collection(db, 'teams'));
      allTeams = snap.docs.map(d => d.data()).sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  input.oninput = async () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { dropdown.hidden = true; return; }

    await ensureTeams();

    const already  = new Set(compTeams.map(t => t.teamId));
    const matches  = allTeams
      .filter(t => !already.has(t.id) &&
        (t.name.toLowerCase().includes(q) ||
         (t.altNames || []).some(a => a.toLowerCase().includes(q)) ||
         t.institution?.toLowerCase().includes(q)))
      .slice(0, 10);

    dropdown.innerHTML = '';
    if (!matches.length) {
      dropdown.innerHTML = '<div class="dropdown-empty">No matching teams</div>';
    } else {
      for (const team of matches) {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.innerHTML = `
          <span class="d-name">${team.name}</span>
          <span class="d-sub">${[team.institution, team.country].filter(Boolean).join(' · ')}</span>
        `;
        item.addEventListener('mousedown', async e => {
          e.preventDefault();   // prevent input blur before click fires
          await addCompTeam({ teamId: team.id, teamName: team.name });
          input.value = '';
          dropdown.hidden = true;
        });
        dropdown.appendChild(item);
      }
    }
    dropdown.hidden = false;
  };

  input.onblur = () => { setTimeout(() => { dropdown.hidden = true; }, 150); };
  input.onfocus = () => { if (input.value.trim()) input.dispatchEvent(new Event('input')); };
}

async function addCompTeam(team) {
  if (compTeams.some(t => t.teamId === team.teamId)) return;
  compTeams = [...compTeams, team];
  await updateDoc(doc(db, 'competitions', currentCompetitionId), { participatingTeams: compTeams });

  // Add team to all existing test slots that don't already have them
  const slotsSnap = await getDocs(collection(db, 'competitions', currentCompetitionId, 'slots'));
  const batch = writeBatch(db);
  slotsSnap.docs.forEach(d => {
    const slot = d.data();
    if ((slot.type || 'test') !== 'test') return;
    const teams = slot.teams || [];
    if (teams.some(t => t.teamId === team.teamId)) return;
    batch.update(d.ref, {
      teams: [...teams, { teamId: team.teamId, teamName: team.teamName, order: teams.length + 1 }]
    });
  });
  await batch.commit();
  renderCompTeamChips();
}

async function removeCompTeam(teamId) {
  compTeams = compTeams.filter(t => t.teamId !== teamId);
  await updateDoc(doc(db, 'competitions', currentCompetitionId), { participatingTeams: compTeams });

  // Remove team from all slots (and their associated runs)
  const slotsSnap = await getDocs(collection(db, 'competitions', currentCompetitionId, 'slots'));
  const batch = writeBatch(db);
  slotsSnap.docs.forEach(d => {
    const slot  = d.data();
    const teams = (slot.teams || []).filter(t => t.teamId !== teamId);
    if (teams.length !== (slot.teams || []).length) {
      batch.update(d.ref, { teams });
    }
  });
  await batch.commit();
  renderCompTeamChips();
}

// ── SLOT TEAMS SCREEN ─────────────────────────────────────────────────────────

async function showSlotTeams(slotId, testName, slot, backFn) {
  currentSlotId = slotId;
  showScreen('teams');

  const compSnap = await getDoc(doc(db, 'competitions', currentCompetitionId));
  const compName = compSnap.data()?.name || currentCompetitionId;

  const goBack = backFn || (() => showSlots(currentCompetitionId, compName));
  setBack(goBack);
  setBreadcrumb([
    { label: 'Competitions', onClick: showCompetitions },
    { label: compName, onClick: goBack },
    { label: testName }
  ]);

  document.getElementById('teams-title').textContent =
    `${testName} — ${slot.arena || ''} ${slot.date || ''} ${slot.time || ''}`.trim();

  // Team picker — restricted to participating teams only
  const picker    = document.getElementById('team-picker');
  const addBtn    = document.getElementById('add-team-btn');
  const searchEl  = document.getElementById('team-search');
  const resultsEl = document.getElementById('team-results');

  // Hide add button if all participating teams are already in the slot
  const updateAddBtn = () => {
    const inSlot = new Set((slot.teams || []).map(t => t.teamId));
    const remaining = compTeams.filter(t => !inSlot.has(t.teamId));
    addBtn.hidden = !remaining.length;
  };
  _onTeamListChanged = updateAddBtn;  // allow renderTeamList to call this
  updateAddBtn();

  addBtn.onclick = () => {
    picker.hidden = false;
    addBtn.hidden = true;
    searchEl.value = '';
    resultsEl.innerHTML = '';
    searchEl.focus();
  };

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    resultsEl.innerHTML = '';

    const currentTeamIds = new Set((slot.teams || []).map(t => t.teamId));
    const matches = compTeams
      .filter(t => !currentTeamIds.has(t.teamId) && (!q || t.teamName.toLowerCase().includes(q)))
      .slice(0, 10);

    if (!matches.length) {
      resultsEl.innerHTML = '<div style="padding:8px 12px;color:var(--muted);font-size:0.85rem">All participating teams already added.</div>';
      return;
    }

    for (const team of matches) {
      const el = document.createElement('div');
      el.className = 'team-result-item';
      el.innerHTML = `<span class="t-name">${team.teamName}</span>`;
      el.addEventListener('click', async () => {
        await addTeamToSlot(slot, { teamId: team.teamId, teamName: team.teamName });
        slot = (await getDoc(doc(db, 'competitions', currentCompetitionId, 'slots', currentSlotId))).data();
        picker.hidden = true;
        updateAddBtn();
        renderTeamList(slot);
        updateSlotLink(slot);
      });
      resultsEl.appendChild(el);
    }
  });

  // Show all remaining teams immediately when picker opens (no need to type)
  const origAddBtnOnclick = addBtn.onclick;
  addBtn.onclick = () => {
    origAddBtnOnclick();
    searchEl.dispatchEvent(new Event('input'));
  };

  // Poster: show Manage Session button, hide referee/link
  // Open Challenge: hide referee/link (no scoring), no Manage button
  const isPoster          = slot.type === 'poster';
  const isNoScore         = isPoster || slot.type === 'open_challenge';
  const manageBtn         = document.getElementById('poster-manage-btn');
  const refereeCard       = document.getElementById('slot-referee-input').closest('.card');
  const slotLinkBox       = document.getElementById('slot-link-box');
  manageBtn.hidden        = !isPoster;
  refereeCard.hidden      = isNoScore;
  slotLinkBox.hidden      = isNoScore;
  if (isPoster) {
    manageBtn.onclick = () =>
      showPosterManagement(slot, () => showSlotTeams(slotId, testName, slot, backFn));
  }

  // Referee field (scored slots only)
  if (!isNoScore) {
    const refereeInput = document.getElementById('slot-referee-input');
    refereeInput.value = slot.referee || '';
    const saveReferee = async () => {
      const val = refereeInput.value.trim();
      if (val === (slot.referee || '')) return;
      slot.referee = val;
      await updateDoc(doc(db, 'competitions', currentCompetitionId, 'slots', currentSlotId), { referee: val });
    };
    refereeInput.onblur = saveReferee;
    refereeInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); refereeInput.blur(); } };
  }

  renderTeamList(slot);
  if (!isNoScore) updateSlotLink(slot);
}

async function addTeamToSlot(slot, team) {
  const teams = [...(slot.teams || []), { ...team, order: (slot.teams?.length || 0) + 1 }];
  await updateDoc(
    doc(db, 'competitions', currentCompetitionId, 'slots', currentSlotId),
    { teams }
  );
  slot.teams = teams;
}

function renderTeamList(slot) {
  const list       = document.getElementById('team-list');
  const teams      = slot.teams || [];
  const isMapping       = slot.type === 'mapping';
  const isPoster        = slot.type === 'poster';
  const isOpenChallenge = slot.type === 'open_challenge';
  const slotStart       = isMapping ? timeToMinutes(slot.time || '00:00') : 0;
  list.innerHTML = '';

  if (!teams.length) {
    list.innerHTML = '<div class="empty-state">No teams added yet.</div>';
    return;
  }

  teams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'team-row';
    const meta = isMapping       ? minutesToTime(slotStart + (team.startOffset ?? idx * 10))
               : isPoster        ? 'Presenter'
               : isOpenChallenge ? `Slot ${idx + 1}`
               : `ID: ${team.teamId}`;
    row.innerHTML = `
      <span class="team-order">${idx + 1}</span>
      <div class="team-info">
        <div class="team-name">${team.teamName}</div>
        <div class="team-meta">${meta}</div>
      </div>
      <div class="team-actions">
        <button class="btn-icon" data-action="up"   title="Move up">↑</button>
        <button class="btn-icon" data-action="down" title="Move down">↓</button>
        <button class="btn-icon danger" data-action="remove" title="Remove">×</button>
      </div>
    `;

    row.querySelector('[data-action="up"]').disabled    = idx === 0;
    row.querySelector('[data-action="down"]').disabled  = idx === teams.length - 1;

    row.querySelector('[data-action="up"]').addEventListener('click', async () => {
      const t = [...teams];
      [t[idx - 1], t[idx]] = [t[idx], t[idx - 1]];
      await saveTeams(t);
      slot.teams = t;
      renderTeamList(slot);
      updateSlotLink(slot);
    });

    row.querySelector('[data-action="down"]').addEventListener('click', async () => {
      const t = [...teams];
      [t[idx], t[idx + 1]] = [t[idx + 1], t[idx]];
      await saveTeams(t);
      slot.teams = t;
      renderTeamList(slot);
      updateSlotLink(slot);
    });

    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      const t = teams.filter((_, i) => i !== idx);
      await saveTeams(t);
      slot.teams = t;
      renderTeamList(slot);
      updateSlotLink(slot);
      if (_onTeamListChanged) _onTeamListChanged();
    });

    list.appendChild(row);
  });
}

async function saveTeams(teams) {
  const numbered = teams.map((t, i) => {
    const entry = { ...t, order: i + 1 };
    if (t.startOffset !== undefined) entry.startOffset = i * 10;
    return entry;
  });
  await updateDoc(
    doc(db, 'competitions', currentCompetitionId, 'slots', currentSlotId),
    { teams: numbered }
  );
}

function updateSlotLink(slot) {
  if (!slot.teams?.length) {
    document.getElementById('slot-link').textContent = 'Add teams to generate referee links.';
    return;
  }
  const base = window.__siteBase || '';
  const links = slot.teams.map(t => {
    const params = new URLSearchParams({
      competition: currentCompetitionId,
      slot: currentSlotId,
      team: t.teamId,
      teamName: t.teamName,
      test: slot.testId
    });
    return `${t.teamName}: ${location.origin}${base}/scoresheet?${params}`;
  });
  document.getElementById('slot-link').textContent = links.join('\n');
}

// ── SCHEDULE SCREEN ────────────────────────────────────────────────────────────

// Pixel constants for the grid
const SCHED = { CELL_H: 40, TIME_W: 56, COL_W: 180, HEADER_H: 48 };

// Shared state for the schedule view (used by drop handlers and slot renderer)
let schedState = { compId: null, compName: '', days: [], arenas: [], openMin: 0 };

function timeToMinutes(t) {
  const parts = (t || '00:00').split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || 0, 10);
}
function minutesToTime(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function schedFormatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

async function showSchedule(compId, compName) {
  currentCompetitionId = compId;
  currentSlotId        = null;
  schedState.compId    = compId;
  schedState.compName  = compName;

  setBack(() => showSlots(compId, compName));
  showScreen('schedule');
  setBreadcrumb([
    { label: 'Competitions', onClick: showCompetitions },
    { label: compName, onClick: () => showSlots(compId, compName) },
    { label: 'Schedule' }
  ]);

  const compSnap = await getDoc(doc(db, 'competitions', compId));
  const comp     = compSnap.data();

  // Settings button → back to competition settings (arenas/teams/tests)
  document.getElementById('sched-settings-btn').onclick = () => showSlots(compId, compName);
  document.getElementById('sched-settings-btn').textContent = '← Back to Settings';

  document.getElementById('sched-balance-btn').onclick = balanceArenaAssignments;

  // Venue time inputs
  document.getElementById('venue-open').value  = comp.venueOpen  || '09:00';
  document.getElementById('venue-close').value = comp.venueClose || '22:00';

  // Apply button: save times and rebuild
  document.getElementById('sched-apply-btn').onclick = async () => {
    const open  = document.getElementById('venue-open').value;
    const close = document.getElementById('venue-close').value;
    if (timeToMinutes(open) >= timeToMinutes(close)) {
      alert('Venue close time must be after open time.');
      return;
    }
    await updateDoc(doc(db, 'competitions', compId), { venueOpen: open, venueClose: close });
    comp.venueOpen  = open;
    comp.venueClose = close;
    await buildScheduleView(comp);
  };

  // No-dates shortcut
  document.getElementById('sched-edit-dates-btn').onclick = () => {
    showCompetitions(() => startEditCompetition(comp));
  };

  // Load tests for sidebar
  const testsSnap = await getDocs(collection(db, 'competitions', compId, 'tests'));
  compTests = testsSnap.docs.map(d => d.data()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!compTests.length) {
    try { compTests = await fetch('assets/referee-tool/tests/index.json').then(r => r.json()); } catch (_) {}
  }
  // Load compTeams data so the slot teams screen can use it later (without triggering UI side-effects in screen-slots)
  compTeams = comp.participatingTeams || [];

  if (!comp.startDate || !comp.endDate) {
    document.getElementById('sched-no-dates').hidden = false;
    document.getElementById('sched-main').hidden     = true;
  } else {
    document.getElementById('sched-no-dates').hidden = true;
    document.getElementById('sched-main').hidden     = false;
    await buildScheduleView(comp);
  }
}

async function buildScheduleView(comp) {
  const openTime  = comp.venueOpen  || '09:00';
  const closeTime = comp.venueClose || '22:00';
  const openMin   = timeToMinutes(openTime);
  const closeMin  = timeToMinutes(closeTime);
  const arenas    = comp.arenas || [];

  // Compute days between startDate and endDate (inclusive)
  const days = [];
  const d0 = new Date(comp.startDate + 'T12:00:00');
  const d1 = new Date(comp.endDate   + 'T12:00:00');
  for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  schedState.days    = days;
  schedState.arenas  = arenas;
  schedState.openMin = openMin;

  buildScheduleSidebar();

  const outer = document.getElementById('sched-grid-outer');
  outer.innerHTML = '';
  outer.appendChild(buildGridDOM(days, arenas, openMin, closeMin));

  // Render existing slots
  const snap = await getDocs(collection(db, 'competitions', schedState.compId, 'slots'));
  snap.docs.forEach(d => renderSlotBlock({ id: d.id, ...d.data() }));
}

function buildGridDOM(days, arenas, openMin, closeMin) {
  // Each column is a (day, arena) pair; if no arenas, one column per day
  const cols = [];
  for (const day of days) {
    if (arenas.length) {
      arenas.forEach(arena => cols.push({ day, arena, id: day + '__' + arena }));
    } else {
      cols.push({ day, arena: '', id: day });
    }
  }

  const { CELL_H, TIME_W, COL_W, HEADER_H } = SCHED;
  const intervals = [];
  for (let m = openMin; m < closeMin; m += 30) intervals.push(m);

  const totalW = TIME_W + cols.length * COL_W;
  const bodyH  = intervals.length * CELL_H;

  const wrap = document.createElement('div');
  wrap.className = 'sched-grid-wrap';
  wrap.style.width = totalW + 'px';

  // ── HEADER ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'sched-header';
  header.style.height = HEADER_H + 'px';

  const corner = document.createElement('div');
  corner.className = 'sched-corner';
  corner.style.cssText = `width:${TIME_W}px; height:${HEADER_H}px;`;
  header.appendChild(corner);

  for (const col of cols) {
    const head = document.createElement('div');
    head.className = 'sched-col-head';
    head.style.cssText = `width:${COL_W}px; height:${HEADER_H}px;`;
    // Mark start of each new day (for visual separator)
    if (!arenas.length || arenas.indexOf(col.arena) === 0) head.classList.add('day-start');
    head.innerHTML = arenas.length > 1
      ? `<span class="sched-col-date">${schedFormatDate(col.day)}</span><span class="sched-col-arena">${col.arena}</span>`
      : `<span class="sched-col-date">${schedFormatDate(col.day)}</span>`;
    header.appendChild(head);
  }
  wrap.appendChild(header);

  // ── BODY ────────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'sched-body';

  // Time label column
  const timeCol = document.createElement('div');
  timeCol.className = 'sched-time-col';
  timeCol.style.width = TIME_W + 'px';
  for (let i = 0; i < intervals.length; i++) {
    const row = document.createElement('div');
    row.className = 'sched-time-row';
    row.style.height = CELL_H + 'px';
    if (intervals[i] % 60 === 0) {
      row.innerHTML = `<span class="sched-time-label">${minutesToTime(intervals[i])}</span>`;
    }
    timeCol.appendChild(row);
  }
  body.appendChild(timeCol);

  // Day columns
  for (const col of cols) {
    const colEl = document.createElement('div');
    colEl.className = 'sched-day-col';
    colEl.dataset.colId = col.id;
    colEl.dataset.day   = col.day;
    colEl.dataset.arena = col.arena;
    colEl.style.cssText = `width:${COL_W}px; height:${bodyH}px;`;
    if (!arenas.length || arenas.indexOf(col.arena) === 0) colEl.classList.add('day-start');

    // Background grid cells (also serve as drop targets)
    for (let i = 0; i < intervals.length; i++) {
      const cell = document.createElement('div');
      cell.className = 'sched-cell' + (intervals[i] % 60 === 0 ? ' hour' : '');
      cell.style.cssText = `top:${i * CELL_H}px; height:${CELL_H}px;`;
      cell.dataset.minutes = intervals[i];

      cell.addEventListener('dragover', e => {
        e.preventDefault();
        cell.classList.add('drop-active');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop-active'));
      cell.addEventListener('drop', e => {
        e.preventDefault();
        cell.classList.remove('drop-active');
        const slotType  = e.dataTransfer.getData('slotType') || 'test';
        const testId    = e.dataTransfer.getData('testId');
        const slotLabel = e.dataTransfer.getData('slotLabel');
        if (slotType === 'test'  && !testId)    return;
        if (slotType === 'other' && !slotLabel) return;
        handleScheduleDrop(slotType, testId, slotLabel, col, parseInt(cell.dataset.minutes, 10));
      });

      colEl.appendChild(cell);
    }
    body.appendChild(colEl);
  }
  wrap.appendChild(body);
  return wrap;
}

async function handleScheduleDrop(slotType, testId, label, col, startMinutes) {
  // ── MAPPING SLOT ──────────────────────────────────────────────────────────────
  if (slotType === 'mapping') {
    if (!compTeams.length) { alert('No participating teams found.'); return; }
    const n               = compTeams.length;
    const durationMinutes = Math.ceil(n * 10 / 30) * 30;
    const arenas_         = schedState.arenas.length ? schedState.arenas : [col.arena || ''];
    const shuffled        = [...compTeams].sort(() => Math.random() - 0.5);
    const shift           = arenas_.length > 1 ? Math.floor(n / arenas_.length) : 0;
    const batch           = writeBatch(db);
    const created         = [];

    arenas_.forEach((arena, k) => {
      const offset  = (k * shift) % (n || 1);
      const rotated = [...shuffled.slice(offset), ...shuffled.slice(0, offset)]
        .map((t, j) => ({ teamId: t.teamId, teamName: t.teamName, order: j + 1, startOffset: j * 10 }));

      const slotData = {
        type: 'mapping', testId: null, label: 'Arena Mapping',
        date: col.day, time: minutesToTime(startMinutes),
        arena, league: '', referee: '',
        teams: rotated, durationMinutes, status: 'pending',
      };
      const ref = doc(collection(db, 'competitions', schedState.compId, 'slots'));
      batch.set(ref, slotData);
      created.push({ id: ref.id, ...slotData });
    });

    await batch.commit();
    created.forEach(s => renderSlotBlock(s));
    return;
  }

  const arenas = schedState.arenas;
  const isMultiArena = ['test', 'inspection'].includes(slotType) && arenas.length > 1 && compTeams.length;

  if (isMultiArena) {
    // Shuffle teams and split evenly across all arenas
    const shuffled = [...compTeams].sort(() => Math.random() - 0.5);
    const n = arenas.length;
    const batch = writeBatch(db);
    const created = [];

    arenas.forEach((arena, i) => {
      // Slice this arena's share of teams
      const start = Math.floor((i / n) * shuffled.length);
      const end   = Math.floor(((i + 1) / n) * shuffled.length);
      const arenaTeams = shuffled.slice(start, end)
        .map((t, j) => ({ teamId: t.teamId, teamName: t.teamName, order: j + 1 }));

      const slotData = {
        type:            slotType,
        testId:          testId || null,
        label:           label  || null,
        date:            col.day,
        time:            minutesToTime(startMinutes),
        arena,
        league:          '',
        referee:         '',
        teams:           arenaTeams,
        durationMinutes: 60,
        status:          'pending'
      };
      const ref = doc(collection(db, 'competitions', schedState.compId, 'slots'));
      batch.set(ref, slotData);
      created.push({ id: ref.id, ...slotData });
    });

    await batch.commit();
    created.forEach(s => renderSlotBlock(s));
    return;
  }

  // Single slot (one arena, or non-test type)
  const teams = (slotType === 'test' && compTeams.length)
    ? [...compTeams].sort(() => Math.random() - 0.5)
        .map((t, i) => ({ teamId: t.teamId, teamName: t.teamName, order: i + 1 }))
    : [];

  const slotData = {
    type:            slotType,
    testId:          testId  || null,
    label:           label   || null,
    date:            col.day,
    time:            minutesToTime(startMinutes),
    arena:           col.arena || '',
    league:          '',
    referee:         '',
    teams,
    durationMinutes: 60,
    status:          'pending'
  };
  const ref = await addDoc(
    collection(db, 'competitions', schedState.compId, 'slots'),
    slotData
  );
  renderSlotBlock({ id: ref.id, ...slotData });
}

function slotDisplayName(slot) {
  const type = slot.type || 'test';
  if (type === 'inspection')     return 'Robot Inspection';
  if (type === 'poster')         return 'Poster Session';
  if (type === 'open_challenge') return 'Open Challenge';
  if (type === 'mapping')        return 'Arena Mapping';
  if (type === 'other')          return slot.label || 'Other Event';
  return (compTests.find(t => t.id === slot.testId) || {}).name || slot.testId || '—';
}

function renderSlotBlock(slot) {
  const { arenas, openMin } = schedState;
  const colId = arenas.length ? slot.date + '__' + slot.arena : slot.date;
  const colEl = document.querySelector(`.sched-day-col[data-col-id="${CSS.escape(colId)}"]`);
  if (!colEl) return;   // slot's date/arena not visible in current grid

  const type      = slot.type || 'test';
  const slotMin   = timeToMinutes(slot.time);
  const top       = (slotMin - openMin) * (SCHED.CELL_H / 30);
  const duration  = slot.durationMinutes || 60;
  const height    = Math.max(duration * (SCHED.CELL_H / 30), SCHED.CELL_H);
  const name      = slotDisplayName(slot);
  const teamCount = (slot.teams || []).length;
  const teamMeta = type === 'test' && teamCount
    ? ' · ' + teamCount + ' team' + (teamCount !== 1 ? 's' : '')
    : type === 'mapping' && teamCount
    ? ' · ' + teamCount + ' × 10 min'
    : '';

  const block = document.createElement('div');
  block.className = `sched-slot-block type-${type}`;
  block.dataset.slotId = slot.id;
  block.style.cssText = `top:${top}px; height:${height}px;`;
  block.innerHTML = `
    <div class="sched-slot-drag" title="Drag to move"></div>
    <div class="sched-slot-inner">
      <div class="sched-slot-name">${name}</div>
      <div class="sched-slot-meta">${slot.time}${teamMeta}</div>
    </div>
    <button class="sched-slot-del" title="Remove slot">×</button>
    <div class="sched-slot-resize" title="Drag to resize"></div>
  `;

  block.querySelector('.sched-slot-del').addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('Remove this slot from the schedule?')) return;
    // Delete associated runs first
    const runsSnap = await getDocs(
      query(collection(db, 'competitions', schedState.compId, 'runs'), where('slotId', '==', slot.id))
    );
    if (!runsSnap.empty) {
      const batch = writeBatch(db);
      runsSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await deleteDoc(doc(db, 'competitions', schedState.compId, 'slots', slot.id));
    block.remove();
  });

  block.querySelector('.sched-slot-inner').addEventListener('click', () => {
    const back = () => showSchedule(schedState.compId, schedState.compName);
    if (!['test', 'inspection', 'mapping', 'poster', 'open_challenge'].includes(type)) return;
    showSlotTeams(slot.id, name, slot, back);
  });

  // ── DRAG HANDLE (move) ────────────────────────────────────────────────────────
  const dragHandle = block.querySelector('.sched-slot-drag');
  let dragStartY = 0, dragStartTop = 0;

  dragHandle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    dragStartY   = e.clientY;
    dragStartTop = parseInt(block.style.top) || 0;
    let targetColEl = block.parentElement; // track which column the block is in
    block.classList.add('sched-slot-dragging');

    function onMove(ev) {
      const delta   = ev.clientY - dragStartY;
      const rawTop  = dragStartTop + delta;
      const snapped = Math.max(0, Math.round(rawTop / SCHED.CELL_H) * SCHED.CELL_H);
      block.style.top = snapped + 'px';

      // Detect column under cursor (temporarily disable pointer-events on block)
      block.style.pointerEvents = 'none';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      block.style.pointerEvents = '';
      const col = under?.closest('.sched-day-col');
      if (col && col !== targetColEl) {
        col.appendChild(block);
        targetColEl = col;
      }
    }

    async function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      block.classList.remove('sched-slot-dragging');

      const topPx       = parseInt(block.style.top) || 0;
      const newStartMin = schedState.openMin + (topPx / SCHED.CELL_H) * 30;
      const newTime     = minutesToTime(newStartMin);

      // Parse new date + arena from the column we landed in
      const colId    = targetColEl.dataset.colId || '';
      const sepIdx   = colId.indexOf('__');
      const newDate  = sepIdx >= 0 ? colId.slice(0, sepIdx) : colId;
      const newArena = sepIdx >= 0 ? colId.slice(sepIdx + 2) : '';

      // Update meta display
      const metaEl = block.querySelector('.sched-slot-meta');
      if (metaEl) {
        const teamPart = slot.teams?.length ? ` · ${slot.teams.length} team${slot.teams.length !== 1 ? 's' : ''}` : '';
        metaEl.textContent = newTime + teamPart;
      }

      const updateData = { time: newTime, date: newDate };
      if (schedState.arenas.length) updateData.arena = newArena;
      await updateDoc(
        doc(db, 'competitions', schedState.compId, 'slots', slot.id),
        updateData
      );
      slot.time  = newTime;
      slot.date  = newDate;
      if (schedState.arenas.length) slot.arena = newArena;
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── RESIZE HANDLE ────────────────────────────────────────────────────────────
  const resizeHandle = block.querySelector('.sched-slot-resize');
  let resizeStartY = 0, resizeStartH = 0;

  resizeHandle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartY = e.clientY;
    resizeStartH = block.offsetHeight;

    function onMove(ev) {
      const delta  = ev.clientY - resizeStartY;
      const newH   = Math.max(SCHED.CELL_H, Math.round((resizeStartH + delta) / SCHED.CELL_H) * SCHED.CELL_H);
      block.style.height = newH + 'px';
    }

    async function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      const newDuration = Math.round(block.offsetHeight / (SCHED.CELL_H / 30));
      await updateDoc(
        doc(db, 'competitions', schedState.compId, 'slots', slot.id),
        { durationMinutes: newDuration }
      );
      slot.durationMinutes = newDuration;
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  colEl.appendChild(block);
}

function buildScheduleSidebar() {
  const el = document.getElementById('sched-test-cards');
  el.innerHTML = '';

  // ── TESTS ──────────────────────────────────────────────────────────
  const testsLabel = makeSidebarLabel('Tests');
  el.appendChild(testsLabel);

  if (compTests.length) {
    for (const test of compTests) {
      const card = document.createElement('div');
      card.className = 'sched-test-card';
      card.draggable = true;
      card.textContent = test.name;
      card.addEventListener('dragstart', e => {
        e.dataTransfer.setData('slotType', 'test');
        e.dataTransfer.setData('testId', test.id);
        card.classList.add('sched-dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('sched-dragging'));
      el.appendChild(card);
    }
  } else {
    const empty = document.createElement('p');
    empty.className = 'sched-sidebar-empty';
    empty.innerHTML = 'No tests added yet.<br>Add via Settings.';
    el.appendChild(empty);
  }

  // ── SPECIAL BLOCKS ─────────────────────────────────────────────────
  el.appendChild(makeSidebarLabel('Special'));
  el.appendChild(makeSpecialCard('inspection',     'Robot Inspection', 'type-inspection'));
  el.appendChild(makeSpecialCard('poster',         'Poster Session',   'type-poster'));
  el.appendChild(makeSpecialCard('open_challenge', 'Open Challenge',   'type-open_challenge'));
  el.appendChild(makeSpecialCard('mapping',        'Arena Mapping',    'type-mapping'));

  // ── OTHER EVENT ────────────────────────────────────────────────────
  el.appendChild(makeSidebarLabel('Other'));

  const otherInput = document.createElement('input');
  otherInput.type        = 'text';
  otherInput.className   = 'sched-other-input';
  otherInput.placeholder = 'e.g. Lunch break';

  const otherCard = document.createElement('div');
  otherCard.className = 'sched-test-card type-other sched-card-disabled';
  otherCard.draggable = false;
  otherCard.textContent = 'Drag to schedule';

  otherInput.addEventListener('input', () => {
    const val = otherInput.value.trim();
    otherCard.textContent = val || 'Drag to schedule';
    otherCard.draggable   = !!val;
    otherCard.classList.toggle('sched-card-disabled', !val);
  });

  otherCard.addEventListener('dragstart', e => {
    const label = otherInput.value.trim();
    if (!label) { e.preventDefault(); return; }
    e.dataTransfer.setData('slotType',  'other');
    e.dataTransfer.setData('slotLabel', label);
    otherCard.classList.add('sched-dragging');
  });
  otherCard.addEventListener('dragend', () => otherCard.classList.remove('sched-dragging'));

  el.appendChild(otherInput);
  el.appendChild(otherCard);
}

function makeSidebarLabel(text) {
  const el = document.createElement('div');
  el.className   = 'sched-sidebar-label';
  el.textContent = text;
  return el;
}

function makeSpecialCard(type, label, cls) {
  const card = document.createElement('div');
  card.className = `sched-test-card ${cls}`;
  card.draggable = true;
  card.textContent = label;
  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('slotType', type);
    card.classList.add('sched-dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('sched-dragging'));
  return card;
}

// ── POSTER SESSION MANAGEMENT ─────────────────────────────────────────────────

function showPosterManagement(slot, backFn) {
  showScreen('poster');

  const back = backFn || (() => showSchedule(schedState.compId, schedState.compName));
  setBack(back);
  setBreadcrumb([
    { label: 'Competitions', onClick: showCompetitions },
    { label: schedState.compName, onClick: back },
    { label: 'Poster Session' }
  ]);

  document.getElementById('poster-title').textContent =
    `Poster Session — ${slot.date || ''} ${slot.time || ''}`.trim();

  // Build judge links + QR codes
  const siteBase  = window.__siteBase || '';
  const judgeBase = `${window.location.origin}${siteBase}/poster-judge`;
  const grid      = document.getElementById('poster-links-grid');
  grid.innerHTML  = '';

  for (const team of compTeams) {
    const url    = `${judgeBase}?comp=${schedState.compId}&slot=${slot.id}&team=${team.teamId}`;
    const qrSrc  = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(url)}`;
    const card   = document.createElement('div');
    card.className = 'poster-link-card';
    card.innerHTML = `
      <div class="poster-link-team">${team.teamName}</div>
      <img class="poster-link-qr" src="${qrSrc}" alt="QR for ${team.teamName}" loading="lazy" />
      <button class="poster-copy-btn" data-url="${url}">Copy link</button>
    `;
    card.querySelector('.poster-copy-btn').addEventListener('click', e => {
      navigator.clipboard.writeText(url).then(() => {
        e.target.textContent = 'Copied!';
        e.target.classList.add('copied');
        setTimeout(() => {
          e.target.textContent = 'Copy link';
          e.target.classList.remove('copied');
        }, 2000);
      });
    });
    grid.appendChild(card);
  }

  // Subscribe to live scoring progress
  const matrixEl  = document.getElementById('poster-matrix');
  const unsubscribe = onSnapshot(
    collection(db, 'competitions', schedState.compId, 'slots', slot.id, 'posterScores'),
    snap => {
      const byJudge = {};
      snap.docs.forEach(d => { byJudge[d.id] = d.data().scores || {}; });
      renderPosterMatrix(matrixEl, compTeams, byJudge);
    }
  );
  _screenCleanup = unsubscribe;
}

// Scale raw 1–10 scores to 5–50, drop N highest and N lowest, return mean.
// Falls back to plain mean when fewer than 2N+1 scores are available.
function calcPosterScore(rawScores) {
  if (!rawScores.length) return null;
  const scaled = rawScores.map(s => s * 5);
  if (scaled.length <= 2 * POSTER_OUTLIER_N) {
    return scaled.reduce((a, b) => a + b, 0) / scaled.length;
  }
  const sorted  = [...scaled].sort((a, b) => a - b);
  const trimmed = sorted.slice(POSTER_OUTLIER_N, sorted.length - POSTER_OUTLIER_N);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function renderPosterMatrix(container, teams, byJudge) {
  // Collect raw scores and compute final score per presenter
  const finalScores = {};
  const outlierSets = {};  // presenterTeamId → Set of judge teamIds whose scores are dropped
  for (const presenter of teams) {
    const judgeScores = teams
      .filter(j => j.teamId !== presenter.teamId)
      .map(j => ({ judgeId: j.teamId, raw: (byJudge[j.teamId] || {})[presenter.teamId] }))
      .filter(e => e.raw !== undefined);

    const score = calcPosterScore(judgeScores.map(e => e.raw));
    finalScores[presenter.teamId] = score !== null ? score.toFixed(1) : '—';

    // Identify which judges are outliers (only meaningful when enough scores exist)
    const dropped = new Set();
    if (judgeScores.length > 2 * POSTER_OUTLIER_N) {
      const sorted = [...judgeScores].sort((a, b) => a.raw - b.raw);
      for (let i = 0; i < POSTER_OUTLIER_N; i++) {
        dropped.add(sorted[i].judgeId);                           // lowest N
        dropped.add(sorted[sorted.length - 1 - i].judgeId);      // highest N
      }
    }
    outlierSets[presenter.teamId] = dropped;
  }

  let html = '<div class="poster-matrix-scroll"><table class="poster-matrix-table"><thead>';
  html += '<tr><th class="pm-corner">Judge ↓ · Presenter →</th>';
  for (const t of teams) html += `<th class="pm-col-head">${t.teamName}</th>`;
  html += '</tr></thead><tbody>';

  for (const judge of teams) {
    const jScores = byJudge[judge.teamId] || {};
    html += `<tr><th class="pm-row-head">${judge.teamName}</th>`;
    for (const presenter of teams) {
      if (judge.teamId === presenter.teamId) {
        html += '<td class="pm-self">—</td>';
      } else {
        const s         = jScores[presenter.teamId];
        const isOutlier = s !== undefined && outlierSets[presenter.teamId]?.has(judge.teamId);
        const cls       = ['pm-score', s !== undefined ? 'has-score' : '', isOutlier ? 'pm-outlier' : ''].join(' ').trim();
        html += `<td class="${cls}" title="${isOutlier ? 'dropped as outlier' : ''}">${s !== undefined ? s : '·'}</td>`;
      }
    }
    html += '</tr>';
  }

  html += `</tbody><tfoot><tr class="pm-avg-row"><th class="pm-row-head">Score (/50)</th>`;
  for (const t of teams) html += `<td class="pm-avg">${finalScores[t.teamId]}</td>`;
  html += '</tr></tfoot></table></div>';
  container.innerHTML = html;
}

// ── ARENA BALANCING ───────────────────────────────────────────────────────────

async function balanceArenaAssignments() {
  if (!compTeams.length) { alert('No participating teams found.'); return; }
  if (!confirm(
    'Reassign teams so each team stays in the same arena for all their tests on a given day, rotating arenas across days?\n\n' +
    'This overwrites the current team distribution.'
  )) return;

  const snap = await getDocs(collection(db, 'competitions', schedState.compId, 'slots'));
  const slots = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const N = schedState.arenas.length;
  if (N < 2) { alert('Need at least two arenas to balance.'); return; }

  // Group test slots by date → arena → [slots]
  // All tests in the same (date, arena) cell get the same team group,
  // so each team is always in the same arena for all their tests on a given day.
  const byDate = {};
  for (const slot of slots) {
    if (slot.type !== 'test' || !slot.testId) continue;
    (byDate[slot.date] ??= {})[slot.arena || ''] ??= [];
    byDate[slot.date][slot.arena || ''].push(slot);
  }

  const sortedDays = Object.keys(byDate).sort();

  // Derive the canonical sorted arena list from the actual slot data,
  // not from schedState.arenas — avoids mismatches if names differ.
  const allArenas = [...new Set(
    slots.filter(s => s.type === 'test' && s.testId && s.arena).map(s => s.arena)
  )].sort();

  if (allArenas.length < 2) { alert('No multi-arena test slots found to balance.'); return; }

  // One shuffle for the whole competition, split into N groups (one per arena)
  const n = allArenas.length;
  const shuffled = [...compTeams].sort(() => Math.random() - 0.5);
  const groups = Array.from({ length: n }, (_, i) => {
    const start = Math.floor((i / n) * shuffled.length);
    const end   = Math.floor(((i + 1) / n) * shuffled.length);
    return shuffled.slice(start, end);
  });

  const batch = writeBatch(db);
  let changed = 0;

  // For day at index d, arena at sorted index i → groups[(i + d) % n]
  for (let d = 0; d < sortedDays.length; d++) {
    const dayMap = byDate[sortedDays[d]];
    allArenas.forEach((arena, i) => {
      const arenaSlots = dayMap[arena] || [];
      if (!arenaSlots.length) return;
      const group = groups[(i + d) % n];
      for (const slot of arenaSlots) {
        const shuffled = [...group].sort(() => Math.random() - 0.5);
        const teams = shuffled.map((t, j) => ({ teamId: t.teamId, teamName: t.teamName, order: j + 1 }));
        batch.update(doc(db, 'competitions', schedState.compId, 'slots', slot.id), { teams });
        changed++;
      }
    });
  }

  // ── MAPPING SLOTS: cyclic shift so no team has back-to-back slots across arenas ──
  const mappingByDate = {};
  for (const slot of slots) {
    if (slot.type !== 'mapping') continue;
    (mappingByDate[slot.date] ??= []).push(slot);
  }

  for (const dateSlots of Object.values(mappingByDate)) {
    const multiArena = dateSlots.filter(s => s.arena).sort((a, b) => a.arena.localeCompare(b.arena));
    if (multiArena.length < 2) continue;

    const n               = compTeams.length;
    if (!n) continue;
    const durationMinutes = Math.ceil(n * 10 / 30) * 30;
    const shuffled        = [...compTeams].sort(() => Math.random() - 0.5);
    const shift           = Math.floor(n / multiArena.length);

    multiArena.forEach((slot, k) => {
      const offset  = (k * shift) % n;
      const rotated = [...shuffled.slice(offset), ...shuffled.slice(0, offset)]
        .map((t, j) => ({ teamId: t.teamId, teamName: t.teamName, order: j + 1, startOffset: j * 10 }));
      batch.update(doc(db, 'competitions', schedState.compId, 'slots', slot.id),
        { teams: rotated, durationMinutes });
      changed++;
    });
  }

  if (!changed) { alert('No multi-arena test or mapping slots found to balance.'); return; }

  await batch.commit();
  await showSchedule(schedState.compId, schedState.compName);
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ff6b6b">Error: ${err.message}</div>`;
  console.error(err);
});
