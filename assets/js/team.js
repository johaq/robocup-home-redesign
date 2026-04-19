const SHEET_ID = "1ff1rmnkY2Sg44vei5j0dZJsJzOrgXqlOVjVoW2G0H5k";
const TEAMS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Teams`;
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Results`;
const COMPETITIONS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Competitions`;

const params = new URLSearchParams(window.location.search);
const teamId = params.get('id');
const fromPage = params.get('from');

const BACK_LINKS = {
  history:     { href: 'history.html', label: '← Back to history' },
  teams:       { href: 'teams.html',   label: '← Back to all teams' },
  competition: { href: `competition.html?id=${params.get('compId')}`, label: '← Back to competition' },
  event:       { href: `event.html?id=${params.get('compId')}`, label: '← Back to competition' },
};
const backLink = BACK_LINKS[fromPage] || BACK_LINKS.teams;

function fetchCSV(url) {
  return new Promise((resolve) => {
    Papa.parse(url, { download: true, header: true, complete: (r) => resolve(r.data) });
  });
}

const LEAGUE_LABELS = {
  OPL:  "Open Platform League",
  DSPL: "Domestic Standard Platform League",
  SSPL: "Social Standard Platform League",
};
const LEAGUE_ORDER = ["OPL", "DSPL", "SSPL"];

function medalClass(place) {
  const n = parseInt(place);
  if (n === 1) return "m-gold";
  if (n === 2) return "m-silver";
  if (n === 3) return "m-bronze";
  return "m-other";
}
function placeLabel(place) {
  const n = parseInt(place);
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

let allTeamResults = [];   // results rows for this team
let allParticipations = []; // competition_ids from participations column
let compMap = {};
let activeLeague = "all";

function compLink(compId, label) {
  return `<a href="competition.html?id=${compId}&from=team&teamId=${teamId}" class="tl-comp-link">${label}</a>`;
}

function renderTeamTimeline() {
  const container = document.getElementById("team-timeline");

  // Build set of comp_ids where this team has a result
  const resultCompIds = new Set(allTeamResults.map(r => r.competition_id));

  // Participation-only entries: participated but NOT in results
  const participationOnlyIds = allParticipations.filter(cid => !resultCompIds.has(cid));

  // Apply league filter to results
  const filteredResults = activeLeague === "all"
    ? allTeamResults
    : allTeamResults.filter(r => r.league === activeLeague);

  // When league filter is active, also show participation-only comps
  // (they have no league, so always show them unless "all" hides them — keep them visible)
  const showParticipationOnly = activeLeague === "all";

  // Gather all competition IDs to show
  const allCompIds = new Set([
    ...filteredResults.map(r => r.competition_id),
    ...(showParticipationOnly ? participationOnlyIds : []),
  ]);

  if (allCompIds.size === 0) {
    container.innerHTML = `<div class="no-results">No history recorded yet.</div>`;
    return;
  }

  // Group by year
  const byYear = {};
  allCompIds.forEach(compId => {
    const comp = compMap[compId] || {};
    const year = comp.year || "Unknown";
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(compId);
  });

  container.innerHTML = Object.keys(byYear)
    .sort((a, b) => parseInt(b) - parseInt(a))
    .map(year => {
      const compsHTML = byYear[year]
        .sort((a, b) => {
          // Sort by comp name within year
          const na = (compMap[a] || {}).name || a;
          const nb = (compMap[b] || {}).name || b;
          return na.localeCompare(nb);
        })
        .map(compId => {
          const comp = compMap[compId] || {};
          const compName = comp.name || compId;
          const location = comp.city && comp.country ? `${comp.city}, ${comp.country}` : "";
          const hasResult = resultCompIds.has(compId);

          let bodyHTML = "";
          if (hasResult) {
            // Show results grouped by league
            const compResults = filteredResults.filter(r => r.competition_id === compId);
            const byLeague = {};
            compResults.forEach(r => { byLeague[r.league] = r; });

            const leagueRows = LEAGUE_ORDER
              .filter(l => byLeague[l])
              .map((l, i, arr) => {
                const r = byLeague[l];
                const isLast = i === arr.length - 1;
                return `
                  <div class="tl-league${isLast ? " tl-league-last" : ""}">
                    <div class="tl-league-name">${LEAGUE_LABELS[l] || l}</div>
                    <div class="tl-places">
                      <div class="tl-place">
                        <div class="tl-medal ${medalClass(r.place)}">${placeLabel(r.place)}</div>
                      </div>
                    </div>
                  </div>`;
              }).join("");
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
                  ${location ? `<div class="tl-comp-loc">${location}</div>` : ""}
                </div>
                ${bodyHTML}
              </div>
            </div>`;
        }).join("");

      return `
        <div class="tl-year-block">
          <div class="tl-year-label">${year}</div>
          ${compsHTML}
        </div>`;
    }).join("");
}

function setLeague(league, btn) {
  activeLeague = league;
  document.querySelectorAll(".filter-btn-league").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderTeamTimeline();
}

async function load() {
  const bl = document.getElementById('back-link');
  if (bl) { bl.href = backLink.href; bl.textContent = backLink.label; }

  if (!teamId) {
    document.getElementById('team-content').innerHTML = '<p style="color:var(--muted);">No team specified.</p>';
    return;
  }

  const [teams, results, competitions] = await Promise.all([
    fetchCSV(TEAMS_URL),
    fetchCSV(RESULTS_URL),
    fetchCSV(COMPETITIONS_URL)
  ]);

  const team = teams.find(t => String(t.team_id).trim() === String(teamId).trim());
  if (!team) {
    document.getElementById('team-content').innerHTML = '<p style="color:var(--muted);">Team not found.</p>';
    return;
  }

  document.title = `RoboCup@Home — ${team.team_name}`;

  competitions.forEach(c => { if (c.competition_id) compMap[c.competition_id] = c; });

  allTeamResults = results
    .filter(r => String(r.team_id).trim() === String(teamId).trim())
    .sort((a, b) => {
      const ya = parseInt((compMap[a.competition_id] || {}).year || 0);
      const yb = parseInt((compMap[b.competition_id] || {}).year || 0);
      return yb - ya;
    });

  // Parse participations column
  allParticipations = (team.participations || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // Build links
  const links = [];
  if (team.website) links.push(`<a href="${team.website}" target="_blank" class="team-link-btn primary">Website ↗</a>`);
  if (team.tdp && team.tdp !== 'Placeholder') links.push(`<a href="${team.tdp}" target="_blank" class="team-link-btn">Team Description Paper ↗</a>`);
  if (team.video) links.push(`<a href="${team.video}" target="_blank" class="team-link-btn">Video ↗</a>`);

  const altNames = team.alt_names ? `<div class="team-meta-item"><span class="team-meta-label">Also known as</span><span class="team-meta-value">${team.alt_names}</span></div>` : "";

  // Build league filter (only for leagues with results)
  const usedLeagues = [...new Set(allTeamResults.map(r => r.league))];
  let leagueFilterHTML = "";
  if (usedLeagues.length > 1) {
    const btns = [`<button class="filter-btn filter-btn-league active" onclick="setLeague('all', this)">All</button>`];
    usedLeagues.forEach(l => {
      btns.push(`<button class="filter-btn filter-btn-league" onclick="setLeague('${l}', this)" title="${LEAGUE_LABELS[l] || l}">${l}</button>`);
    });
    leagueFilterHTML = `<div class="filter-row" style="margin-bottom:1.5rem;"><span class="filter-label">League</span>${btns.join("")}</div>`;
  }

  const hasAnyHistory = allTeamResults.length > 0 || allParticipations.length > 0;
  const historySection = hasAnyHistory
    ? `${leagueFilterHTML}<div class="timeline" id="team-timeline"></div>`
    : `<div class="no-results">No competition history recorded yet.</div>`;

  document.getElementById('team-content').innerHTML = `
    <div class="team-header">
      <div class="team-tag">Team Profile</div>
      <div class="team-name">${team.team_name}</div>
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
        ${altNames}
        ${team.contact ? `<div class="team-meta-item"><span class="team-meta-label">Contact</span><span class="team-meta-value">${team.contact}</span></div>` : ""}
      </div>
      <div class="team-links">${links.join('')}</div>
    </div>
    <div class="section">
      <div class="section-label">Track Record</div>
      <div class="section-title">Competition history</div>
      ${historySection}
    </div>`;

  if (hasAnyHistory) renderTeamTimeline();
}

load();
