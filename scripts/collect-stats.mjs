// Collect scoring statistics and embed into the stats HTML page.
// Usage: ADMIN_EMAIL=x ADMIN_PASS=y node collect-stats.mjs
// Outputs: scripts/stats.json  +  public/stats.html (updated in place)

import { initializeApp } from '/home/johannes/robocup/robocup-home-redesign/node_modules/firebase/app/dist/index.cjs.js';
import { getFirestore, collection, doc, getDoc, getDocs, query, where }
  from '/home/johannes/robocup/robocup-home-redesign/node_modules/firebase/firestore/dist/index.cjs.js';
import { getAuth, signInWithEmailAndPassword }
  from '/home/johannes/robocup/robocup-home-redesign/node_modules/firebase/auth/dist/index.cjs.js';

const COMP_ID = 'rc2026';
const EXCLUDE_TESTS = new Set(['finals']);

// Teams that did not pass inspection — exclude all their runs
const EXCLUDE_TEAMS = ['runsweep', 'listex', 'wrighteagle'];
const excludedTeam = name => EXCLUDE_TEAMS.some(t => name?.toLowerCase().includes(t));

const app = initializeApp({
  apiKey: 'AIzaSyDGeFlm93CEj4ZZBckdSY41t1lq4gw2Sss',
  authDomain: 'robocup-home.firebaseapp.com',
  projectId: 'robocup-home',
});
const db   = getFirestore(app);
const auth = getAuth(app);
await signInWithEmailAndPassword(auth, process.env.ADMIN_EMAIL, process.env.ADMIN_PASS);

// ── Fetch competition ────────────────────────────────────────────────────────
const compSnap = await getDoc(doc(db, 'competitions', COMP_ID));
const compData = compSnap.data();
const totalTeams = (compData.participatingTeams || []).length;

// ── Fetch test definitions ───────────────────────────────────────────────────
const testsSnap = await getDocs(collection(db, 'competitions', COMP_ID, 'tests'));
const testDefs = {};
testsSnap.docs.forEach(d => {
  if (!EXCLUDE_TESTS.has(d.id)) testDefs[d.id] = { id: d.id, ...d.data() };
});

// ── Fetch slots (for dates) ──────────────────────────────────────────────────
const slotsSnap = await getDocs(collection(db, 'competitions', COMP_ID, 'slots'));
const slotDates = {};
slotsSnap.docs.forEach(d => {
  const s = d.data();
  if (s.date) slotDates[d.id] = s.date;
});

// ── Fetch all submitted runs ─────────────────────────────────────────────────
const runsSnap = await getDocs(
  query(collection(db, 'competitions', COMP_ID, 'runs'), where('status', '==', 'submitted'))
);
const allRuns = runsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

// ── Build per-test run lists ─────────────────────────────────────────────────
const runsByTest = {};
for (const run of allRuns) {
  const tid = run.testId;
  if (!tid || EXCLUDE_TESTS.has(tid) || !testDefs[tid]) continue;
  if (!runsByTest[tid]) runsByTest[tid] = [];
  if (excludedTeam(run.teamName)) continue;
  runsByTest[tid].push({
    runId:      run.id,
    teamId:     String(run.teamId),
    teamName:   run.teamName || String(run.teamId),
    date:       slotDates[run.slotId] || null,
    totalScore: Math.max(0, run.totalScore ?? 0),
    scores:     run.scores || {},
  });
}

// ── Helper: compute item stats ───────────────────────────────────────────────
function itemStats(item, runs) {
  let timesScored = 0;
  const teams = new Set();
  let totalCount = 0;

  for (const run of runs) {
    const v = run.scores[item.id];
    let scored = false;

    if (item.type === 'boolean') {
      scored = !!v;
    } else if (item.type === 'count') {
      if (Array.isArray(v)) {
        if (v.length > 0) { scored = true; totalCount += v.length; }
      } else if (v && v > 0) {
        scored = true; totalCount += v;
      }
    } else if (item.type === 'standalone_penalty') {
      const n = Array.isArray(v) ? v.length : (v ?? 0);
      if (n > 0) { scored = true; totalCount += n; }
    }

    if (scored) {
      timesScored++;
      teams.add(run.teamId);
    }
  }
  return { timesScored, uniqueTeams: teams.size, totalCount };
}

// ── Stats for a penalty sub-item ─────────────────────────────────────────────
function penaltyStats(pen, runs, parentId) {
  let timesScored = 0;
  const teams = new Set();
  let totalCount = 0;

  for (const run of runs) {
    const parentVal = run.scores[parentId];
    if (Array.isArray(parentVal)) {
      let instanceCount = 0;
      for (const inst of parentVal) {
        const iv = inst[pen.id];
        if (pen.type === 'fixed' && iv) instanceCount++;
        else if (pen.type === 'percentage' && iv) instanceCount++;
        else if (pen.type === 'count') instanceCount += (iv ?? 0);
      }
      if (instanceCount > 0) {
        timesScored++;
        teams.add(run.teamId);
        totalCount += instanceCount;
      }
    } else {
      const v = run.scores[pen.id];
      if (pen.type === 'fixed' && v) { timesScored++; teams.add(run.teamId); }
      else if (pen.type === 'percentage' && v) { timesScored++; teams.add(run.teamId); totalCount += v; }
      else if (pen.type === 'count') {
        const n = Array.isArray(v) ? v.length : (v ?? 0);
        if (n > 0) { timesScored++; teams.add(run.teamId); totalCount += n; }
      }
    }
  }
  return { timesScored, uniqueTeams: teams.size, totalCount };
}

// ── Best run per team ─────────────────────────────────────────────────────────
function bestRuns(runs) {
  const best = {};
  for (const run of runs) {
    const k = run.teamId;
    if (!best[k] || run.totalScore > best[k].totalScore) best[k] = run;
  }
  return Object.values(best);
}

// ── Progression: group by date ───────────────────────────────────────────────
function progression(runs, items) {
  const byDate = {};
  for (const run of runs) {
    if (!run.date) continue;
    if (!byDate[run.date]) byDate[run.date] = [];
    byDate[run.date].push(run);
  }
  const dates = Object.keys(byDate).sort();
  return dates.map(date => {
    const dayRuns = byDate[date];
    const avgScore = dayRuns.reduce((s, r) => s + r.totalScore, 0) / dayRuns.length;
    const itemRates = {};
    for (const item of items) {
      const { timesScored } = itemStats(item, dayRuns);
      itemRates[item.id] = dayRuns.length > 0 ? timesScored / dayRuns.length : 0;
    }
    return { date, runCount: dayRuns.length, avgScore, itemRates };
  });
}

// ── Assemble output ──────────────────────────────────────────────────────────
const tests = [];

for (const [testId, def] of Object.entries(testDefs)) {
  const allTestRuns  = runsByTest[testId] || [];
  const bestTestRuns = bestRuns(allTestRuns);
  const sections = [];

  for (const section of (def.sections || [])) {
    const rewards   = [];
    const penalties = [];

    for (const item of (section.items || [])) {
      if (item.type === 'info') continue;

      const allStats  = itemStats(item, allTestRuns);
      const bestStats = itemStats(item, bestTestRuns);

      const entry = {
        id: item.id, label: item.label, type: item.type,
        points: item.points ?? 0, maxCount: item.maxCount ?? null,
        all:  { ...allStats,  totalRuns: allTestRuns.length },
        best: { ...bestStats, totalRuns: bestTestRuns.length },
        penalties: [],
      };

      for (const pen of (item.penalties || [])) {
        if (pen.type === 'info') continue;
        const allP  = penaltyStats(pen, allTestRuns, item.id);
        const bestP = penaltyStats(pen, bestTestRuns, item.id);
        entry.penalties.push({
          id: pen.id, label: pen.label, type: pen.type, points: pen.points ?? 0,
          all:  { ...allP,  totalRuns: allTestRuns.length },
          best: { ...bestP, totalRuns: bestTestRuns.length },
        });
      }

      if (item.type === 'standalone_penalty') {
        penalties.push(entry);
      } else {
        rewards.push(entry);
      }
    }

    if (rewards.length || penalties.length) {
      sections.push({ id: section.id, heading: section.heading || section.id, rewards, penalties });
    }
  }

  const allFlatItems = (def.sections || []).flatMap(s =>
    (s.items || []).filter(i => i.type !== 'info' && i.type !== 'standalone_penalty')
  );

  tests.push({
    id: testId, name: def.name || testId,
    totalRuns:  allTestRuns.length,
    totalTeams: bestTestRuns.length,
    avgScore:   allTestRuns.length ? allTestRuns.reduce((s, r) => s + r.totalScore, 0) / allTestRuns.length : 0,
    maxScore:   allTestRuns.length ? Math.max(...allTestRuns.map(r => r.totalScore)) : 0,
    minScore:   allTestRuns.length ? Math.min(...allTestRuns.map(r => r.totalScore)) : 0,
    sections,
    progression: progression(allTestRuns, allFlatItems),
  });
}

tests.sort((a, b) => a.name.localeCompare(b.name));

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const statsJson = JSON.stringify({
  competition: { id: COMP_ID, name: compData.name || COMP_ID, totalTeams },
  generatedAt: new Date().toISOString(),
  tests,
}, null, 2);

// Write stats.json
const jsonPath = resolve(__dirname, 'stats.json');
writeFileSync(jsonPath, statsJson);
console.error(`Wrote ${jsonPath}`);

// Update public/stats.html in place
const htmlPath = resolve(__dirname, '../public/stats.html');
const html = readFileSync(htmlPath, 'utf8');
const updated = html.replace(/const DATA = \{[\s\S]*?\};/, `const DATA = ${statsJson};`);
writeFileSync(htmlPath, updated);
console.error(`Updated ${htmlPath}`);

process.exit(0);
