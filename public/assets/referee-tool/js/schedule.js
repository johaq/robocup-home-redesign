import { db, ensureAuth } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, getDocsFromCache, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { todayInZone, schedDate, timeToMinutes } from './comp-utils.js';

// Compact, all-arenas schedule. When the same test runs at the same time in several
// arenas (only the teams differ), it's shown as ONE row listing every arena — unlike the
// public /competition grid which draws one column per arena.

const params        = new URLSearchParams(window.location.search);
const competitionId = params.get('competition');

let slots     = {};
let testsById = {};
let compTz    = null;
let today     = todayInZone(undefined);

async function init() {
  await ensureAuth();

  if (!competitionId) {
    await showCompPicker();
  } else {
    await showSchedule(competitionId);
  }

  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
}

// ── COMPETITION PICKER (no ?competition=) ───────────────────────────────────────

async function showCompPicker() {
  const compsRef = collection(db, 'competitions');
  document.getElementById('sched-comp-name').textContent = 'Select Competition';
  document.getElementById('sched-subtitle').textContent = '';

  const build = (docs) => {
    const comps = docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.name && c.active)
      .sort((a, b) => (b.year || 0) - (a.year || 0));

    const content = document.getElementById('sched-content');
    content.innerHTML = '';
    for (const comp of comps) {
      const el = document.createElement('div');
      el.className = 'sched-comp-item';
      el.textContent = comp.name;
      el.addEventListener('click', async () => {
        document.getElementById('loading').hidden = false;
        document.getElementById('app').hidden = true;
        await showSchedule(comp.id);
        document.getElementById('loading').hidden = true;
        document.getElementById('app').hidden = false;
      });
      content.appendChild(el);
    }
  };

  try {
    const cached = await getDocsFromCache(compsRef);
    if (!cached.empty) build(cached.docs);
  } catch (_) { /* no cache yet */ }

  const fresh = await getDocs(compsRef);
  build(fresh.docs);
}

// ── SCHEDULE ────────────────────────────────────────────────────────────────────

async function showSchedule(compId) {
  const compSnap = await getDoc(doc(db, 'competitions', compId));
  const compData = compSnap.exists() ? compSnap.data() : {};
  compTz = compData.timezone || null;
  today  = todayInZone(compTz || undefined);
  document.getElementById('sched-comp-name').textContent = compData.name || compId;
  document.getElementById('sched-subtitle').textContent = 'Schedule';

  // Test id → name, once.
  const testsSnap = await getDocs(collection(db, 'competitions', compId, 'tests'));
  testsById = {};
  testsSnap.docs.forEach(d => { testsById[d.id] = { id: d.id, ...d.data() }; });

  // Slots live — the schedule may be edited during the event.
  onSnapshot(collection(db, 'competitions', compId, 'slots'), snap => {
    slots = {};
    snap.docs.forEach(d => { slots[d.id] = { id: d.id, ...d.data() }; });
    scheduleRender();
  });
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
}

// ── MERGE + RENDER ──────────────────────────────────────────────────────────────

function slotDisplayName(slot) {
  const type = slot.type || 'test';
  if (type === 'inspection')     return 'Robot Inspection';
  if (type === 'poster')         return 'Poster Session';
  if (type === 'open_challenge') return 'Open Challenge';
  if (type === 'mapping')        return 'Arena Mapping';
  if (type === 'other')          return slot.label || 'Other Event';
  return testsById[slot.testId]?.name || slot.testId || '—';
}

// Collapse slots that are the same event (date + time + test/type) across arenas into one row.
function buildRows() {
  const groups = {};
  for (const s of Object.values(slots)) {
    const type = s.type || 'test';
    const key  = `${s.date}|${s.time}|${type}|${s.testId || s.label || ''}`;
    if (!groups[key]) {
      groups[key] = { date: s.date, time: s.time, name: slotDisplayName(s), arenas: new Set(), teams: 0 };
    }
    if (s.arena) groups[key].arenas.add(s.arena);
    groups[key].teams += (s.teams || []).length;
  }
  return Object.values(groups).map(g => ({ ...g, arenas: [...g.arenas].sort() }));
}

function render() {
  const content = document.getElementById('sched-content');
  content.innerHTML = '';

  const rows = buildRows();
  if (!rows.length) {
    content.innerHTML = '<div class="sched-empty">No schedule yet.</div>';
    return;
  }

  const byDate = {};
  for (const r of rows) (byDate[r.date] ||= []).push(r);
  const dates = Object.keys(byDate).sort();

  for (const date of dates) {
    const isToday = date === today;

    const dayEl = document.createElement('div');
    dayEl.className = 'sched-day' + (isToday ? ' today' : '');

    const head = document.createElement('div');
    head.className = 'sched-day-head';
    head.innerHTML = `<span class="sched-day-date">${escHtml(schedDate(date))}</span>${isToday ? '<span class="sched-today-badge">Today</span>' : ''}`;
    dayEl.appendChild(head);

    const dayRows = byDate[date].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    for (const r of dayRows) {
      const row = document.createElement('div');
      row.className = 'sched-row';
      const arenas = r.arenas.length
        ? r.arenas.map(a => `<span class="sched-arena">${escHtml(a)}</span>`).join('')
        : '';
      const teams = r.teams ? `<span class="sched-teams">${r.teams} team${r.teams !== 1 ? 's' : ''}</span>` : '';
      row.innerHTML = `
        <span class="sched-time">${escHtml(r.time || '—')}</span>
        <span class="sched-name">${escHtml(r.name)}</span>
        <span class="sched-arenas">${arenas}</span>
        ${teams}
      `;
      dayEl.appendChild(row);
    }

    content.appendChild(dayEl);
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init().catch(err => {
  document.getElementById('loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
