import { db, ensureAuth } from './firebase.js';
import {
  doc, collection, getDoc, getDocs, onSnapshot, query, where
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { bestRunsPerTeamTest } from './score-utils.js';

// ── URL PARAMS ────────────────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const compId  = params.get('id');

// ── STATE ─────────────────────────────────────────────────────────────────────

let comp  = null;
let tests = [];   // [{id, name}] — loaded from Firestore
let runs  = {};   // runId → run data
let posterScoresByTeam = {};  // teamId → final score out of 50

// ── INIT ──────────────────────────────────────────────────────────────────────

const POSTER_OUTLIER_N = 2;

async function loadPosterScores() {
  const slotsSnap = await getDocs(collection(db, 'competitions', compId, 'slots'));
  const posterSlots = slotsSnap.docs.filter(d => d.data().type === 'poster');
  if (!posterSlots.length) { posterScoresByTeam = {}; return; }

  const rawByPresenter = {};
  for (const slotDoc of posterSlots) {
    const snap = await getDocs(
      collection(db, 'competitions', compId, 'slots', slotDoc.id, 'posterScores')
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

async function init() {
  await ensureAuth();

  if (!compId) { showError('No competition specified.'); return; }

  const compSnap = await getDoc(doc(db, 'competitions', compId));
  if (!compSnap.exists()) { showError('Competition not found.'); return; }
  comp = { id: compId, ...compSnap.data() };

  document.title = `Results — ${comp.name}`;
  document.getElementById('results-comp-title').textContent = comp.name;
  document.getElementById('results-back-link').href = `${window.__siteBase || ''}/competition?id=${compId}`;

  const [testsSnap] = await Promise.all([
    getDocs(collection(db, 'competitions', compId, 'tests')),
    loadPosterScores(),
  ]);
  tests = testsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  document.getElementById('results-loading').hidden = true;
  document.getElementById('results-page').hidden = false;

  // Realtime, but scoped to submitted runs — drafts are never shown here, so we don't
  // download or stream them.
  onSnapshot(
    query(collection(db, 'competitions', compId, 'runs'), where('status', '==', 'submitted')),
    snap => {
      runs = {};
      snap.docs.forEach(d => { runs[d.id] = d.data(); });
      render();
    }
  );
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
  const hasPoster = Object.keys(posterScoresByTeam).length > 0;

  if (!submitted.length && !hasPoster) {
    el.innerHTML = '<div class="results-empty">No submitted runs yet.</div>';
    return;
  }

  // Aggregate by team: best run per test, summed across tests
  const bestByTeamTest = bestRunsPerTeamTest(submitted);
  const totals = {};
  for (const run of Object.values(bestByTeamTest)) {
    const { teamId, teamName, testId, flooredScore } = run;
    if (!totals[teamId]) totals[teamId] = { teamName: teamName || teamId, total: 0, byTest: {}, posterScore: null };
    totals[teamId].total += flooredScore;
    const tName = tests.find(t => t.id === testId)?.name || testId || '—';
    totals[teamId].byTest[tName] = flooredScore;
  }

  // Fold in poster scores
  const participatingMap = {};
  (comp.participatingTeams || []).forEach(t => { participatingMap[t.teamId] = t.teamName; });
  for (const [teamId, score] of Object.entries(posterScoresByTeam)) {
    if (!totals[teamId]) totals[teamId] = { teamName: participatingMap[teamId] || teamId, total: 0, byTest: {}, posterScore: null };
    totals[teamId].posterScore = score;
    totals[teamId].total      += score;
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
          ${testNames.map(n => `<th class="col-test" title="${n}">${abbrev(n)}</th>`).join('')}
          ${hasPoster ? `<th class="col-test" title="Poster Session">Poster</th>` : ''}
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
                <a href="${(window.__siteBase || '') + '/team-scores?' + new URLSearchParams({ competition: compId, team: entry.teamId, teamName: entry.teamName })}" class="results-team-link">${entry.teamName}</a>
              </td>
              ${testNames.map(n => {
                const tid = tests.find(t => t.name === n)?.id;
                const run = tid ? bestByTeamTest[`${entry.teamId}__${tid}`] : null;
                const score = entry.byTest[n];
                if (score === undefined) return `<td class="col-test">—</td>`;
                if (!run) return `<td class="col-test">${score}</td>`;
                const url = (window.__siteBase || '') + '/scoreview?' + new URLSearchParams({ competition: compId, slot: run.slotId, team: run.teamId, teamName: run.teamName, test: run.testId, back: `${window.__siteBase || ''}/results?id=${compId}` });
                return `<td class="col-test"><a href="${url}" target="_blank" rel="noopener" class="results-score-link">${score}</a></td>`;
              }).join('')}
              ${hasPoster ? `<td class="col-test">${entry.posterScore != null ? entry.posterScore.toFixed(1) : '—'}</td>` : ''}
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
      const scoreUrl = (window.__siteBase || '') + '/scoreview?' + new URLSearchParams({
        competition: compId, slot: run.slotId, team: run.teamId,
        teamName: run.teamName, test: run.testId, back: `${window.__siteBase || ''}/results?id=${compId}`
      });
      return `
        <tr class="${i === 0 ? 'row-first' : ''}">
          <td class="col-rank">${medal}</td>
          <td class="col-team">
            <a href="${(window.__siteBase || '') + '/team-scores?' + new URLSearchParams({ competition: compId, team: run.teamId, teamName: run.teamName || run.teamId })}" class="results-team-link">${run.teamName || run.teamId}</a>
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

const TEST_ABBREVS = {
  'doing laundry':                       'DL',
  'gpsr':                                'GPSR',
  'human robot interaction challenge':   'HRI',
  'pick and place challenge':            'PnP',
};

function abbrev(name) {
  return TEST_ABBREVS[name.toLowerCase()] || name;
}

function showError(msg) {
  document.getElementById('results-loading').textContent = msg;
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  showError(`Error: ${err.message}`);
  console.error(err);
});
