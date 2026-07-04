import { db, ensureAuth } from './firebase-public.js';
import {
  doc, collection, getDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import {
  todayInZone, nowTimeInZone, utcOffsetLabel, formatDateRange,
  timeToMinutes, minutesToTime, schedDate
} from '../referee-tool/js/comp-utils.js';
import { bestRunsPerTeamTest } from '../referee-tool/js/score-utils.js';

const base     = window.__siteBase || '';
const params   = new URLSearchParams(window.location.search);
const compId   = params.get('id');
const fromPage = params.get('from');

// ── BACK LINK ─────────────────────────────────────────────────────────────────

const backLink = document.getElementById('back-link');
if (fromPage === 'team') {
  const teamId = params.get('teamId');
  if (teamId) {
    backLink.href        = `${base}/team?id=${encodeURIComponent(teamId)}`;
    backLink.textContent = '← Back to team';
  }
} else {
  backLink.href        = `${base}/history`;
  backLink.textContent = '← Back to history';
}

// ── SCHEDULE GRID CONSTANTS (must match admin.js / scoring/competition.js) ────

const SCHED = { CELL_H: 40, TIME_W: 56, COL_W: 180, HEADER_H: 48 };

// ── STATE ─────────────────────────────────────────────────────────────────────

let comp             = null;
let slots            = {};
let runs             = {};
let tests            = [];
let activeTeamFilter = '';
let posterScoresByTeam = {};  // teamId → final score out of 50

// ── TIMEZONE HELPERS ──────────────────────────────────────────────────────────

function compTz() {
  return comp?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}


// ── MEDAL HELPERS ─────────────────────────────────────────────────────────────

function medalClass(place) {
  if (place === 1) return 'm-gold';
  if (place === 2) return 'm-silver';
  if (place === 3) return 'm-bronze';
  return 'm-other';
}

function placeLabel(place) {
  if (place === 1) return '1st';
  if (place === 2) return '2nd';
  if (place === 3) return '3rd';
  return `${place}th`;
}

// ── SLOT HELPERS ──────────────────────────────────────────────────────────────

function slotDisplayName(slot) {
  const type = slot.type || 'test';
  if (type === 'inspection')     return 'Robot Inspection';
  if (type === 'poster')         return 'Poster Session';
  if (type === 'open_challenge') return 'Open Challenge';
  if (type === 'mapping')        return 'Arena Mapping';
  if (type === 'other')          return slot.label || 'Other Event';
  return tests.find(t => t.id === slot.testId)?.name || slot.testId || '—';
}

function slotStatus(slot) {
  const tz      = compTz();
  const today   = todayInZone(tz);
  const nowTime = nowTimeInZone(tz);
  const type    = slot.type || 'test';

  if (slot.date > today) return 'future';
  if (slot.date < today) return 'past';
  if (slot.time > nowTime) return 'future';

  if (type !== 'test') {
    const startMin = timeToMinutes(slot.time);
    const endMin   = startMin + (slot.durationMinutes || 60);
    const nowMin   = timeToMinutes(nowTime);
    return nowMin < endMin ? 'active' : 'past';
  }

  const teams = slot.teams || [];
  if (teams.length === 0) return 'past';
  const allSubmitted = teams.every(t => runs[`${slot.id}_${t.teamId}`]?.status === 'submitted');
  return allSubmitted ? 'past' : 'active';
}

// ── TEAM FILTER ───────────────────────────────────────────────────────────────

function setupTeamFilter() {
  const teams = (comp.participatingTeams || [])
    .slice().sort((a, b) => a.teamName.localeCompare(b.teamName));
  if (!teams.length) return;

  const select = document.getElementById('comp-team-filter');
  select.innerHTML = '<option value="">All teams</option>' +
    teams.map(t => `<option value="${t.teamId}">${t.teamName}</option>`).join('');
  select.value = activeTeamFilter;

  document.getElementById('comp-sched-filter').hidden = false;

  select.addEventListener('change', () => {
    activeTeamFilter = select.value;
    applyTeamFilter();
  });
}

function applyTeamFilter() {
  const outer       = document.getElementById('comp-sched-outer');
  const wrap        = outer?.querySelector('.comp-sched-wrap');
  const allDayCols  = [...(outer?.querySelectorAll('.comp-sched-day-col')  || [])];
  const allColHeads = [...(outer?.querySelectorAll('.comp-sched-col-head') || [])];

  if (!activeTeamFilter) {
    outer?.querySelectorAll('.comp-sched-slot').forEach(el => {
      el.hidden = false;
      const metaEl = el.querySelector('.comp-sched-slot-meta');
      if (metaEl && el.dataset.defaultMeta) metaEl.textContent = el.dataset.defaultMeta;
    });
    allDayCols.forEach(el  => { el.style.display = ''; });
    allColHeads.forEach(el => { el.style.display = ''; });
    if (wrap) wrap.style.width = (SCHED.TIME_W + allDayCols.length * SCHED.COL_W) + 'px';
    return;
  }

  // Show only test/mapping slots that include the selected team; collect their column ids
  const visibleColIds = new Set();
  outer?.querySelectorAll('.comp-sched-slot').forEach(el => {
    const slot = slots[el.dataset.slotId];
    if (!slot) { el.hidden = true; return; }
    const type = slot.type || 'test';
    if (type !== 'test' && type !== 'mapping' && type !== 'inspection' && type !== 'open_challenge') { el.hidden = true; return; }
    const teamEntry = (slot.teams || []).find(t => t.teamId === activeTeamFilter);
    el.hidden = !teamEntry;
    if (teamEntry) {
      const metaEl = el.querySelector('.comp-sched-slot-meta');
      if (metaEl) {
        if (type === 'mapping') {
          const startMin = timeToMinutes(slot.time) + (teamEntry.startOffset || 0);
          metaEl.textContent = minutesToTime(startMin);
        } else {
          metaEl.textContent = `#${teamEntry.order} of ${slot.teams.length}`;
        }
      }
      const colEl = el.closest('.comp-sched-day-col');
      if (colEl) visibleColIds.add(colEl.dataset.colId);
    }
  });

  // Hide columns that have no visible slots; count the ones that remain
  let visibleCount = 0;
  allDayCols.forEach(el => {
    const show = visibleColIds.has(el.dataset.colId);
    el.style.display = show ? '' : 'none';
    if (show) visibleCount++;
  });
  allColHeads.forEach(el => {
    el.style.display = visibleColIds.has(el.dataset.colId) ? '' : 'none';
  });

  // Shrink the wrap so there's no dead space on the right
  if (wrap) wrap.style.width = (SCHED.TIME_W + visibleCount * SCHED.COL_W) + 'px';
}

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await ensureAuth();

  if (!compId) { showError('No competition specified.'); return; }

  const compSnap = await getDoc(doc(db, 'competitions', compId));
  if (!compSnap.exists()) { showError('Competition not found.'); return; }
  comp = { id: compId, ...compSnap.data() };

  document.title = `${comp.name} — RoboCup@Home`;
  document.getElementById('comp-loading').hidden = true;

  if (comp.adminCreated) {
    await loadModern();
  } else {
    renderLegacy();
  }
}

// ── MODERN VIEW ───────────────────────────────────────────────────────────────

async function loadModern() {
  const testsSnap = await getDocs(collection(db, 'competitions', compId, 'tests'));
  tests = testsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  renderModernInfo();
  setupTeamFilter();

  if (comp.active) {
    // Live competition: real-time listeners + live/upnext boxes
    document.getElementById('comp-top-grid').style.gridTemplateColumns = '1fr 340px';
    document.getElementById('comp-live-col').hidden = false;

    onSnapshot(collection(db, 'competitions', compId, 'slots'), snap => {
      slots = {};
      snap.docs.forEach(d => { slots[d.id] = { id: d.id, ...d.data() }; });
      renderSchedule();
      renderLiveBox();
      loadPosterScores().then(renderLeaderboard);
    });
    onSnapshot(collection(db, 'competitions', compId, 'runs'), snap => {
      runs = {};
      snap.docs.forEach(d => { runs[d.id] = d.data(); });
      renderLiveBox();
      updateSlotStates();
      renderLeaderboard();
    });
    setInterval(() => { renderLiveBox(); updateSlotStates(); }, 60_000);
  } else {
    // Past competition: fetch slots and runs in parallel but render schedule the moment
    // slots arrive — don't block on runs (which may be larger / slower).
    const runsPromise = getDocs(collection(db, 'competitions', compId, 'runs'));
    const slotsSnap = await getDocs(collection(db, 'competitions', compId, 'slots'));
    slotsSnap.docs.forEach(d => { slots[d.id] = { id: d.id, ...d.data() }; });
    renderSchedule();

    document.getElementById('slot-panel-close').addEventListener('click', closeSlotPanel);
    document.getElementById('slot-panel-backdrop').addEventListener('click', closeSlotPanel);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSlotPanel(); });
    document.getElementById('comp-page').hidden = false;

    // Leaderboard and slot states update once runs + poster scores arrive (non-blocking)
    Promise.all([
      runsPromise,
      loadPosterScores(),
    ]).then(([runsSnap]) => {
      runsSnap.docs.forEach(d => { runs[d.id] = d.data(); });
      renderLeaderboard();
      updateSlotStates();
    });
    return;
  }

  document.getElementById('slot-panel-close').addEventListener('click', closeSlotPanel);
  document.getElementById('slot-panel-backdrop').addEventListener('click', closeSlotPanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSlotPanel(); });

  document.getElementById('comp-page').hidden = false;
}

function renderModernInfo() {
  const tz     = compTz();
  const offset = utcOffsetLabel(tz);

  document.getElementById('comp-title').textContent = comp.name;

  const metaParts = [];
  if (comp.city || comp.country)
    metaParts.push(`<span>📍 ${[comp.city, comp.country].filter(Boolean).join(', ')}</span>`);
  if (comp.startDate)
    metaParts.push(`<span>📅 ${formatDateRange(comp.startDate, comp.endDate, tz)}</span>`);
  document.getElementById('comp-header-meta').innerHTML = metaParts.join('');

  const rows = [];
  if (comp.city || comp.country)
    rows.push(['Location', [comp.city, comp.country].filter(Boolean).join(', ')]);
  if (comp.startDate)
    rows.push(['Dates', formatDateRange(comp.startDate, comp.endDate, tz)]);
  if (comp.timezone)
    rows.push(['Timezone', `${comp.timezone} (${offset})`]);

  document.getElementById('comp-details').innerHTML = rows.map(([k, v]) => `
    <div class="comp-detail-row">
      <span class="comp-detail-key">${k}</span>
      <span class="comp-detail-val">${v}</span>
    </div>
  `).join('');

  const teams   = comp.participatingTeams || [];
  const teamsEl = document.getElementById('comp-teams-list');
  if (teams.length) {
    teamsEl.innerHTML = `<div class="comp-teams-grid">${
      teams.map(t =>
        `<a href="${base}/team?id=${encodeURIComponent(t.teamId)}&from=competition&compId=${compId}" class="comp-team-chip">${t.teamName}</a>`
      ).join('')
    }</div>`;
  } else {
    teamsEl.innerHTML = '<div class="comp-teams-empty">No teams listed yet.</div>';
  }

  if (comp.timezone) {
    document.getElementById('comp-tz-note').textContent =
      `All times in competition timezone — ${comp.timezone} (${offset})`;
  }

  // Live watch links (only relevant when active, but set always)
  document.getElementById('comp-live-link').href = `${base}/display?competition=${compId}`;
  const streamLink = document.getElementById('comp-stream-link');
  if (comp.streamUrl) {
    streamLink.href   = comp.streamUrl;
    streamLink.hidden = false;
  }
}

// ── LIVE BOX ──────────────────────────────────────────────────────────────────

function renderLiveBox() {
  const allSlots = Object.values(slots);

  const activeSlots = allSlots
    .filter(s => (s.type || 'test') === 'test' && slotStatus(s) === 'active')
    .sort((a, b) => a.time.localeCompare(b.time));

  const liveEl  = document.getElementById('comp-live-slots');
  const emptyEl = document.getElementById('comp-live-empty');

  if (activeSlots.length) {
    emptyEl.hidden = true;
    liveEl.innerHTML = '';
    for (const slot of activeSlots) {
      const testName = slotDisplayName(slot);
      const teams    = slot.teams || [];
      const el = document.createElement('div');
      el.className = 'comp-live-slot';
      const dots = teams.map(t => {
        const status = runs[`${slot.id}_${t.teamId}`]?.status || 'pending';
        const cls = status === 'submitted' ? 'done' : status === 'draft' ? 'active' : '';
        return `<span class="comp-run-dot ${cls}" title="${t.teamName}"></span>`;
      }).join('');
      el.innerHTML = `
        <div class="comp-live-slot-name">${testName}</div>
        <div class="comp-live-slot-meta">
          <span>${slot.time}</span>
          ${slot.arena    ? `<span>${slot.arena}</span>`    : ''}
          ${slot.referee  ? `<span>${slot.referee}</span>`  : ''}
        </div>
        ${dots ? `<div class="comp-live-slot-progress">${dots}</div>` : ''}
      `;
      liveEl.appendChild(el);
    }
  } else {
    emptyEl.hidden = false;
    liveEl.innerHTML = '';
  }

  const tz    = compTz();
  const today = todayInZone(tz);
  const now   = nowTimeInZone(tz);

  const upcomingSlots = allSlots
    .filter(s => s.date === today && s.time > now && (s.type || 'test') === 'test')
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(0, 5);

  const upcomingEl      = document.getElementById('comp-upcoming-slots');
  const upcomingEmptyEl = document.getElementById('comp-upcoming-empty');

  if (upcomingSlots.length) {
    upcomingEmptyEl.hidden = true;
    upcomingEl.innerHTML = upcomingSlots.map(slot => `
      <div class="comp-upcoming-slot">
        <span class="comp-upcoming-time">${slot.time}</span>
        <span class="comp-upcoming-name">${slotDisplayName(slot)}</span>
        ${slot.arena ? `<span class="comp-upcoming-arena">${slot.arena}</span>` : ''}
      </div>
    `).join('');
  } else {
    upcomingEmptyEl.hidden = false;
    upcomingEl.innerHTML = '';
  }
}

// ── POSTER SCORES ─────────────────────────────────────────────────────────────

const POSTER_OUTLIER_N = 2;

async function loadPosterScores() {
  const posterSlots = Object.values(slots).filter(s => s.type === 'poster');
  if (!posterSlots.length) { posterScoresByTeam = {}; return; }

  const rawByPresenter = {};
  for (const slot of posterSlots) {
    const snap = await getDocs(
      collection(db, 'competitions', compId, 'slots', slot.id, 'posterScores')
    );
    snap.docs.forEach(d => {
      const { judgeTeamId, scores = {} } = d.data();
      for (const [presenterTeamId, raw] of Object.entries(scores)) {
        if (presenterTeamId === judgeTeamId) continue;
        if (!rawByPresenter[presenterTeamId]) rawByPresenter[presenterTeamId] = [];
        rawByPresenter[presenterTeamId].push(raw);
      }
    });
  }

  posterScoresByTeam = {};
  for (const [teamId, raws] of Object.entries(rawByPresenter)) {
    const scaled = raws.map(s => s * 5);
    let final;
    if (scaled.length <= 2 * POSTER_OUTLIER_N) {
      final = scaled.reduce((a, b) => a + b, 0) / scaled.length;
    } else {
      const sorted  = [...scaled].sort((a, b) => a - b);
      const trimmed = sorted.slice(POSTER_OUTLIER_N, sorted.length - POSTER_OUTLIER_N);
      final = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    }
    posterScoresByTeam[teamId] = final;
  }
}

// ── LEADERBOARD ───────────────────────────────────────────────────────────────

function renderLeaderboard() {
  const section = document.getElementById('comp-leaderboard-section');
  const el      = document.getElementById('comp-leaderboard');

  const submittedRuns = Object.values(runs).filter(r => r.status === 'submitted');
  const hasPoster     = Object.keys(posterScoresByTeam).length > 0;
  if (!submittedRuns.length && !hasPoster) { section.hidden = true; return; }

  const finalsRuns    = submittedRuns.filter(r => r.testId === 'finals');
  const preFinalsRuns = submittedRuns.filter(r => r.testId !== 'finals');
  const hasFinalsRuns = finalsRuns.length > 0;

  const teamNameMap = {};
  (comp.participatingTeams || []).forEach(t => { teamNameMap[String(t.teamId)] = t.teamName; });

  // Best pre-finals score per team+test
  const bestByTeamTest = bestRunsPerTeamTest(preFinalsRuns);

  const totals = {};
  for (const { teamId, teamName, flooredScore } of Object.values(bestByTeamTest)) {
    if (!totals[teamId]) totals[teamId] = { teamName: teamName || teamId, preTotal: 0, runCount: 0, posterScore: null, finalsScore: 0 };
    totals[teamId].preTotal  += flooredScore;
    totals[teamId].runCount  += 1;
  }

  // Add poster scores to pre-finals total
  for (const [teamId, score] of Object.entries(posterScoresByTeam)) {
    if (!totals[teamId]) totals[teamId] = { teamName: teamNameMap[teamId] || teamId, preTotal: 0, runCount: 0, posterScore: null, finalsScore: 0 };
    totals[teamId].preTotal    += score;
    totals[teamId].posterScore  = score;
  }

  // Best finals score per team
  for (const run of finalsRuns) {
    const id = String(run.teamId);
    const s  = Math.max(0, run.totalScore || 0);
    if (!totals[id]) totals[id] = { teamName: run.teamName || teamNameMap[id] || id, preTotal: 0, runCount: 0, posterScore: null, finalsScore: 0 };
    if (s > totals[id].finalsScore) totals[id].finalsScore = s;
  }

  section.hidden = false;
  document.getElementById('comp-results-link').href = `${base}/results?id=${compId}`;

  if (hasFinalsRuns) {
    const maxPreFinals = Math.max(1, ...Object.values(totals).map(t => t.preTotal));
    const maxFinals    = Math.max(1, ...Object.values(totals).map(t => t.finalsScore));
    const ranked = Object.entries(totals)
      .map(([teamId, d]) => ({ teamId, ...d, combined: d.preTotal / maxPreFinals * 0.5 + d.finalsScore / maxFinals * 0.5 }))
      .sort((a, b) => b.combined - a.combined);

    el.innerHTML = ranked.map((entry, i) => {
      const pct        = Math.round(entry.combined * 100);
      const medal      = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
      const prePts     = entry.preTotal % 1 === 0 ? entry.preTotal : entry.preTotal.toFixed(1);
      const scoreLabel = `pre-finals ${prePts} pts`;
      return `
        <div class="comp-lb-row">
          <div class="comp-lb-rank">${medal || (i + 1)}</div>
          <div class="comp-lb-team">
            <a href="${base}/team?id=${encodeURIComponent(entry.teamId)}&from=competition&compId=${compId}" class="comp-lb-team-name">${entry.teamName}</a>
            <div class="comp-lb-bar-wrap">
              <div class="comp-lb-bar" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="comp-lb-score">
            <span class="comp-lb-total">${pct}%</span>
            <span class="comp-lb-runs">${scoreLabel}</span>
          </div>
        </div>
      `;
    }).join('');
  } else {
    const ranked = Object.entries(totals)
      .map(([teamId, d]) => ({ teamId, ...d, total: d.preTotal }))
      .sort((a, b) => b.total - a.total);

    const topScore = ranked[0]?.total || 1;
    el.innerHTML = ranked.map((entry, i) => {
      const pct        = Math.max(0, Math.round((entry.total / topScore) * 100));
      const medal      = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
      const runLabel   = entry.runCount ? `${entry.runCount} run${entry.runCount !== 1 ? 's' : ''}` : null;
      const postLabel  = entry.posterScore != null ? `poster ${entry.posterScore.toFixed(1)}` : null;
      const scoreLabel = [runLabel, postLabel].filter(Boolean).join(' + ');
      return `
        <div class="comp-lb-row">
          <div class="comp-lb-rank">${medal || (i + 1)}</div>
          <div class="comp-lb-team">
            <a href="${base}/team?id=${encodeURIComponent(entry.teamId)}&from=competition&compId=${compId}" class="comp-lb-team-name">${entry.teamName}</a>
            <div class="comp-lb-bar-wrap">
              <div class="comp-lb-bar" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="comp-lb-score">
            <span class="comp-lb-total">${entry.total % 1 === 0 ? entry.total : entry.total.toFixed(1)}</span>
            <span class="comp-lb-runs">${scoreLabel}</span>
          </div>
        </div>
      `;
    }).join('');
  }
}

// ── SCHEDULE GRID ─────────────────────────────────────────────────────────────

function renderSchedule() {
  const outer   = document.getElementById('comp-sched-outer');
  const nodates = document.getElementById('comp-sched-nodates');
  outer.innerHTML = '';

  if (!comp.startDate || !comp.endDate) {
    nodates.hidden = false;
    outer.hidden   = true;
    return;
  }
  nodates.hidden = true;
  outer.hidden   = false;

  const slotList = Object.values(slots);
  if (!slotList.length) {
    outer.innerHTML = '<div style="padding:48px;text-align:center;color:var(--muted);font-size:14px">No schedule data available.</div>';
    return;
  }

  const days = [];
  let cur     = new Date(comp.startDate + 'T12:00:00');
  const end   = new Date(comp.endDate   + 'T12:00:00');
  while (cur <= end) {
    days.push(new Intl.DateTimeFormat('sv').format(cur));
    cur.setDate(cur.getDate() + 1);
  }

  const arenas  = [...new Set(slotList.map(s => s.arena).filter(Boolean))].sort();
  const allMins = slotList.flatMap(s => {
    const start = timeToMinutes(s.time);
    const dur   = s.durationMinutes || 60;
    return [start, start + dur];
  });
  const openMin  = Math.min(480,  ...allMins.map(m => Math.floor(m / 60) * 60));
  const closeMin = Math.max(1200, ...allMins.map(m => Math.ceil(m  / 60) * 60));

  outer.appendChild(buildGrid(days, arenas, openMin, closeMin));
  renderSlotBlocks(days, arenas, openMin);
  updateSlotStates();
  applyTeamFilter();

  if (comp.active) updateNowLine();

  outer.addEventListener('click', e => {
    const block = e.target.closest('.comp-sched-slot');
    if (!block || !block.classList.contains('slot-clickable')) return;
    const slot = slots[block.dataset.slotId];
    if (slot) openSlotPanel(slot);
  });
}

function updateSlotStates() {
  for (const slot of Object.values(slots)) {
    const el = document.querySelector(`.comp-sched-slot[data-slot-id="${slot.id}"]`);
    if (!el) continue;
    const status   = slotStatus(slot);
    const type     = slot.type || 'test';
    const hasTeams = (slot.teams || []).length > 0;
    el.classList.toggle('slot-active',    status === 'active');
    el.classList.toggle('slot-done',      status === 'past');
    el.classList.toggle('slot-clickable', type === 'poster' || (hasTeams && (type === 'test' || type === 'mapping' || type === 'inspection' || type === 'open_challenge')));
  }
  if (comp.active) updateNowLine();
}

function buildGrid(days, arenas, openMin, closeMin) {
  const intervals = [];
  for (let m = openMin; m < closeMin; m += 30) intervals.push(m);

  const cols = arenas.length
    ? days.flatMap(day => arenas.map(arena => ({ day, arena })))
    : days.map(day => ({ day, arena: '' }));

  const totalW = SCHED.TIME_W + cols.length * SCHED.COL_W;

  const wrap = document.createElement('div');
  wrap.className   = 'comp-sched-wrap';
  wrap.style.width = totalW + 'px';

  const header = document.createElement('div');
  header.className = 'comp-sched-header';
  header.style.height = SCHED.HEADER_H + 'px';

  const corner = document.createElement('div');
  corner.className = 'comp-sched-corner';
  corner.style.cssText = `width:${SCHED.TIME_W}px;height:${SCHED.HEADER_H}px;`;
  header.appendChild(corner);

  let lastDay = null;
  cols.forEach(col => {
    const head = document.createElement('div');
    head.className = 'comp-sched-col-head' + (col.day !== lastDay ? ' day-start' : '');
    head.style.cssText = `width:${SCHED.COL_W}px;height:${SCHED.HEADER_H}px;`;
    head.innerHTML = col.arena
      ? `<span class="comp-sched-col-date">${schedDate(col.day)}</span><span class="comp-sched-col-arena">${col.arena}</span>`
      : `<span class="comp-sched-col-date">${schedDate(col.day)}</span>`;
    head.dataset.colId = col.day + '__' + col.arena;
    header.appendChild(head);
    lastDay = col.day;
  });
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'comp-sched-body';

  const timeCol = document.createElement('div');
  timeCol.className = 'comp-sched-time-col';
  timeCol.style.width = SCHED.TIME_W + 'px';
  intervals.forEach(m => {
    const row = document.createElement('div');
    row.className = 'comp-sched-time-row';
    row.style.height = SCHED.CELL_H + 'px';
    if (m % 60 === 0) row.innerHTML = `<span class="comp-sched-time-label">${minutesToTime(m)}</span>`;
    timeCol.appendChild(row);
  });
  body.appendChild(timeCol);

  lastDay = null;
  cols.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'comp-sched-day-col' + (col.day !== lastDay ? ' day-start' : '');
    colEl.style.cssText = `width:${SCHED.COL_W}px;height:${intervals.length * SCHED.CELL_H}px;`;
    colEl.dataset.colId = col.day + '__' + col.arena;

    intervals.forEach(m => {
      const cell = document.createElement('div');
      cell.className = 'comp-sched-cell' + (m % 60 === 0 ? ' hour' : '');
      cell.style.height = SCHED.CELL_H + 'px';
      colEl.appendChild(cell);
    });

    body.appendChild(colEl);
    lastDay = col.day;
  });

  wrap.appendChild(body);
  return wrap;
}

function renderSlotBlocks(days, arenas, openMin) {
  const outer = document.getElementById('comp-sched-outer');

  for (const slot of Object.values(slots)) {
    const colId = slot.date + '__' + (slot.arena || '');
    const colEl = outer.querySelector(`.comp-sched-day-col[data-col-id="${CSS.escape(colId)}"]`);
    if (!colEl) continue;

    const type        = slot.type || 'test';
    const displayName = slotDisplayName(slot);
    const startMin    = timeToMinutes(slot.time);
    const duration    = slot.durationMinutes || 60;
    const topPx       = (startMin - openMin) / 30 * SCHED.CELL_H;
    const heightPx    = Math.max(SCHED.CELL_H, duration / 30 * SCHED.CELL_H);
    const teamCount   = (slot.teams || []).length;

    const block = document.createElement('div');
    block.className = `comp-sched-slot type-${type}`;
    block.dataset.slotId   = slot.id;
    block.dataset.slotType = type;
    block.style.cssText = `top:${topPx}px;height:${heightPx}px;`;

    const metaParts = [slot.time];
    if ((type === 'test' || type === 'inspection' || type === 'open_challenge') && teamCount) metaParts.push(teamCount + ' team' + (teamCount !== 1 ? 's' : ''));
    if (type === 'mapping' && teamCount) metaParts.push(teamCount + ' × 10 min');
    if (slot.referee) metaParts.push(slot.referee);
    const defaultMeta = metaParts.join(' · ');
    block.dataset.defaultMeta = defaultMeta;
    block.innerHTML = `
      <div class="comp-sched-slot-name">${displayName}</div>
      <div class="comp-sched-slot-meta">${defaultMeta}</div>
    `;

    colEl.appendChild(block);
  }
}

function updateNowLine() {
  document.querySelectorAll('.comp-sched-now-line').forEach(el => el.remove());

  const tz    = compTz();
  const today = todayInZone(tz);
  const now   = nowTimeInZone(tz);

  document.querySelectorAll('.comp-sched-day-col').forEach(colEl => {
    if (!(colEl.dataset.colId || '').startsWith(today)) return;

    const sched = document.querySelector('.comp-sched-time-row span.comp-sched-time-label');
    if (!sched) return;
    const openMin = timeToMinutes(sched.textContent);
    const nowMin  = timeToMinutes(now);
    const topPx   = (nowMin - openMin) / 30 * SCHED.CELL_H;
    if (topPx < 0) return;

    const line = document.createElement('div');
    line.className = 'comp-sched-now-line';
    line.style.top = topPx + 'px';
    colEl.appendChild(line);
  });
}

// ── SLOT DETAIL PANEL ─────────────────────────────────────────────────────────

function openSlotPanel(slot) {
  const testName = slotDisplayName(slot);
  const teams    = slot.teams || [];

  document.getElementById('slot-panel-title').textContent = testName;

  const metaParts = [slot.time];
  if (slot.arena)   metaParts.push(slot.arena);
  if (slot.referee) metaParts.push(slot.referee);
  document.getElementById('slot-panel-meta').textContent = metaParts.join(' · ');

  const body = document.getElementById('slot-panel-body');
  if (slot.type === 'poster') {
    openPosterPanel(slot.id, body);
  } else if (slot.type === 'inspection' || slot.type === 'open_challenge') {
    body.innerHTML = teams.map((t, idx) => `
      <div class="slot-panel-team-row">
        <div class="slot-panel-team-left">
          <span class="slot-panel-dot"></span>
          <span class="slot-panel-team-name">${t.teamName}</span>
        </div>
        <div class="slot-panel-team-right">
          <span class="slot-panel-status">#${idx + 1}</span>
        </div>
      </div>
    `).join('');
  } else if (!teams.length) {
    body.innerHTML = '<div class="slot-panel-empty">No teams in this slot.</div>';
  } else if (slot.type === 'mapping') {
    const slotStart = timeToMinutes(slot.time || '00:00');
    body.innerHTML = teams.map((t, idx) => {
      const startTime = minutesToTime(slotStart + (t.startOffset ?? idx * 10));
      return `
        <div class="slot-panel-team-row">
          <div class="slot-panel-team-left">
            <span class="slot-panel-team-name">${t.teamName}</span>
          </div>
          <div class="slot-panel-team-right">
            <span class="slot-panel-status">${startTime}</span>
          </div>
        </div>
      `;
    }).join('');
  } else if (slotStatus(slot) !== 'past') {
    body.innerHTML = teams.map((t, idx) => `
      <div class="slot-panel-team-row">
        <div class="slot-panel-team-left">
          <span class="slot-panel-dot"></span>
          <span class="slot-panel-team-name">${t.teamName}</span>
        </div>
        <div class="slot-panel-team-right">
          <span class="slot-panel-status">#${idx + 1}</span>
        </div>
      </div>
    `).join('');
  } else {
    body.innerHTML = teams.map(t => {
      const run    = runs[`${slot.id}_${t.teamId}`];
      const status = run?.status || 'pending';
      const score  = run?.totalScore ?? null;

      const scorecardUrl = `${base}/scoreview?` + new URLSearchParams({
        competition: compId,
        slot:        slot.id,
        team:        t.teamId,
        teamName:    t.teamName,
        test:        slot.testId,
        back:        `${base}/competition?id=${compId}`
      });

      const statusCls  = status === 'submitted' ? 'done' : status === 'draft' ? 'active' : '';
      const statusText = status === 'submitted' ? 'Submitted' : status === 'draft' ? 'In progress' : 'Not started';

      return `
        <a href="${scorecardUrl}" class="slot-panel-team-row" target="_blank" rel="noopener">
          <div class="slot-panel-team-left">
            <span class="slot-panel-dot ${statusCls}"></span>
            <span class="slot-panel-team-name">${t.teamName}</span>
          </div>
          <div class="slot-panel-team-right">
            ${score !== null ? `<span class="slot-panel-score">${score} pts</span>` : `<span class="slot-panel-status">${statusText}</span>`}
            <span class="slot-panel-arrow">›</span>
          </div>
        </a>
      `;
    }).join('');
  }

  document.getElementById('slot-panel-backdrop').hidden = false;
  document.getElementById('slot-panel').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSlotPanel() {
  document.getElementById('slot-panel-backdrop').hidden = true;
  document.getElementById('slot-panel').hidden = true;
  document.body.style.overflow = '';
}

async function openPosterPanel(slotId, body) {
  body.innerHTML = '<div class="slot-panel-empty">Loading scores…</div>';
  document.getElementById('slot-panel-backdrop').hidden = false;
  document.getElementById('slot-panel').hidden = false;
  document.body.style.overflow = 'hidden';

  const snap = await getDocs(
    collection(db, 'competitions', compId, 'slots', slotId, 'posterScores')
  );

  if (snap.empty) {
    body.innerHTML = '<div class="slot-panel-empty">No scores submitted yet.</div>';
    return;
  }

  // Collect raw scores per presenter from all judges
  const OUTLIER_N = 2;
  const rawByPresenter = {};  // presenterTeamId → [raw scores]
  snap.docs.forEach(d => {
    const { judgeTeamId, scores = {} } = d.data();
    for (const [presenterTeamId, score] of Object.entries(scores)) {
      if (presenterTeamId === judgeTeamId) continue; // skip self
      if (!rawByPresenter[presenterTeamId]) rawByPresenter[presenterTeamId] = [];
      rawByPresenter[presenterTeamId].push(score);
    }
  });

  // Map teamId → teamName from participatingTeams
  const teamNames = {};
  (comp.participatingTeams || []).forEach(t => { teamNames[t.teamId] = t.teamName; });

  // Apply scoring formula: scale ×5, drop N highest+lowest, mean of remainder
  const ranked = Object.entries(rawByPresenter).map(([teamId, raws]) => {
    const scaled  = raws.map(s => s * 5);
    let finalScore;
    if (scaled.length <= 2 * OUTLIER_N) {
      finalScore = scaled.reduce((a, b) => a + b, 0) / scaled.length;
    } else {
      const sorted  = [...scaled].sort((a, b) => a - b);
      const trimmed = sorted.slice(OUTLIER_N, sorted.length - OUTLIER_N);
      finalScore    = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    }
    return { teamId, teamName: teamNames[teamId] || teamId, score: finalScore, count: raws.length };
  }).sort((a, b) => b.score - a.score);

  body.innerHTML = ranked.map((r, i) => `
    <div class="slot-panel-team-row">
      <div class="slot-panel-team-left">
        <span class="slot-panel-team-name">${r.teamName}</span>
      </div>
      <div class="slot-panel-team-right">
        <span class="slot-panel-score">${r.score.toFixed(1)}<span style="font-weight:400;opacity:.6;font-size:.75em"> /50</span>
          <span style="font-weight:400;opacity:.5;font-size:.8em;margin-left:4px">(${r.count} judges)</span></span>
      </div>
    </div>
  `).join('');
}

// ── LEGACY VIEW ───────────────────────────────────────────────────────────────

const LEAGUE_LABELS = {
  OPL:  'Open Platform League',
  DSPL: 'Domestic Standard Platform League',
  SSPL: 'Social Standard Platform League',
};
const LEAGUE_ORDER = ['OPL', 'DSPL', 'SSPL'];

function renderLegacy() {
  const podium = comp.podium || [];
  const teams  = comp.participatingTeams || [];
  const tz     = compTz();

  const teamNameMap = {};
  teams.forEach(t => { teamNameMap[String(t.teamId)] = t.teamName; });

  const byLeague = {};
  for (const entry of podium) {
    const league = entry.league || 'OPL';
    if (!byLeague[league]) byLeague[league] = [];
    byLeague[league].push(entry);
  }
  Object.values(byLeague).forEach(arr => arr.sort((a, b) => a.place - b.place));

  const leaguesPresent = LEAGUE_ORDER.filter(l => byLeague[l]);
  const extraLeagues   = Object.keys(byLeague).filter(l => !LEAGUE_ORDER.includes(l));
  const allLeagues     = [...leaguesPresent, ...extraLeagues];

  let podiumHTML;
  if (!podium.length) {
    podiumHTML = `<div class="comp-detail-no-results">No podium results recorded for this competition.</div>`;
  } else {
    podiumHTML = allLeagues.map(league => {
      const rows = byLeague[league].map(entry => {
        const teamName = teamNameMap[String(entry.teamId)] || entry.teamName || entry.teamId;
        const teamHref = `/team?id=${encodeURIComponent(entry.teamId)}&from=competition&compId=${encodeURIComponent(compId)}`;
        return `
          <div class="comp-detail-result-row">
            <div class="tl-medal ${medalClass(entry.place)}">${placeLabel(entry.place)}</div>
            <div class="comp-detail-result-team">
              <a href="${teamHref}" class="comp-detail-team-link">${teamName}</a>
            </div>
          </div>`;
      }).join('');
      const showTitle = allLeagues.length > 1;
      return `
        <div class="comp-detail-league">
          ${showTitle ? `<div class="comp-detail-league-title">${LEAGUE_LABELS[league] || league}</div>` : ''}
          <div class="comp-detail-results-list">${rows}</div>
        </div>`;
    }).join('');
  }

  const podiumIds = new Set(podium.map(e => String(e.teamId)));
  const nonPodium = teams.filter(t => !podiumIds.has(String(t.teamId)));

  let participantsHTML = '';
  if (nonPodium.length) {
    const items = nonPodium
      .slice().sort((a, b) => a.teamName.localeCompare(b.teamName))
      .map(t => `<div class="comp-detail-participant">
        <a href="${base}/team?id=${encodeURIComponent(t.teamId)}&from=competition&compId=${encodeURIComponent(compId)}" class="comp-detail-team-link">${t.teamName}</a>
      </div>`).join('');
    participantsHTML = `
      <div class="comp-detail-block">
        <div class="comp-detail-block-title">Participants</div>
        <div class="comp-detail-participants-grid">${items}</div>
      </div>`;
  }

  const loc   = [comp.city, comp.country].filter(Boolean).join(', ');
  const dates = formatDateRange(comp.startDate, comp.endDate, tz);

  document.getElementById('comp-legacy').innerHTML = `
    <div class="comp-detail-header">
      <div class="comp-detail-inner">
        <div class="page-tag">Competition</div>
        <div class="page-title" style="font-size:clamp(1.4rem,3vw,2.2rem);margin-bottom:0.75rem;">${comp.name}</div>
        <div class="comp-detail-meta">
          ${comp.year  ? `<div class="comp-meta-item"><div class="comp-meta-label">Year</div><div class="comp-meta-value">${comp.year}</div></div>` : ''}
          ${loc        ? `<div class="comp-meta-item"><div class="comp-meta-label">Location</div><div class="comp-meta-value">${loc}</div></div>` : ''}
          ${dates      ? `<div class="comp-meta-item"><div class="comp-meta-label">Dates</div><div class="comp-meta-value">${dates}</div></div>` : ''}
          ${teams.length ? `<div class="comp-meta-item"><div class="comp-meta-label">Teams</div><div class="comp-meta-value">${teams.length}</div></div>` : ''}
        </div>
      </div>
    </div>
    <div class="comp-detail-body">
      <div class="comp-detail-inner">
        <div class="comp-detail-block">
          <div class="comp-detail-block-title">Podium</div>
          <div class="comp-detail-leagues">${podiumHTML}</div>
        </div>
        ${participantsHTML}
      </div>
    </div>
  `;

  document.getElementById('comp-legacy').hidden = false;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function showError(msg) {
  document.getElementById('comp-loading').textContent = msg;
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  showError(`Error: ${err.message}`);
  console.error(err);
});
