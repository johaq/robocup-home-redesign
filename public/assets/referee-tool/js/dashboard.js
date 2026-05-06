import { db, ensureRefereeAuth, signOut, auth } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

const params        = new URLSearchParams(window.location.search);
const competitionId = params.get('competition');

let slots         = {};   // slotId → slot data
let runs          = {};   // runId  → run data
let inspections   = {};   // teamId → inspection data
let compTeams     = [];   // [{teamId, teamName}] for the competition
let expandedSlots = new Set();
let availableTests = [];
let filterArena   = null;
let filterReferee = null;
let currentCompId = null;
let hasInspectionSlot = false;

const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await ensureRefereeAuth();

  // Show sign-out button and wire it up
  const signOutBtn = document.getElementById('ref-signout-btn');
  if (signOutBtn) {
    signOutBtn.hidden = false;
    signOutBtn.onclick = async () => {
      await signOut(auth);
      window.location.reload();
    };
  }

  if (!competitionId) {
    await showCompetitionPicker();
  } else {
    await showDashboard(competitionId);
  }

  document.getElementById('loading').hidden = true;
}

// ── COMPETITION PICKER ────────────────────────────────────────────────────────

async function showCompetitionPicker() {
  const snap = await getDocs(collection(db, 'competitions'));
  const comps = snap.docs
    .map(d => d.data())
    .filter(c => c.name && c.active)
    .sort((a, b) => {
      if (a.adminCreated !== b.adminCreated) return a.adminCreated ? -1 : 1;
      return (b.year || 0) - (a.year || 0);
    });

  const list = document.getElementById('comp-list');
  for (const comp of comps) {
    const el = document.createElement('div');
    el.className = 'comp-item';
    el.innerHTML = `
      <div class="comp-info">
        <div class="comp-item-name">${comp.name}</div>
        <div class="comp-item-sub">${comp.city || ''}${comp.city && comp.country ? ', ' : ''}${comp.country || ''}</div>
      </div>
      <span class="comp-item-arrow">›</span>
    `;
    el.addEventListener('click', async () => {
      list.parentElement.hidden = true;
      document.getElementById('loading').hidden = false;
      await showDashboard(comp.id);
      document.getElementById('loading').hidden = true;
    });
    list.appendChild(el);
  }

  document.getElementById('screen-picker').hidden = false;
}

// ── PIN CHECK ─────────────────────────────────────────────────────────────────

async function requirePin(compId, compName, refereePin) {
  const storageKey = `ref_pin_${compId}`;
  if (sessionStorage.getItem(storageKey) === refereePin) return true;

  return new Promise(resolve => {
    document.getElementById('pin-comp-name').textContent = compName;
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-error').hidden = true;

    // Hide all other screens
    document.getElementById('screen-picker').hidden = true;
    document.getElementById('screen-slots').hidden  = true;
    document.getElementById('screen-pin').hidden    = false;

    document.getElementById('pin-form').onsubmit = e => {
      e.preventDefault();
      const entered = document.getElementById('pin-input').value.trim();
      if (entered === refereePin) {
        sessionStorage.setItem(storageKey, refereePin);
        document.getElementById('screen-pin').hidden = true;
        resolve(true);
      } else {
        document.getElementById('pin-error').hidden = false;
        document.getElementById('pin-input').value = '';
        document.getElementById('pin-input').focus();
      }
    };
  });
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

async function showDashboard(compId) {
  currentCompId = compId;

  const compSnap = await getDoc(doc(db, 'competitions', compId));
  const compData = compSnap.exists() ? compSnap.data() : {};

  document.getElementById('comp-name').textContent = compData.name || compId;

  // Check referee PIN if set
  if (compData.refereePin) {
    await requirePin(compId, compData.name || compId, compData.refereePin);
  }

  // Load available tests for this competition (for display names in slots)
  const testsSnap = await getDocs(collection(db, 'competitions', compId, 'tests'));
  if (!testsSnap.empty) {
    availableTests = testsSnap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }));
  } else {
    // Fallback to static index for backward compatibility
    try {
      availableTests = await fetch('assets/referee-tool/tests/index.json').then(r => r.json());
    } catch (_) {
      availableTests = [];
    }
  }

  // Real-time listeners
  onSnapshot(doc(db, 'competitions', compId), snap => {
    compTeams = snap.data()?.participatingTeams || [];
    renderInspectionPanel(compId);
  });

  onSnapshot(collection(db, 'competitions', compId, 'slots'), snap => {
    slots = {};
    snap.docs.forEach(d => { slots[d.id] = { id: d.id, ...d.data() }; });
    hasInspectionSlot = snap.docs.some(d => d.data().type === 'inspection');
    renderFilters();
    renderInspectionPanel(compId);
    renderSlots(compId);
  });

  onSnapshot(collection(db, 'competitions', compId, 'runs'), snap => {
    runs = {};
    snap.docs.forEach(d => { runs[d.id] = d.data(); });
    renderInspectionPanel(compId);
    renderSlots(compId);
    renderDashLeaderboard();
  });

  onSnapshot(collection(db, 'competitions', compId, 'inspections'), snap => {
    inspections = {};
    snap.docs.forEach(d => { inspections[d.id] = d.data(); });
    renderInspectionPanel(compId);
  });

  document.getElementById('screen-slots').hidden = false;
}

// ── RENDERING ─────────────────────────────────────────────────────────────────

function renderInspectionPanel(compId) {
  const panel = document.getElementById('inspection-panel');
  if (!panel) return;

  if (!hasInspectionSlot || compTeams.length === 0) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  const list = panel.querySelector('.insp-panel-teams');
  list.innerHTML = '';

  for (const team of compTeams) {
    const insp = inspections[team.teamId];
    const result = insp?.result || null;
    const submitted = insp?.submitted || false;

    let statusText = 'Not inspected';
    let statusClass = 'status-pending';
    if (submitted && result === 'pass') { statusText = 'Passed'; statusClass = 'status-submitted'; }
    else if (submitted && result === 'fail') { statusText = 'Failed'; statusClass = 'status-draft'; }
    else if (insp) { statusText = 'In progress'; statusClass = 'status-draft'; }

    const params = new URLSearchParams({
      competition: compId,
      team:        team.teamId,
      teamName:    team.teamName,
      back:        window.location.href
    });

    const row = document.createElement('a');
    row.className = 'team-row';
    row.href = `inspection.html?${params}`;
    row.innerHTML = `
      <span class="team-name">${team.teamName}</span>
      <span class="run-status ${statusClass}">${statusText}</span>
      <span class="open-icon">›</span>
    `;
    list.appendChild(row);
  }
}

function renderFilters() {
  const all      = Object.values(slots);
  const arenas   = [...new Set(all.map(s => s.arena).filter(Boolean))].sort();
  const referees = [...new Set(all.map(s => s.referee).filter(Boolean))].sort();

  const bar = document.getElementById('filter-bar');
  bar.hidden = arenas.length < 2 && !referees.length;

  function buildRow(containerId, label, values, current, setter) {
    const row = document.getElementById(containerId);
    row.innerHTML = '';
    if (!values.length) return;
    const lbl = document.createElement('span');
    lbl.className = 'filter-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    ['All', ...values].forEach(v => {
      const val = v === 'All' ? null : v;
      const btn = document.createElement('button');
      btn.className = 'filter-btn' + (current === val ? ' active' : '');
      btn.textContent = v;
      btn.addEventListener('click', () => {
        setter(val);
        renderFilters();
        renderSlots(currentCompId);
      });
      row.appendChild(btn);
    });
  }

  if (arenas.length >= 2) buildRow('arena-filter',   'Arena:',   arenas,   filterArena,   v => { filterArena   = v; });
  else document.getElementById('arena-filter').innerHTML = '';
  buildRow('referee-filter', 'Referee:', referees, filterReferee, v => { filterReferee = v; });
}

function renderSlots(compId) {
  const container = document.getElementById('slot-groups');
  container.innerHTML = '';

  const sorted = Object.values(slots)
    .filter(s => ['test', 'inspection'].includes(s.type || 'test')
              && (!filterArena   || s.arena   === filterArena)
              && (!filterReferee || s.referee === filterReferee))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  if (!sorted.length) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">No slots match the current filters.</div>';
    return;
  }

  // Group by date
  const byDate = {};
  for (const slot of sorted) {
    const d = slot.date || 'Unscheduled';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(slot);
  }

  // Today first, then chronologically
  const dates = Object.keys(byDate).sort((a, b) => {
    if (a === today) return -1;
    if (b === today) return 1;
    return a.localeCompare(b);
  });

  for (const date of dates) {
    const group = document.createElement('div');
    group.className = 'day-group';

    const label = document.createElement('div');
    label.className = 'day-label' + (date === today ? ' today' : '');
    label.textContent = date === today ? `Today — ${formatDate(date)}` : formatDate(date);
    group.appendChild(label);

    for (const slot of byDate[date]) {
      group.appendChild(renderSlotCard(slot, compId));
    }
    container.appendChild(group);
  }
}

function renderSlotCard(slot, compId) {
  const type     = slot.type || 'test';
  const testName = type === 'inspection' ? 'Robot Inspection'
                 : type === 'poster'     ? 'Poster Session'
                 : type === 'other'      ? (slot.label || 'Other')
                 : availableTests.find(t => t.id === slot.testId)?.name || slot.testId;
  const teams    = slot.teams || [];
  const isOpen   = expandedSlots.has(slot.id);

  // Compute per-team run statuses
  const teamStatuses = teams.map(t => {
    const run = runs[`${slot.id}_${t.teamId}`];
    return run?.status || 'pending';
  });

  const card = document.createElement('div');
  card.className = 'slot-card' + (isOpen ? ' open' : '');
  card.dataset.slotId = slot.id;

  // Progress dots (one per team) — not shown for inspection slots
  const dots = type === 'inspection' ? '' : teamStatuses.map(s =>
    `<span class="dot ${s === 'pending' ? '' : s}"></span>`
  ).join('');

  card.innerHTML = `
    <div class="slot-header">
      <span class="slot-time">${slot.time || '—'}</span>
      <div class="slot-info">
        <div class="slot-test">${testName}</div>
        <div class="slot-meta">${[slot.arena, slot.league, slot.referee].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="slot-progress">${dots}</div>
      <span class="slot-chevron">▲</span>
    </div>
    <div class="team-list"></div>
  `;

  // Toggle expand
  card.querySelector('.slot-header').addEventListener('click', () => {
    const open = card.classList.toggle('open');
    if (open) expandedSlots.add(slot.id);
    else       expandedSlots.delete(slot.id);
  });

  // Team rows
  const teamList = card.querySelector('.team-list');
  if (teams.length === 0) {
    teamList.innerHTML = '<div style="padding:12px 16px;color:var(--muted);font-size:0.85rem">No teams assigned.</div>';
  } else {
    teams.forEach((team, idx) => {
      const isInspection = type === 'inspection';
      const p = new URLSearchParams({
        competition: compId,
        slot:        slot.id,
        team:        team.teamId,
        teamName:    team.teamName,
        ...(isInspection ? { back: window.location.href } : { test: slot.testId })
      });

      let statusHtml = '';
      if (isInspection) {
        const insp = inspections[team.teamId];
        if (insp?.submitted && insp.result === 'pass') {
          statusHtml = '<span class="run-status status-submitted">Passed</span>';
        } else if (insp?.submitted && insp.result === 'fail') {
          statusHtml = '<span class="run-status status-draft">Failed</span>';
        }
      } else {
        const run    = runs[`${slot.id}_${team.teamId}`];
        const status = run?.status || 'pending';
        if (status === 'submitted' && run?.totalScore != null) {
          statusHtml = `<span class="run-status status-submitted">${run.totalScore} pts</span>`;
        } else {
          statusHtml = `<span class="run-status status-${status}">${statusLabel(status)}</span>`;
        }
      }

      const row = document.createElement('a');
      row.className = 'team-row';
      row.href      = isInspection ? `inspection.html?${p}` : `scoresheet.html?${p}`;
      row.innerHTML = `
        <span class="team-order">${idx + 1}</span>
        <span class="team-name">${team.teamName}</span>
        ${statusHtml}
        <span class="open-icon">›</span>
      `;
      teamList.appendChild(row);
    });
  }

  return card;
}

// ── MINI LEADERBOARD ──────────────────────────────────────────────────────────

function renderDashLeaderboard() {
  const panel = document.getElementById('dash-lb-panel');
  const list  = document.getElementById('dash-lb-list');

  const submitted = Object.values(runs).filter(r => r.status === 'submitted');
  if (!submitted.length) { panel.hidden = true; return; }

  const best = {};
  for (const run of submitted) {
    const { teamId, teamName, testId, totalScore } = run;
    if (!teamId || !testId) continue;
    const key = `${teamId}__${testId}`;
    if (!best[key] || (totalScore || 0) > best[key].score) {
      best[key] = { teamId, teamName: teamName || teamId, score: totalScore || 0 };
    }
  }

  const totals = {};
  for (const { teamId, teamName, score } of Object.values(best)) {
    if (!totals[teamId]) totals[teamId] = { teamName, total: 0 };
    totals[teamId].total += score;
  }

  const ranked = Object.entries(totals)
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => b.total - a.total);

  panel.hidden = false;
  list.innerHTML = ranked.map((entry, i) => `
    <div class="dash-lb-row">
      <span class="dash-lb-rank">${i + 1}</span>
      <span class="dash-lb-name">${entry.teamName}</span>
      <span class="dash-lb-score">${entry.total} pts</span>
    </div>
  `).join('');
}

// Toggle open/closed
document.getElementById('dash-lb-toggle').addEventListener('click', () => {
  document.getElementById('dash-lb-panel').classList.toggle('open');
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function statusLabel(status) {
  if (status === 'submitted') return 'Submitted';
  if (status === 'draft')     return 'In progress';
  return 'Not started';
}

function formatDate(dateStr) {
  if (!dateStr || dateStr === 'Unscheduled') return dateStr;
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  document.getElementById('loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
