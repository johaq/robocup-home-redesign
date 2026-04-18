import { db, ensureAuth } from './firebase.js';
import {
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

// ── URL PARAMS ────────────────────────────────────────────────────────────────

const p             = new URLSearchParams(window.location.search);
const competitionId = p.get('competition');
const slotId        = p.get('slot');
const teamId        = p.get('team');
const teamName      = p.get('teamName') || 'Unknown Team';
const testId        = p.get('test');
const backUrl       = p.get('back') || (competitionId ? `event.html?id=${competitionId}` : 'index.html');

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await ensureAuth();

  if (!competitionId || !slotId || !teamId || !testId) {
    showError('Missing parameters.'); return;
  }

  // Load test definition
  let testDef = null;
  const testSnap = await getDoc(doc(db, 'competitions', competitionId, 'tests', testId));
  if (testSnap.exists()) {
    testDef = testSnap.data();
  } else {
    try {
      const r = await fetch(`assets/scoring/tests/${testId}.json`);
      if (!r.ok) throw new Error();
      testDef = await r.json();
    } catch (_) {
      showError('Test definition not found.'); return;
    }
  }

  // Load run
  const runId  = `${slotId}_${teamId}`;
  const runSnap = await getDoc(doc(db, 'competitions', competitionId, 'runs', runId));
  const scores  = runSnap.exists() ? (runSnap.data().scores || {}) : {};
  const notes   = runSnap.exists() ? (runSnap.data().notes  || '') : '';
  const total   = runSnap.exists() ? (runSnap.data().totalScore ?? calcTotal(testDef, scores)) : 0;

  // Populate header
  document.getElementById('back-link').href    = backUrl;
  document.getElementById('test-name').textContent = testDef.name || testId;
  document.getElementById('team-name').textContent = teamName;
  document.getElementById('total-score').textContent = total;
  document.title = `${testDef.name} — ${teamName}`;

  // Render sections
  const body = document.getElementById('view-body');
  for (const section of testDef.sections) {
    const sec = document.createElement('div');
    sec.className = 'view-section';

    const heading = document.createElement('div');
    heading.className = 'view-section-heading';
    heading.textContent = section.heading;
    sec.appendChild(heading);

    for (const item of section.items) {
      const el = renderItem(item, scores);
      if (el) sec.appendChild(el);
    }
    body.appendChild(sec);
  }

  // Notes
  if (notes) {
    document.getElementById('notes-text').textContent = notes;
    document.getElementById('notes-section').hidden = false;
  }

  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
}

// ── ITEM RENDERERS ────────────────────────────────────────────────────────────

function renderItem(item, scores) {
  switch (item.type) {
    case 'boolean':            return renderBoolean(item, scores);
    case 'count':              return renderCount(item, scores);
    case 'standalone_penalty': return renderStandalonePenalty(item, scores);
    case 'info':               return renderInfo(item);
    default:                   return null;
  }
}

function renderBoolean(item, scores) {
  const achieved = !!scores[item.id];
  const pts      = itemPts(item, scores);

  const el = document.createElement('div');
  el.className = 'view-item' + (achieved ? ' achieved' : ' not-achieved');

  el.innerHTML = `
    <div class="view-item-row">
      <div class="view-check ${achieved ? 'checked' : ''}">
        ${achieved ? '<svg width="14" height="11" viewBox="0 0 14 11" fill="none"><path d="M1 5l4 4 8-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
      </div>
      <span class="view-item-label">${item.label}</span>
      <span class="view-item-pts ${achieved ? '' : 'pts-zero'}">${achieved ? '+' + pts : '+0'}</span>
    </div>
  `;

  // Show applied penalties / modifiers if achieved
  if (achieved) {
    const panels = [];

    for (const pen of (item.penalties || [])) {
      if (pen.type === 'fixed' && scores[pen.id]) {
        panels.push(`<div class="view-sub-row penalty-applied">
          <span class="view-sub-label">− ${pen.label}</span>
          <span class="view-sub-pts penalty-pts">−${pen.points}</span>
        </div>`);
      } else if (pen.type === 'percentage' && scores[pen.id]) {
        const pct = scores[pen.id];
        const deduction = Math.round(pct / 100 * item.points);
        panels.push(`<div class="view-sub-row penalty-applied">
          <span class="view-sub-label">− ${pen.label} (${pct}%)</span>
          <span class="view-sub-pts penalty-pts">−${deduction}</span>
        </div>`);
      }
    }

    for (const mod of (item.modifiers || [])) {
      if (scores[mod.id]) {
        panels.push(`<div class="view-sub-row modifier-applied">
          <span class="view-sub-label">+ ${mod.label}</span>
          <span class="view-sub-pts modifier-pts">+${mod.points}</span>
        </div>`);
      }
    }

    if (panels.length) {
      const panel = document.createElement('div');
      panel.className = 'view-sub-panel';
      panel.innerHTML = panels.join('');
      el.appendChild(panel);
    }
  }

  return el;
}

function renderCount(item, scores) {
  const v   = scores[item.id];
  const pts = itemPts(item, scores);

  // Array form (with per-instance penalties)
  if (Array.isArray(v) && v.length > 0) {
    const el = document.createElement('div');
    el.className = 'view-item achieved';

    const instances = v.map((inst, i) => {
      const instPts = instancePts(item, inst);
      const pens = (item.penalties || [])
        .filter(pen => pen.type === 'fixed' ? inst[pen.id] : inst[pen.id])
        .map(pen => {
          if (pen.type === 'fixed') return `−${pen.points} ${pen.label}`;
          if (pen.type === 'percentage') return `−${Math.round(inst[pen.id] / 100 * item.points)} ${pen.label}`;
          return '';
        }).filter(Boolean);

      return `<div class="view-instance">
        <span class="view-instance-num">#${i + 1}</span>
        <span class="view-instance-pts">${instPts} pts${pens.length ? ' · ' + pens.join(', ') : ''}</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="view-item-row">
        <span class="view-count-badge">${v.length}</span>
        <span class="view-item-label">${item.label}</span>
        <span class="view-item-pts">+${pts}</span>
      </div>
      <div class="view-instances">${instances}</div>
    `;
    return el;
  }

  // Simple numeric form
  const count = typeof v === 'number' ? v : 0;
  if (count === 0) {
    const el = document.createElement('div');
    el.className = 'view-item not-achieved';
    el.innerHTML = `
      <div class="view-item-row">
        <span class="view-count-badge zero">0</span>
        <span class="view-item-label">${item.label}</span>
        <span class="view-item-pts pts-zero">+0</span>
      </div>
    `;
    return el;
  }

  const el = document.createElement('div');
  el.className = 'view-item achieved';
  el.innerHTML = `
    <div class="view-item-row">
      <span class="view-count-badge">${count}</span>
      <span class="view-item-label">${item.label}</span>
      <span class="view-item-pts">+${pts}</span>
    </div>
    <div class="view-item-sub">${count} × ${item.points} pts</div>
  `;
  return el;
}

function renderStandalonePenalty(item, scores) {
  const count = scores[item.id] || 0;
  if (count === 0) return null; // don't show unapplied penalties

  const el = document.createElement('div');
  el.className = 'view-item penalty-item';
  el.innerHTML = `
    <div class="view-item-row">
      <span class="view-count-badge penalty-badge">${count}</span>
      <span class="view-item-label">${item.label}</span>
      <span class="view-item-pts penalty-pts">−${count * item.points}</span>
    </div>
  `;
  return el;
}

function renderInfo(item) {
  const el = document.createElement('div');
  el.className = 'view-info';
  el.textContent = item.label;
  return el;
}

// ── SCORE CALCULATION (mirrors scoresheet.js) ─────────────────────────────────

function instancePts(item, inst) {
  let pts = item.points;
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'fixed'      && inst[pen.id]) pts -= pen.points;
    if (pen.type === 'percentage' && inst[pen.id]) pts -= Math.round(inst[pen.id] / 100 * item.points);
  }
  for (const mod of (item.modifiers || [])) {
    if (mod.type === 'boolean' && inst[mod.id]) pts += mod.points;
    if (mod.type === 'count')                   pts += (inst[mod.id] || 0) * mod.points;
  }
  return pts;
}

function itemPts(item, scores) {
  if (item.type === 'boolean') {
    if (!scores[item.id]) return 0;
    let pts = item.points;
    for (const pen of (item.penalties || [])) {
      if (pen.type === 'fixed'      && scores[pen.id]) pts -= pen.points;
      if (pen.type === 'percentage' && scores[pen.id]) pts -= Math.round(scores[pen.id] / 100 * item.points);
    }
    for (const mod of (item.modifiers || [])) {
      if (mod.type === 'boolean' && scores[mod.id]) pts += mod.points;
      if (mod.type === 'count')                     pts += (scores[mod.id] || 0) * mod.points;
    }
    return pts;
  }
  if (item.type === 'count') {
    const v = scores[item.id];
    if (!v) return 0;
    if (Array.isArray(v)) return v.reduce((s, inst) => s + instancePts(item, inst), 0);
    return v * item.points;
  }
  if (item.type === 'standalone_penalty') {
    return -((scores[item.id] || 0) * item.points);
  }
  return 0;
}

function calcTotal(testDef, scores) {
  return testDef.sections.flatMap(s => s.items).reduce((sum, item) => sum + itemPts(item, scores), 0);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function showError(msg) {
  document.getElementById('loading').textContent = msg;
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  showError(`Error: ${err.message}`);
  console.error(err);
});
