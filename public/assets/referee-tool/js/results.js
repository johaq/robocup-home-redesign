import { db, ensureAuth } from './firebase.js';
import {
  doc, collection, getDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

// ── URL PARAMS ────────────────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const compId  = params.get('id');

// ── STATE ─────────────────────────────────────────────────────────────────────

let comp  = null;
let tests = [];   // [{id, name}] — loaded from Firestore
let runs  = {};   // runId → run data

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await ensureAuth();

  if (!compId) { showError('No competition specified.'); return; }

  const compSnap = await getDoc(doc(db, 'competitions', compId));
  if (!compSnap.exists()) { showError('Competition not found.'); return; }
  comp = { id: compId, ...compSnap.data() };

  document.title = `Results — ${comp.name}`;
  document.getElementById('results-comp-title').textContent = comp.name;
  document.getElementById('results-back-link').href = `competition.html?id=${compId}`;

  const testsSnap = await getDocs(collection(db, 'competitions', compId, 'tests'));
  tests = testsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById('results-loading').hidden = true;
  document.getElementById('results-page').hidden = false;

  onSnapshot(collection(db, 'competitions', compId, 'runs'), snap => {
    runs = {};
    snap.docs.forEach(d => { runs[d.id] = d.data(); });
    render();
  });
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function render() {
  const submitted = Object.values(runs).filter(r => r.status === 'submitted');
  renderOverall(submitted);
  renderPerTest(submitted);
}

// ── OVERALL STANDINGS ─────────────────────────────────────────────────────────

function renderOverall(submitted) {
  const el = document.getElementById('results-overall');

  if (!submitted.length) {
    el.innerHTML = '<div class="results-empty">No submitted runs yet.</div>';
    return;
  }

  // Aggregate by team: best run per test, summed across tests
  const bestByTeamTest = {}; // `${teamId}__${testId}` → run
  for (const run of submitted) {
    const { teamId, testId, totalScore } = run;
    if (!teamId || !testId) continue;
    const key = `${teamId}__${testId}`;
    if (!bestByTeamTest[key] || (totalScore || 0) > (bestByTeamTest[key].totalScore || 0)) {
      bestByTeamTest[key] = run;
    }
  }
  const totals = {};
  for (const run of Object.values(bestByTeamTest)) {
    const { teamId, teamName, testId, totalScore } = run;
    if (!totals[teamId]) totals[teamId] = { teamName: teamName || teamId, total: 0, byTest: {} };
    totals[teamId].total += totalScore || 0;
    const tName = tests.find(t => t.id === testId)?.name || testId || '—';
    totals[teamId].byTest[tName] = totalScore || 0;
  }

  const ranked = Object.entries(totals)
    .map(([teamId, d]) => ({ teamId, ...d }))
    .sort((a, b) => b.total - a.total);

  const testNames = [...new Set(submitted.map(r => tests.find(t => t.id === r.testId)?.name || r.testId || '—'))].sort();

  el.innerHTML = `
    <table class="results-table">
      <thead>
        <tr>
          <th class="col-rank">#</th>
          <th class="col-team">Team</th>
          ${testNames.map(n => `<th class="col-test">${n}</th>`).join('')}
          <th class="col-total">Total</th>
        </tr>
      </thead>
      <tbody>
        ${ranked.map((entry, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1;
          return `
            <tr class="${i === 0 ? 'row-first' : ''}">
              <td class="col-rank">${medal}</td>
              <td class="col-team">
                <a href="team.html?id=${encodeURIComponent(entry.teamId)}" class="results-team-link">${entry.teamName}</a>
              </td>
              ${testNames.map(n => {
                const tid = tests.find(t => t.name === n)?.id;
                const run = tid ? bestByTeamTest[`${entry.teamId}__${tid}`] : null;
                const score = entry.byTest[n];
                if (score === undefined) return `<td class="col-test">—</td>`;
                if (!run) return `<td class="col-test">${score}</td>`;
                const url = 'scoreview.html?' + new URLSearchParams({ competition: compId, slot: run.slotId, team: run.teamId, teamName: run.teamName, test: run.testId, back: `results.html?id=${compId}` });
                return `<td class="col-test"><a href="${url}" target="_blank" rel="noopener" class="results-score-link">${score}</a></td>`;
              }).join('')}
              <td class="col-total">${entry.total}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ── PER-TEST BREAKDOWN ────────────────────────────────────────────────────────

function renderPerTest(submitted) {
  const container = document.getElementById('results-per-test');

  if (!submitted.length) {
    container.innerHTML = '';
    return;
  }

  // Group by testId
  const byTest = {};
  for (const run of submitted) {
    const { testId } = run;
    if (!testId) continue;
    if (!byTest[testId]) byTest[testId] = [];
    byTest[testId].push(run);
  }

  // Sort tests by their name
  const testIds = Object.keys(byTest).sort((a, b) => {
    const na = tests.find(t => t.id === a)?.name || a;
    const nb = tests.find(t => t.id === b)?.name || b;
    return na.localeCompare(nb);
  });

  container.innerHTML = testIds.map(testId => {
    const testName = tests.find(t => t.id === testId)?.name || testId;
    const testRuns = byTest[testId].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    const rows = testRuns.map((run, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1;
      const scoreUrl = 'scoreview.html?' + new URLSearchParams({
        competition: compId, slot: run.slotId, team: run.teamId,
        teamName: run.teamName, test: run.testId, back: `results.html?id=${compId}`
      });
      return `
        <tr class="${i === 0 ? 'row-first' : ''}">
          <td class="col-rank">${medal}</td>
          <td class="col-team">
            <a href="team.html?id=${encodeURIComponent(run.teamId)}" class="results-team-link">${run.teamName || run.teamId}</a>
          </td>
          <td class="col-score"><a href="${scoreUrl}" target="_blank" rel="noopener" class="results-score-link">${run.totalScore ?? 0}</a></td>
        </tr>
      `;
    }).join('');

    return `
      <section class="results-section results-test-section">
        <h2 class="results-section-title">${testName}</h2>
        <div class="results-table-wrap">
          <table class="results-table">
            <thead>
              <tr>
                <th class="col-rank">#</th>
                <th class="col-team">Team</th>
                <th class="col-score">Score</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    `;
  }).join('');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function showError(msg) {
  document.getElementById('results-loading').textContent = msg;
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  showError(`Error: ${err.message}`);
  console.error(err);
});
