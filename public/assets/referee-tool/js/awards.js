import { db, ensureAuth } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, getDocsFromCache, onSnapshot, query, where
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";
import { bestRunsPerTeamTest, sumItems } from './score-utils.js';

// Special-awards page. All awards SUM across every submitted run of a team (per the
// competition rules), computed from each run's stored per-item `scores` + the test def.

const params        = new URLSearchParams(window.location.search);
const competitionId = params.get('competition');

let testMap      = {};    // testId → test definition
let humanoidIds  = new Set();

// GPSR award: solved commands + interleaved bonus (partial-% already baked into itemPoints).
const GPSR_ITEMS = ['solving_the_first_command', 'solving_the_second_command', 'solving_the_third_command', 'interleaved_task_bonus'];

// Curated "manipulation" line-items per test (net of their own modifiers/penalties).
const MANIPULATION_ITEMS = {
  pick_and_place_challenge: ['picking_up_an_object_for_transportation', 'place_an_object_in_its_designated_location', 'pull_or_push_the_dishwasher_rack', 'open_or_close_the_dishwasher_door_without_assistan', 'open_milk_container_without_assistance', 'pour_cereal_or_milk_into_the_bowl_without_assistan'],
  doing_laundry:            ['picking_up_a_piece_of_clothing_from_the_basket', 'folding_a_piece_of_clothing', 'opening_the_washing_machine_door', 'removing_one_or_more_pieces_of_clothing_from_the_w', 'using_the_basket_for_transportation', 'folding_additional_clothes_per_item', 'stacking_folded_clothes_neatly_per_item'],
  restaurant:               ['picking_up_the_requested_items_from_the_kitchen_ba', 'serve_the_order_to_the_customer', 'use_an_unattached_tray_to_transport'],
  finals:                   ['moving_the_laundry_basket', 'opening_the_door_of_the_apartment', 'closing_the_dishwasher'],
  human_robot_interaction_challenge: ['receive_the_bag_from_the_guest_via_handover'],
};

async function init() {
  await ensureAuth();

  if (!competitionId) {
    await showCompPicker();
  } else {
    await showAwards(competitionId);
  }

  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden = false;
}

// ── COMPETITION PICKER ──────────────────────────────────────────────────────────

async function showCompPicker() {
  const compsRef = collection(db, 'competitions');
  document.getElementById('awards-comp-name').textContent = 'Select Competition';
  document.getElementById('awards-subtitle').textContent = '';

  const build = (docs) => {
    const comps = docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.name && c.active)
      .sort((a, b) => (b.year || 0) - (a.year || 0));
    const content = document.getElementById('awards-content');
    content.innerHTML = '';
    for (const comp of comps) {
      const el = document.createElement('div');
      el.className = 'awards-comp-item';
      el.textContent = comp.name;
      el.addEventListener('click', async () => {
        document.getElementById('loading').hidden = false;
        document.getElementById('app').hidden = true;
        await showAwards(comp.id);
        document.getElementById('loading').hidden = true;
        document.getElementById('app').hidden = false;
      });
      content.appendChild(el);
    }
  };

  try {
    const cached = await getDocsFromCache(compsRef);
    if (!cached.empty) build(cached.docs);
  } catch (_) { /* no cache */ }
  const fresh = await getDocs(compsRef);
  build(fresh.docs);
}

// ── AWARDS ──────────────────────────────────────────────────────────────────────

async function showAwards(compId) {
  const compSnap = await getDoc(doc(db, 'competitions', compId));
  const compData = compSnap.exists() ? compSnap.data() : {};
  document.getElementById('awards-comp-name').textContent = compData.name || compId;
  document.getElementById('awards-subtitle').textContent = 'Special Awards';

  humanoidIds = new Set((compData.participatingTeams || []).filter(t => t.humanoid).map(t => String(t.teamId)));

  const testsSnap = await getDocs(collection(db, 'competitions', compId, 'tests'));
  testMap = {};
  testsSnap.docs.forEach(d => { testMap[d.id] = { id: d.id, ...d.data() }; });

  // Live: recompute whenever a run is submitted/changed.
  onSnapshot(
    query(collection(db, 'competitions', compId, 'runs'), where('status', '==', 'submitted')),
    snap => {
      const runs = snap.docs.map(d => d.data());
      render(runs);
    }
  );
}

// Accumulate a per-team {teamId, teamName, value} sum, keyed by teamId.
function accumulate(map, run, value) {
  const id = String(run.teamId);
  if (!map[id]) map[id] = { teamId: id, teamName: run.teamName || id, value: 0 };
  map[id].value += value;
  return map;
}

function rank(map) {
  return Object.values(map)
    .filter(t => t.value > 0)
    .sort((a, b) => b.value - a.value);
}

function render(runs) {
  // GPSR — sum solve1/2/3 + interleaved over all gpsr runs.
  const gpsr = {};
  // Manipulation — sum curated items over ALL runs (any test that has a curated set).
  const manip = {};
  // HRI — sum hri_challenge run totals over all hri runs.
  const hri = {};

  for (const run of runs) {
    const def = testMap[run.testId];
    if (run.testId === 'gpsr' && def) {
      accumulate(gpsr, run, sumItems(def, run.scores, GPSR_ITEMS));
    }
    const manipIds = MANIPULATION_ITEMS[run.testId];
    if (manipIds && def) {
      accumulate(manip, run, sumItems(def, run.scores, manipIds));
    }
    if (run.testId === 'human_robot_interaction_challenge') {
      accumulate(hri, run, Math.max(0, run.totalScore || 0));
    }
  }

  // Humanoid — official overall standings (best run per test), restricted to flagged teams.
  const best = bestRunsPerTeamTest(runs);
  const overall = {};
  for (const r of Object.values(best)) {
    const id = String(r.teamId);
    if (!overall[id]) overall[id] = { teamId: id, teamName: r.teamName || id, value: 0 };
    overall[id].value += r.flooredScore;
  }
  const humanoid = Object.values(overall)
    .filter(t => humanoidIds.has(t.teamId) && t.value > 0)
    .sort((a, b) => b.value - a.value);

  const content = document.getElementById('awards-content');
  content.innerHTML = '';
  content.appendChild(section('Best GPSR', 'Solved commands + interleaved bonus, summed over all GPSR runs', rank(gpsr)));
  content.appendChild(section('Best Manipulation', 'Manipulation line-items summed across all tests & runs', rank(manip)));
  content.appendChild(section('Best HRI', 'HRI Challenge score, summed over all runs', rank(hri)));
  content.appendChild(section('Best Humanoid', 'Overall standings among teams flagged humanoid in /admin', humanoid,
    'No humanoid teams flagged yet — set the 🤖 flag on teams in /admin.'));
}

function section(title, subtitle, ranked, emptyMsg) {
  const el = document.createElement('div');
  el.className = 'award-section';
  const rows = ranked.length
    ? ranked.map((t, i) => `
        <div class="award-row${i === 0 ? ' winner' : ''}">
          <span class="award-rank">${i + 1}</span>
          <span class="award-team">${escHtml(t.teamName)}</span>
          <span class="award-pts">${t.value}</span>
        </div>`).join('')
    : `<div class="award-empty">${escHtml(emptyMsg || 'No scores yet.')}</div>`;
  el.innerHTML = `
    <div class="award-head">
      <div class="award-title">${escHtml(title)}</div>
      <div class="award-sub">${escHtml(subtitle)}</div>
    </div>
    <div class="award-rows">${rows}</div>
  `;
  return el;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init().catch(err => {
  document.getElementById('loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
