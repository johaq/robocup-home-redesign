import { db, ensureAuth } from './firebase.js';
import {
  collection, doc, getDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

const params        = new URLSearchParams(window.location.search);
const competitionId = params.get('competition');

let slots       = {};
let runs        = {};
let inspections = {};
let filterArena = null;
let currentCompId = null;

const today = new Date().toISOString().slice(0, 10);

async function init() {
  await ensureAuth();

  if (!competitionId) {
    await showCompPicker();
  } else {
    await showQueue(competitionId);
  }

  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
}

async function showCompPicker() {
  const { getDocs } = await import("https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js");
  const snap = await getDocs(collection(db, 'competitions'));
  const comps = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.name && c.active)
    .sort((a, b) => (b.year || 0) - (a.year || 0));

  document.getElementById('queue-comp-name').textContent = 'Select Competition';
  document.getElementById('queue-subtitle').textContent = '';

  const content = document.getElementById('queue-content');
  content.innerHTML = '';
  for (const comp of comps) {
    const el = document.createElement('div');
    el.className = 'queue-comp-item';
    el.textContent = comp.name;
    el.addEventListener('click', async () => {
      document.getElementById('loading').hidden = false;
      document.getElementById('app').hidden = true;
      await showQueue(comp.id);
      document.getElementById('loading').hidden = true;
      document.getElementById('app').hidden = false;
    });
    content.appendChild(el);
  }
}

async function showQueue(compId) {
  currentCompId = compId;

  const compSnap = await getDoc(doc(db, 'competitions', compId));
  const compData = compSnap.exists() ? compSnap.data() : {};
  document.getElementById('queue-comp-name').textContent = compData.name || compId;

  onSnapshot(collection(db, 'competitions', compId, 'slots'), snap => {
    slots = {};
    snap.docs.forEach(d => { slots[d.id] = { id: d.id, ...d.data() }; });
    renderArenaFilter();
    render();
  });

  onSnapshot(collection(db, 'competitions', compId, 'runs'), snap => {
    runs = {};
    snap.docs.forEach(d => { runs[d.id] = d.data(); });
    render();
  });

  onSnapshot(collection(db, 'competitions', compId, 'inspections'), snap => {
    inspections = {};
    snap.docs.forEach(d => { inspections[d.id] = d.data(); });
    render();
  });
}

function renderArenaFilter() {
  const arenas = [...new Set(Object.values(slots).map(s => s.arena).filter(Boolean))].sort();
  const bar = document.getElementById('queue-arena-filter');
  bar.innerHTML = '';
  if (arenas.length < 2) return;

  ['All', ...arenas].forEach(v => {
    const val = v === 'All' ? null : v;
    const btn = document.createElement('button');
    btn.className = 'queue-arena-btn' + (filterArena === val ? ' active' : '');
    btn.textContent = v;
    btn.addEventListener('click', () => {
      filterArena = val;
      renderArenaFilter();
      render();
    });
    bar.appendChild(btn);
  });
}

function render() {
  const content = document.getElementById('queue-content');
  content.innerHTML = '';

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Get today's test slots sorted by time
  const todaySlots = Object.values(slots)
    .filter(s => {
      const type = s.type || 'test';
      if (!['test', 'inspection'].includes(type)) return false;
      if (s.date !== today) return false;
      if (filterArena && s.arena !== filterArena) return false;
      return true;
    })
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  if (todaySlots.length === 0) {
    content.innerHTML = '<div class="queue-empty">No slots scheduled for today.</div>';
    return;
  }

  // Find the "current" slot (next not-fully-done slot)
  let currentIdx = todaySlots.findIndex(slot => {
    const teams = slot.teams || [];
    if (teams.length === 0) return false;
    return teams.some(t => {
      const runStatus = runs[`${slot.id}_${t.teamId}`]?.status;
      return runStatus !== 'submitted';
    });
  });

  if (currentIdx === -1) currentIdx = todaySlots.length - 1;

  // Show current + next 2
  const visible = todaySlots.slice(currentIdx, currentIdx + 3);

  visible.forEach((slot, relIdx) => {
    const card = buildSlotCard(slot, relIdx);
    content.appendChild(card);
  });

  // Upcoming (rest of day after visible)
  const upcoming = todaySlots.slice(currentIdx + 3);
  if (upcoming.length > 0) {
    const section = document.createElement('div');
    section.className = 'queue-upcoming-section';
    const title = document.createElement('div');
    title.className = 'queue-upcoming-title';
    title.textContent = 'Later today';
    section.appendChild(title);
    upcoming.forEach(slot => {
      const row = document.createElement('div');
      row.className = 'queue-upcoming-row';
      const teams = (slot.teams || []).map(t => t.teamName).join(', ') || '—';
      const testName = getTestName(slot);
      row.innerHTML = `
        <span class="queue-upcoming-time">${slot.time || '—'}</span>
        <span class="queue-upcoming-test">${testName}</span>
        <span class="queue-upcoming-teams">${teams}</span>
      `;
      section.appendChild(row);
    });
    content.appendChild(section);
  }
}

function buildSlotCard(slot, relIdx) {
  const type = slot.type || 'test';
  const testName = getTestName(slot);
  const teams = slot.teams || [];

  const card = document.createElement('div');
  card.className = 'queue-slot-card' + (relIdx === 0 ? ' current' : relIdx === 1 ? ' next' : ' soon');

  const badge = relIdx === 0 ? 'NOW' : relIdx === 1 ? 'NEXT' : 'SOON';
  const badgeClass = relIdx === 0 ? 'badge-now' : relIdx === 1 ? 'badge-next' : 'badge-soon';

  card.innerHTML = `
    <div class="queue-card-header">
      <span class="queue-badge ${badgeClass}">${badge}</span>
      <span class="queue-slot-time">${slot.time || '—'}</span>
      <span class="queue-slot-test">${testName}</span>
      ${slot.arena ? `<span class="queue-slot-arena">${slot.arena}</span>` : ''}
    </div>
    <div class="queue-teams"></div>
  `;

  const teamsEl = card.querySelector('.queue-teams');

  if (teams.length === 0) {
    teamsEl.innerHTML = '<div class="queue-no-teams">No teams assigned</div>';
  } else {
    teams.forEach((team, idx) => {
      const runStatus = runs[`${slot.id}_${team.teamId}`]?.status || 'pending';
      const teamEl = document.createElement('div');
      teamEl.className = 'queue-team-row' + (runStatus === 'submitted' ? ' done' : '');

      const inspData = type === 'inspection' ? null : inspections[team.teamId];

      teamEl.innerHTML = `
        <div class="queue-team-header">
          <span class="queue-team-order">${idx + 1}</span>
          <span class="queue-team-name">${team.teamName}</span>
          <span class="queue-run-status status-${runStatus}">${statusLabel(runStatus)}</span>
        </div>
        ${type !== 'inspection' && inspData && runStatus !== 'submitted' ? renderInspSummary(inspData) : ''}
      `;
      teamsEl.appendChild(teamEl);
    });
  }

  return card;
}

function renderInspSummary(insp) {
  if (!insp) return '';
  const parts = [];
  if (insp.externalDevices?.trim()) {
    parts.push(`<div class="insp-detail"><span class="insp-detail-label">External Devices</span><span class="insp-detail-value">${escHtml(insp.externalDevices)}</span></div>`);
  }
  if (insp.startButton?.trim()) {
    parts.push(`<div class="insp-detail"><span class="insp-detail-label">Start Button</span><span class="insp-detail-value">${escHtml(insp.startButton)}</span></div>`);
  }
  if (insp.customContainers?.trim()) {
    parts.push(`<div class="insp-detail"><span class="insp-detail-label">Custom Containers</span><span class="insp-detail-value">${escHtml(insp.customContainers)}</span></div>`);
  }
  if (insp.emergencyButton?.trim()) {
    parts.push(`<div class="insp-detail"><span class="insp-detail-label">Emergency Button</span><span class="insp-detail-value">${escHtml(insp.emergencyButton)}</span></div>`);
  }
  if (!parts.length) return '';
  const resultBadge = insp.result === 'pass'
    ? '<span class="insp-result-badge pass">Passed</span>'
    : insp.result === 'fail'
    ? '<span class="insp-result-badge fail">Failed</span>'
    : '';
  return `<div class="queue-insp-summary">${resultBadge}${parts.join('')}</div>`;
}

function getTestName(slot) {
  const type = slot.type || 'test';
  if (type === 'inspection') return 'Robot Inspection';
  if (type === 'poster')     return 'Poster Session';
  if (type === 'other')      return slot.label || 'Other';
  return slot.testId || '—';
}

function statusLabel(status) {
  if (status === 'submitted') return 'Done';
  if (status === 'draft')     return 'In progress';
  return 'Pending';
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init().catch(err => {
  document.getElementById('loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
