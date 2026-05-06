import { db, ensureAuth } from '../referee-tool/js/firebase.js';
import { getDoc, getDocs, doc, collection } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

const params   = new URLSearchParams(window.location.search);
const teamId   = params.get('id');
const fromPage = params.get('from');

const BACK_LINKS = {
  history:     { href: 'history.html',                                                          label: '← Back to history' },
  teams:       { href: 'teams.html',                                                            label: '← Back to all teams' },
  competition: { href: `competition.html?id=${params.get('compId')}`,                           label: '← Back to competition' },
  event:       { href: `competition.html?id=${params.get('compId')}`,                           label: '← Back to competition' },
};
const backLink = BACK_LINKS[fromPage] || BACK_LINKS.teams;

const LEAGUE_LABELS = {
  OPL:  'Open Platform League',
  DSPL: 'Domestic Standard Platform League',
  SSPL: 'Social Standard Platform League',
};
const LEAGUE_ORDER = ['OPL', 'DSPL', 'SSPL'];

function medalClass(place) {
  const n = parseInt(place);
  if (n === 1) return 'm-gold';
  if (n === 2) return 'm-silver';
  if (n === 3) return 'm-bronze';
  return 'm-other';
}
function placeLabel(place) {
  const n = parseInt(place);
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

let allTeamResults  = [];
let allParticipations = [];
let compMap         = {};
let activeLeague    = 'all';

function compLink(compId, label) {
  return `<a href="competition.html?id=${compId}&from=team&teamId=${teamId}" class="tl-comp-link">${label}</a>`;
}

function renderTeamTimeline() {
  const container = document.getElementById('team-timeline');

  const resultCompIds      = new Set(allTeamResults.map(r => r.competition_id));
  const participationOnlyIds = allParticipations.filter(cid => !resultCompIds.has(cid));

  const filteredResults = activeLeague === 'all'
    ? allTeamResults
    : allTeamResults.filter(r => r.league === activeLeague);

  const showParticipationOnly = activeLeague === 'all';

  const allCompIds = new Set([
    ...filteredResults.map(r => r.competition_id),
    ...(showParticipationOnly ? participationOnlyIds : []),
  ]);

  if (allCompIds.size === 0) {
    container.innerHTML = `<div class="no-results">No history recorded yet.</div>`;
    return;
  }

  const byYear = {};
  for (const compId of allCompIds) {
    const year = compMap[compId]?.year || 'Unknown';
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(compId);
  }

  container.innerHTML = Object.keys(byYear)
    .sort((a, b) => parseInt(b) - parseInt(a))
    .map(year => {
      const compsHTML = byYear[year]
        .sort((a, b) => ((compMap[a]?.name || a).localeCompare(compMap[b]?.name || b)))
        .map(compId => {
          const comp     = compMap[compId] || {};
          const compName = comp.name || compId;
          const location = comp.city && comp.country ? `${comp.city}, ${comp.country}` : '';
          const hasResult = resultCompIds.has(compId);

          let bodyHTML = '';
          if (hasResult) {
            const compResults = filteredResults.filter(r => r.competition_id === compId);
            const byLeague = {};
            compResults.forEach(r => { byLeague[r.league] = r; });

            const leagueRows = LEAGUE_ORDER
              .filter(l => byLeague[l])
              .map((l, i, arr) => {
                const r = byLeague[l];
                return `
                  <div class="tl-league${i === arr.length - 1 ? ' tl-league-last' : ''}">
                    <div class="tl-league-name">${LEAGUE_LABELS[l] || l}</div>
                    <div class="tl-places">
                      <div class="tl-place">
                        <div class="tl-medal ${medalClass(r.place)}">${placeLabel(r.place)}</div>
                      </div>
                    </div>
                  </div>`;
              }).join('');
            bodyHTML = leagueRows || `<div class="tl-participated">Participated</div>`;
          } else {
            bodyHTML = `<div class="tl-participated">Participated</div>`;
          }

          return `
            <div class="tl-item">
              <div class="tl-dot"></div>
              <div class="tl-card">
                <div class="tl-card-header">
                  <div class="tl-comp-name">${compLink(compId, compName)}</div>
                  ${location ? `<div class="tl-comp-loc">${location}</div>` : ''}
                </div>
                ${bodyHTML}
              </div>
            </div>`;
        }).join('');

      return `
        <div class="tl-year-block">
          <div class="tl-year-label">${year}</div>
          ${compsHTML}
        </div>`;
    }).join('');
}

async function load() {
  const bl = document.getElementById('back-link');
  if (bl) { bl.href = backLink.href; bl.textContent = backLink.label; }

  if (!teamId) {
    document.getElementById('team-content').innerHTML = '<p style="color:var(--muted);">No team specified.</p>';
    return;
  }

  await ensureAuth();

  const [teamSnap, compsSnap] = await Promise.all([
    getDoc(doc(db, 'teams', teamId)),
    getDocs(collection(db, 'competitions')),
  ]);

  if (!teamSnap.exists()) {
    document.getElementById('team-content').innerHTML = '<p style="color:var(--muted);">Team not found.</p>';
    return;
  }

  const team = { id: teamSnap.id, ...teamSnap.data() };
  document.title = `RoboCup@Home — ${team.name}`;

  // Build compMap and derive team history from competitions
  for (const d of compsSnap.docs) {
    compMap[d.id] = { id: d.id, ...d.data() };
  }

  const participatingCompIds = new Set();

  for (const comp of Object.values(compMap)) {
    const inParticipants = (comp.participatingTeams || []).some(t => t.teamId === teamId);
    const podiumEntries  = (comp.podium || []).filter(p => p.teamId === teamId);

    if (inParticipants || podiumEntries.length > 0) {
      participatingCompIds.add(comp.id);
      for (const entry of podiumEntries) {
        allTeamResults.push({ competition_id: comp.id, league: entry.league, place: entry.place });
      }
    }
  }

  allTeamResults.sort((a, b) => {
    const ya = parseInt(compMap[a.competition_id]?.year || 0);
    const yb = parseInt(compMap[b.competition_id]?.year || 0);
    return yb - ya;
  });

  allParticipations = [...participatingCompIds];

  // Build links
  const links = [];
  if (team.website) links.push(`<a href="${team.website}" target="_blank" class="team-link-btn primary">Website ↗</a>`);
  if (team.tdp && team.tdp !== 'Placeholder') links.push(`<a href="${team.tdp}" target="_blank" class="team-link-btn">Team Description Paper ↗</a>`);
  if (team.video) links.push(`<a href="${team.video}" target="_blank" class="team-link-btn">Video ↗</a>`);

  const altNamesStr  = Array.isArray(team.altNames) ? team.altNames.join(', ') : (team.altNames || '');
  const altNamesHTML = altNamesStr
    ? `<div class="team-meta-item"><span class="team-meta-label">Also known as</span><span class="team-meta-value">${altNamesStr}</span></div>` : '';

  // League filter (only when results span multiple leagues)
  const usedLeagues = [...new Set(allTeamResults.map(r => r.league))];
  let leagueFilterHTML = '';
  if (usedLeagues.length > 1) {
    const btns = usedLeagues.map(l =>
      `<button class="filter-btn filter-btn-league" data-league="${l}" title="${LEAGUE_LABELS[l] || l}">${l}</button>`
    );
    leagueFilterHTML = `
      <div class="filter-row" style="margin-bottom:1.5rem;">
        <span class="filter-label">League</span>
        <button class="filter-btn filter-btn-league active" data-league="all">All</button>
        ${btns.join('')}
      </div>`;
  }

  const hasAnyHistory = allTeamResults.length > 0 || allParticipations.length > 0;
  const historySection = hasAnyHistory
    ? `${leagueFilterHTML}<div class="timeline" id="team-timeline"></div>`
    : `<div class="no-results">No competition history recorded yet.</div>`;

  document.getElementById('team-content').innerHTML = `
    <div class="team-header">
      <div class="team-tag">Team Profile</div>
      <div class="team-name">${team.name}</div>
      <div class="team-meta">
        <div class="team-meta-item">
          <span class="team-meta-label">Institution</span>
          <span class="team-meta-value">${team.institution || '—'}</span>
        </div>
        <div class="team-meta-item">
          <span class="team-meta-label">City</span>
          <span class="team-meta-value">${team.city || '—'}</span>
        </div>
        <div class="team-meta-item">
          <span class="team-meta-label">Country</span>
          <span class="team-meta-value">${team.country || '—'}</span>
        </div>
        ${altNamesHTML}
        ${team.contact ? `<div class="team-meta-item"><span class="team-meta-label">Contact</span><span class="team-meta-value">${team.contact}</span></div>` : ''}
      </div>
      <div class="team-links">${links.join('')}</div>
    </div>
    <div class="section">
      <div class="section-label">Track Record</div>
      <div class="section-title">Competition history</div>
      ${historySection}
    </div>`;

  // Wire up league filter buttons (no inline onclick needed)
  document.querySelectorAll('.filter-btn-league').forEach(btn => {
    btn.addEventListener('click', () => {
      activeLeague = btn.dataset.league;
      document.querySelectorAll('.filter-btn-league').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTeamTimeline();
    });
  });

  if (hasAnyHistory) renderTeamTimeline();
}

load();
