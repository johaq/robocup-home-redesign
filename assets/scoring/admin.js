import { db, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from './firebase.js';
import {
  collection, doc, addDoc, getDocs, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, query, where
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

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

async function init() {
  // authStateReady() waits until persistent auth state is fully loaded,
  // avoiding a flash of the login screen when the admin reloads the page.
  await auth.authStateReady();
  const user = auth.currentUser;

  if (user?.email) {
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
      await signInWithEmailAndPassword(auth, email, password);
      showAdminApp();
      await showCompetitions();
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

// ── TEX PARSER (browser port of tex2test.js) ──────────────────────────────────

function texSlugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50);
}

function texUniqueId(base, seen) {
  let id = base, n = 2;
  while (seen.has(id)) id = base + '_' + n++;
  seen.add(id);
  return id;
}

function texParseBrace(str, pos) {
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  if (str[pos] !== '{') return [null, pos];
  let depth = 0, start = pos + 1;
  for (let i = pos; i < str.length; i++) {
    if      (str[i] === '{') depth++;
    else if (str[i] === '}') { if (--depth === 0) return [str.slice(start, i), i + 1]; }
  }
  return [null, pos];
}

function texParseBracket(str, pos) {
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  if (str[pos] !== '[') return [null, pos];
  const end = str.indexOf(']', pos);
  if (end === -1) return [null, pos];
  return [str.slice(pos + 1, end).trim(), end + 1];
}

function texCleanLabel(raw) {
  return raw
    .replace(/\\(?:textit|textbf|emph|enquote|textsc)\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, function(m, arg) { return arg ? arg.slice(1, -1) : ''; })
    .replace(/\\\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TEX_MACRO_RE = /\\(scoreheading|scoreitem|scoremod|scorepen|scorepenpcent|penaltyitem|infoitem)\b/;

function texParseMacroOnLine(line) {
  const m = TEX_MACRO_RE.exec(line);
  if (!m) return null;
  const macro = m[1];
  let pos = m.index + m[0].length;

  if (macro === 'scoreheading' || macro === 'infoitem') {
    const r = texParseBrace(line, pos);
    return r[0] != null ? { macro, label: texCleanLabel(r[0]) } : null;
  }
  if (macro === 'scorepenpcent') {
    const r = texParseBrace(line, pos);
    return r[0] != null ? { macro, label: texCleanLabel(r[0]) } : null;
  }

  let maxCount = null;
  const br = texParseBracket(line, pos);
  if (br[0] !== null) { maxCount = parseInt(br[0], 10); pos = br[1]; }
  const pr = texParseBrace(line, pos);
  const lr = texParseBrace(line, pr[1]);
  if (pr[0] == null || lr[0] == null) return null;
  return { macro, maxCount, points: Math.abs(parseInt(pr[0], 10)), label: texCleanLabel(lr[0]) };
}

function convertTexToTest(texContent, filename) {
  // Strip line comments
  const content = texContent.split('\n').map(function(l) {
    return l.replace(/(?<!\\)%.*$/, '');
  }).join('\n');

  const optMatch = content.match(/\\begin\{scorelist\}\s*(?:\[([^\]]*)\])?/);
  if (!optMatch) throw new Error('No \\begin{scorelist} found — is this a scorelist file?');

  const opts = {};
  if (optMatch[1]) {
    optMatch[1].split(',').forEach(function(pair) {
      const parts = pair.split('=').map(function(s) { return s.trim(); });
      const k = parts[0], v = parts[1];
      if (k) opts[k] = v !== undefined ? v : true;
    });
  }
  const timeLimit = opts.timelimit ? parseInt(opts.timelimit, 10) : null;

  // Derive id and name from filename
  const basename = filename.replace(/\.tex$/i, '');
  const testId = basename
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const testName = basename
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();

  const seenIds   = new Set();
  const sections  = [];
  let curSection  = null;
  let curItem     = null;

  function ensureSection() {
    if (!curSection) {
      curSection = { id: texSlugify('General'), heading: 'General', items: [] };
      sections.push(curSection);
    }
  }

  for (const line of content.split('\n')) {
    const p = texParseMacroOnLine(line);
    if (!p) continue;
    const { macro, maxCount, points, label } = p;

    if (macro === 'scoreheading') {
      curSection = { id: texUniqueId(texSlugify(label), seenIds), heading: label, items: [] };
      sections.push(curSection);
      curItem = null;
    } else if (macro === 'scoreitem') {
      ensureSection();
      const id = texUniqueId(texSlugify(label), seenIds);
      curItem = (maxCount != null && maxCount > 1)
        ? { id, type: 'count', label, points, maxCount }
        : { id, type: 'boolean', label, points };
      curSection.items.push(curItem);
    } else if (macro === 'scoremod') {
      if (!curItem) continue;
      const mod = { id: texUniqueId(texSlugify(label), seenIds), label, points };
      if (maxCount != null && maxCount > 1) { mod.type = 'count'; mod.maxCount = maxCount; }
      else mod.type = 'boolean';
      if (!curItem.modifiers) curItem.modifiers = [];
      curItem.modifiers.push(mod);
    } else if (macro === 'scorepen') {
      if (!curItem) continue;
      const pen = { id: texUniqueId(texSlugify(label), seenIds), type: 'fixed', label, points };
      if (maxCount != null) pen.maxCount = maxCount;
      if (!curItem.penalties) curItem.penalties = [];
      curItem.penalties.push(pen);
    } else if (macro === 'scorepenpcent') {
      if (!curItem) continue;
      const pen = { id: texUniqueId(texSlugify(label), seenIds), type: 'percentage', label, points: curItem.points };
      if (!curItem.penalties) curItem.penalties = [];
      curItem.penalties.push(pen);
    } else if (macro === 'penaltyitem') {
      ensureSection();
      const id   = texUniqueId(texSlugify(label), seenIds);
      const item = { id, type: 'standalone_penalty', label, points };
      if (maxCount != null) item.maxCount = maxCount;
      curSection.items.push(item);
      curItem = null;
    } else if (macro === 'infoitem') {
      ensureSection();
      curSection.items.push({ id: texUniqueId(texSlugify(label), seenIds), type: 'info', label });
      curItem = null;
    }
  }

  if (!sections.length) throw new Error('No sections or items found — is this a scorelist file?');
  return { id: testId, name: testName, timeLimit, sections };
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

function showScreen(id) {
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
  await updateDoc(doc(db, 'competitions', comp.id), { active: !comp.active });
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
  document.getElementById('comp-start-date').value = comp.startDate  || '';
  document.getElementById('comp-end-date').value   = comp.endDate    || '';
  document.getElementById('comp-timezone').value    = comp.timezone    || '';
  document.getElementById('comp-stream-url').value  = comp.streamUrl   || '';
  document.getElementById('comp-referee-pin').value = comp.refereePin  || '';

  const podiumSection = document.getElementById('comp-podium-section');
  if (!comp.adminCreated) {
    podiumSection.hidden = false;
    renderPodiumList(comp.podium || []);
  } else {
    podiumSection.hidden = true;
    document.getElementById('comp-podium-list').innerHTML = '';
  }

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
  const startDate = document.getElementById('comp-start-date').value || null;
  const endDate   = document.getElementById('comp-end-date').value   || null;
  const timezone  = document.getElementById('comp-timezone').value.trim() || null;
  const streamUrl   = document.getElementById('comp-stream-url').value.trim()   || null;
  const refereePin  = document.getElementById('comp-referee-pin').value.trim()  || null;

  if (!name) return;

  if (editingCompId) {
    const update = { name, city, country, year, active, startDate, endDate, timezone, streamUrl, refereePin };
    if (!document.getElementById('comp-podium-section').hidden) {
      update.podium = readPodiumFromForm();
    }
    await updateDoc(doc(db, 'competitions', editingCompId), update);
  } else {
    const id = document.getElementById('comp-id').value.trim();
    if (!id) return;
    await setDoc(doc(db, 'competitions', id), { id, name, city, country, year, active, startDate, endDate, timezone, streamUrl, refereePin, adminCreated: true });
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
    <span class="arena-chip">
      ${t.teamName}
      <button class="arena-chip-remove" data-id="${t.teamId}" title="Remove">×</button>
    </span>
  `).join('');
  el.querySelectorAll('.arena-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => removeCompTeam(btn.dataset.id));
  });
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

  // Referee field
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

  renderTeamList(slot);
  updateSlotLink(slot);
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
  const list  = document.getElementById('team-list');
  const teams = slot.teams || [];
  list.innerHTML = '';

  if (!teams.length) {
    list.innerHTML = '<div class="empty-state">No teams added yet.</div>';
    return;
  }

  teams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.innerHTML = `
      <span class="team-order">${idx + 1}</span>
      <div class="team-info">
        <div class="team-name">${team.teamName}</div>
        <div class="team-meta">ID: ${team.teamId}</div>
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
  // Re-number order fields
  const numbered = teams.map((t, i) => ({ ...t, order: i + 1 }));
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
  const base = `${location.origin}${location.pathname.replace('admin.html', '')}`;
  const links = slot.teams.map(t => {
    const params = new URLSearchParams({
      competition: currentCompetitionId,
      slot: currentSlotId,
      team: t.teamId,
      teamName: t.teamName,
      test: slot.testId
    });
    return `${t.teamName}: ${base}scoresheet.html?${params}`;
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
    try { compTests = await fetch('assets/scoring/tests/index.json').then(r => r.json()); } catch (_) {}
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
  if (type === 'inspection') return 'Robot Inspection';
  if (type === 'poster')     return 'Poster Session';
  if (type === 'other')      return slot.label || 'Other Event';
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
  const teamMeta  = (type === 'test' && teamCount)
    ? ' · ' + teamCount + ' team' + (teamCount !== 1 ? 's' : '') : '';

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
    if (!['test', 'inspection'].includes(type)) return;
    showSlotTeams(slot.id, name, slot, () => showSchedule(schedState.compId, schedState.compName));
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
  el.appendChild(makeSpecialCard('inspection', 'Robot Inspection', 'type-inspection'));
  el.appendChild(makeSpecialCard('poster',     'Poster Session',   'type-poster'));

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

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ff6b6b">Error: ${err.message}</div>`;
  console.error(err);
});
