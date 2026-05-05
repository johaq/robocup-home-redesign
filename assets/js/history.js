import { db, ensureAuth } from '../scoring/firebase.js';
import {
  collection, getDocs
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

const LEAGUE_LABELS = {
  OPL:  'Open Platform League',
  DSPL: 'Domestic Standard Platform League',
  SSPL: 'Social Standard Platform League',
};

const COMP_TYPES = {
  rc: 'RoboCup World Championship',
  go: 'German Open',
  eo: 'European Open',
  po: 'Portugal Open',
  jo: 'Japan Open',
  bo: 'Brazil Open',
};

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

function compTypePrefix(id) {
  return id.replace(/[0-9]/g, '');
}

// ── STATE ─────────────────────────────────────────────────────────

let allCompetitions = [];   // [{id, name, city, country, year, ...}]
let podiumByComp   = {};    // compId → [{place, teamId, teamName}]
let teamMap        = {};    // teamId → {name, ...}
let activeCompType = 'all';

// ── RENDER ────────────────────────────────────────────────────────

function renderTimeline() {
  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';

  const filtered = allCompetitions.filter(c => {
    if (activeCompType !== 'all' && compTypePrefix(c.id) !== activeCompType) return false;
    return true;
  });

  if (!filtered.length) {
    timeline.innerHTML = '<div style="padding:2rem 0;color:var(--muted)">No competitions match the selected filters.</div>';
    return;
  }

  // Group by year
  const byYear = {};
  filtered.forEach(c => {
    const y = c.year || '?';
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(c);
  });

  Object.keys(byYear)
    .sort((a, b) => parseInt(b) - parseInt(a))
    .forEach(year => {
      const yearBlock = document.createElement('div');
      yearBlock.className = 'tl-year-block';

      const yearLabel = document.createElement('div');
      yearLabel.className = 'tl-year-label';
      yearLabel.textContent = year;
      yearBlock.appendChild(yearLabel);

      byYear[year].forEach(comp => {
        const podium = podiumByComp[comp.id] || [];

        const card = document.createElement('div');
        card.className = 'tl-card';

        const loc = [comp.city, comp.country].filter(Boolean).join(', ');
        card.innerHTML = `
          <div class="tl-card-header">
            <div class="tl-comp-name">
              <a href="competition.html?id=${comp.id}&from=history" class="tl-comp-link">${comp.name}</a>
            </div>
            ${loc ? `<div class="tl-comp-loc">${loc}</div>` : ''}
          </div>`;

        if (!podium.length) {
          card.innerHTML += `<div class="tl-no-results">No results recorded yet.</div>`;
        } else {
          // Group by league; entries without a league go under 'OPL'
          const byLeague = {};
          for (const entry of podium) {
            const league = entry.league || 'OPL';
            if (!byLeague[league]) byLeague[league] = [];
            byLeague[league].push(entry);
          }
          const leagues = Object.keys(byLeague);
          const multiLeague = leagues.length > 1;

          const leaguesHTML = leagues.map((league, i) => {
            const isLast = i === leagues.length - 1;
            const placesHTML = byLeague[league].map(entry => {
              const team = teamMap[String(entry.teamId)];
              const teamName = team?.name || entry.teamName || entry.teamId;
              const teamLink = `<a href="team.html?id=${encodeURIComponent(entry.teamId)}&from=history" class="tl-team-link">${teamName}</a>`;
              return `<div class="tl-place">
                <div class="tl-medal ${medalClass(entry.place)}">${placeLabel(entry.place)}</div>
                ${teamLink}
              </div>`;
            }).join('');
            return `<div class="tl-league${isLast ? ' tl-league-last' : ''}">
              ${multiLeague ? `<div class="tl-league-name">${LEAGUE_LABELS[league] || league}</div>` : ''}
              <div class="tl-places">${placesHTML}</div>
            </div>`;
          }).join('');

          card.innerHTML += leaguesHTML;
        }

        const dot  = document.createElement('div');
        dot.className = 'tl-dot';
        const item = document.createElement('div');
        item.className = 'tl-item';
        item.appendChild(dot);
        item.appendChild(card);
        yearBlock.appendChild(item);
      });

      timeline.appendChild(yearBlock);
    });
}

// ── COMPUTE PODIUM FROM RUNS ──────────────────────────────────────

function computePodium(runs) {
  // Best run per (team, test), summed across tests
  const bestByTeamTest = {};
  for (const run of runs) {
    if (run.status !== 'submitted') continue;
    const { teamId, teamName, testId, totalScore } = run;
    if (!teamId || !testId) continue;
    const key = `${teamId}__${testId}`;
    if (!bestByTeamTest[key] || (totalScore || 0) > bestByTeamTest[key].score) {
      bestByTeamTest[key] = { teamId, teamName: teamName || teamId, score: totalScore || 0 };
    }
  }

  const totals = {};
  for (const { teamId, teamName, score } of Object.values(bestByTeamTest)) {
    if (!totals[teamId]) totals[teamId] = { teamName, total: 0 };
    totals[teamId].total += score;
  }

  return Object.entries(totals)
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 3)
    .map(([teamId, { teamName }], i) => ({ place: i + 1, teamId, teamName }));
}

// ── LOAD ──────────────────────────────────────────────────────────

async function load() {
  await ensureAuth();

  // Load competitions and teams in parallel
  const [compsSnap, teamsSnap] = await Promise.all([
    getDocs(collection(db, 'competitions')),
    getDocs(collection(db, 'teams')),
  ]);

  teamsSnap.docs.forEach(d => { teamMap[d.id] = d.data(); });

  allCompetitions = compsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.name)
    .sort((a, b) => {
      if (a.adminCreated !== b.adminCreated) return a.adminCreated ? -1 : 1;
      return (b.year || 0) - (a.year || 0);
    });

  // Load runs for all competitions in parallel to compute podiums
  await Promise.all(allCompetitions.map(async comp => {
    // Use stored podium if available (set by admin after competition ends)
    if (comp.podium?.length) {
      podiumByComp[comp.id] = comp.podium;
      return;
    }
    // Otherwise compute from runs
    const runsSnap = await getDocs(collection(db, 'competitions', comp.id, 'runs'));
    const runs = runsSnap.docs.map(d => d.data());
    const podium = computePodium(runs);
    if (podium.length) podiumByComp[comp.id] = podium;
  }));

  // Build competition type filter
  const filtersEl = document.getElementById('history-filters');
  const prefixes  = [...new Set(allCompetitions.map(c => compTypePrefix(c.id)))].filter(Boolean);

  const compRow = document.createElement('div');
  compRow.className = 'filter-row';
  compRow.innerHTML = '<span class="filter-label">Competition</span>';

  const allBtn = document.createElement('button');
  allBtn.className = 'filter-btn filter-btn-comp active';
  allBtn.textContent = 'All';
  allBtn.onclick = () => { activeCompType = 'all'; setActive(compRow, allBtn, 'filter-btn-comp'); renderTimeline(); };
  compRow.appendChild(allBtn);

  prefixes.forEach(prefix => {
    const label = COMP_TYPES[prefix]
      ? COMP_TYPES[prefix].replace('World Championship', 'WC').replace(' Open', '')
      : prefix;
    const btn = document.createElement('button');
    btn.className = 'filter-btn filter-btn-comp';
    btn.textContent = label;
    btn.title = COMP_TYPES[prefix] || prefix;
    btn.onclick = () => { activeCompType = prefix; setActive(compRow, btn, 'filter-btn-comp'); renderTimeline(); };
    compRow.appendChild(btn);
  });

  filtersEl.appendChild(compRow);

  document.getElementById('loading')?.remove();
  renderTimeline();
}

function setActive(row, activeBtn, cls) {
  row.querySelectorAll('.' + cls).forEach(b => b.classList.remove('active'));
  activeBtn.classList.add('active');
}

load().catch(err => console.error('History load error:', err));
