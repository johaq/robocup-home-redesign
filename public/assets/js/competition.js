import { db, ensureAuth } from '../referee-tool/js/firebase.js';
import {
  doc, collection, getDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import {
  todayInZone, nowTimeInZone, utcOffsetLabel, formatDateRange,
  timeToMinutes, minutesToTime, schedDate
} from '../referee-tool/js/comp-utils.js';

const params   = new URLSearchParams(window.location.search);
const compId   = params.get('id');
const fromPage = params.get('from');

// ── BACK LINK ─────────────────────────────────────────────────────────────────

const backLink = document.getElementById('back-link');
if (fromPage === 'team') {
  const teamId = params.get('teamId');
  if (teamId) {
    backLink.href        = `team.html?id=${encodeURIComponent(teamId)}`;
    backLink.textContent = '← Back to team';
  }
} else {
  backLink.href        = 'history.html';
  backLink.textContent = '← Back to history';
}

// ── SCHEDULE GRID CONSTANTS (must match admin.js / scoring/competition.js) ────

const SCHED = { CELL_H: 40, TIME_W: 56, COL_W: 180, HEADER_H: 48 };

// ── STATE ─────────────────────────────────────────────────────────────────────

let comp  = null;
let slots = {};
let runs  = {};
let tests = [];

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
  if (type === 'inspection') return 'Robot Inspection';
  if (type === 'poster')     return 'Poster Session';
  if (type === 'other')      return slot.label || 'Other Event';
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

  if (comp.active) {
    // Live competition: real-time listeners + live/upnext boxes
    document.getElementById('comp-top-grid').style.gridTemplateColumns = '1fr 340px';
    document.getElementById('comp-live-col').hidden = false;

    onSnapshot(collection(db, 'competitions', compId, 'slots'), snap => {
      slots = {};
      snap.docs.forEach(d => { slots[d.id] = { id: d.id, ...d.data() }; });
      renderSchedule();
      renderLiveBox();
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
    // Past competition: one-time fetch, no live boxes
    const [slotsSnap, runsSnap] = await Promise.all([
      getDocs(collection(db, 'competitions', compId, 'slots')),
      getDocs(collection(db, 'competitions', compId, 'runs')),
    ]);
    slotsSnap.docs.forEach(d => { slots[d.id] = { id: d.id, ...d.data() }; });
    runsSnap.docs.forEach(d => { runs[d.id] = d.data(); });
    renderLeaderboard();
    renderSchedule();
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
        `<a href="team.html?id=${encodeURIComponent(t.teamId)}&from=competition&compId=${compId}" class="comp-team-chip">${t.teamName}</a>`
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
  document.getElementById('comp-live-link').href = `display.html?competition=${compId}`;
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

// ── LEADERBOARD ───────────────────────────────────────────────────────────────

function renderLeaderboard() {
  const section = document.getElementById('comp-leaderboard-section');
  const el      = document.getElementById('comp-leaderboard');

  const submittedRuns = Object.values(runs).filter(r => r.status === 'submitted');
  if (!submittedRuns.length) { section.hidden = true; return; }

  const bestByTeamTest = {};
  for (const run of submittedRuns) {
    const { teamId, teamName, testId, totalScore } = run;
    if (!teamId || !testId) continue;
    const key = `${teamId}__${testId}`;
    if (!bestByTeamTest[key] || (totalScore || 0) > bestByTeamTest[key].score) {
      bestByTeamTest[key] = { teamId, teamName: teamName || teamId, score: totalScore || 0 };
    }
  }

  const totals = {};
  for (const { teamId, teamName, score } of Object.values(bestByTeamTest)) {
    if (!totals[teamId]) totals[teamId] = { teamName, total: 0, runCount: 0 };
    totals[teamId].total    += score;
    totals[teamId].runCount += 1;
  }

  const ranked = Object.entries(totals)
    .map(([teamId, d]) => ({ teamId, ...d }))
    .sort((a, b) => b.total - a.total);

  section.hidden = false;
  document.getElementById('comp-results-link').href = `results.html?id=${compId}`;

  const topScore = ranked[0]?.total || 1;
  el.innerHTML = ranked.map((entry, i) => {
    const pct      = Math.max(0, Math.round((entry.total / topScore) * 100));
    const medal    = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
    const runLabel = entry.runCount === 1 ? '1 run' : `${entry.runCount} runs`;
    return `
      <div class="comp-lb-row">
        <div class="comp-lb-rank">${medal || (i + 1)}</div>
        <div class="comp-lb-team">
          <a href="team.html?id=${encodeURIComponent(entry.teamId)}&from=competition&compId=${compId}" class="comp-lb-team-name">${entry.teamName}</a>
          <div class="comp-lb-bar-wrap">
            <div class="comp-lb-bar" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="comp-lb-score">
          <span class="comp-lb-total">${entry.total}</span>
          <span class="comp-lb-runs">${runLabel}</span>
        </div>
      </div>
    `;
  }).join('');
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
    const status = slotStatus(slot);
    const isTest = (slot.type || 'test') === 'test';
    el.classList.toggle('slot-active',    status === 'active');
    el.classList.toggle('slot-done',      status === 'past');
    el.classList.toggle('slot-clickable', status === 'past' && isTest);
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
    if (type === 'test' && teamCount) metaParts.push(teamCount + ' team' + (teamCount !== 1 ? 's' : ''));
    if (slot.referee) metaParts.push(slot.referee);
    block.innerHTML = `
      <div class="comp-sched-slot-name">${displayName}</div>
      <div class="comp-sched-slot-meta">${metaParts.join(' · ')}</div>
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
  if (!teams.length) {
    body.innerHTML = '<div class="slot-panel-empty">No teams in this slot.</div>';
  } else {
    body.innerHTML = teams.map(t => {
      const run    = runs[`${slot.id}_${t.teamId}`];
      const status = run?.status || 'pending';
      const score  = run?.totalScore ?? null;

      const scorecardUrl = 'scoreview.html?' + new URLSearchParams({
        competition: compId,
        slot:        slot.id,
        team:        t.teamId,
        teamName:    t.teamName,
        test:        slot.testId,
        back:        `competition.html?id=${compId}`
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
        const teamHref = `team.html?id=${encodeURIComponent(entry.teamId)}&from=competition&compId=${encodeURIComponent(compId)}`;
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
        <a href="team.html?id=${encodeURIComponent(t.teamId)}&from=competition&compId=${encodeURIComponent(compId)}" class="comp-detail-team-link">${t.teamName}</a>
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
