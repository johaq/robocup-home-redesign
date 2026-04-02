const SHEET_ID = "1ff1rmnkY2Sg44vei5j0dZJsJzOrgXqlOVjVoW2G0H5k";
const TEAMS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Teams`;
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Results`;
const COMPETITIONS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Competitions`;

const params = new URLSearchParams(window.location.search);
const compId = params.get('id');
const fromPage = params.get('from');
const fromTeamId = params.get('teamId');

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

function teamLink(team) {
  if (!team) return "<span style='color:var(--muted)'>Unknown</span>";
  return `<a href="team.html?id=${team.team_id}&from=competition&compId=${compId}" class="comp-detail-team-link">${team.team_name}</a>`;
}

async function load() {
  // Set back link
  const bl = document.getElementById('back-link');
  if (fromPage === 'team' && fromTeamId) {
    bl.href = `team.html?id=${fromTeamId}`;
    bl.textContent = '← Back to team';
  } else {
    bl.href = 'history.html';
    bl.textContent = '← Back to history';
  }

  if (!compId) {
    document.getElementById('comp-detail-content').innerHTML = '<p style="color:var(--muted);padding:3rem;">No competition specified.</p>';
    return;
  }

  const [competitions, results, teams] = await Promise.all([
    fetchCSV(COMPETITIONS_URL),
    fetchCSV(RESULTS_URL),
    fetchCSV(TEAMS_URL),
  ]);

  const comp = competitions.find(c => c.competition_id === compId);
  if (!comp) {
    document.getElementById('comp-detail-content').innerHTML = '<p style="color:var(--muted);padding:3rem;">Competition not found.</p>';
    return;
  }

  document.title = `RoboCup@Home — ${comp.name}`;

  // Build team lookup
  const teamMap = {};
  teams.forEach(t => { if (t.team_id) teamMap[String(t.team_id).trim()] = t; });

  // Results for this competition
  const compResults = results.filter(r => r.competition_id === compId);

  // Build set of team_ids that placed top 3
  const placedTeamIds = new Set(compResults.map(r => String(r.team_id).trim()));

  // Participants from teams.participations column
  const participants = teams.filter(t => {
    const parts = (t.participations || "").split(",").map(s => s.trim());
    return parts.includes(compId);
  });

  // Participants who did NOT place (participation only)
  const participantsOnly = participants.filter(t => !placedTeamIds.has(String(t.team_id).trim()));

  // Group results by league
  const byLeague = {};
  compResults.forEach(r => {
    if (!byLeague[r.league]) byLeague[r.league] = [];
    byLeague[r.league].push(r);
  });
  Object.values(byLeague).forEach(arr => arr.sort((a, b) => parseInt(a.place) - parseInt(b.place)));

  const leaguesPresent = LEAGUE_ORDER.filter(l => byLeague[l]);

  // Results section
  let resultsHTML = "";
  if (leaguesPresent.length === 0) {
    resultsHTML = `<div class="comp-detail-no-results">No podium results recorded for this competition.</div>`;
  } else {
    resultsHTML = leaguesPresent.map(league => {
      const rows = byLeague[league].map(r => {
        const team = teamMap[String(r.team_id).trim()];
        return `
          <div class="comp-detail-result-row">
            <div class="tl-medal ${medalClass(r.place)}">${placeLabel(r.place)}</div>
            <div class="comp-detail-result-team">${teamLink(team)}</div>
          </div>`;
      }).join("");
      return `
        <div class="comp-detail-league">
          <div class="comp-detail-league-title">${LEAGUE_LABELS[league] || league}</div>
          <div class="comp-detail-results-list">${rows}</div>
        </div>`;
    }).join("");
  }

  // Participants section
  let participantsHTML = "";
  if (participantsOnly.length > 0) {
    const items = participantsOnly
      .sort((a, b) => a.team_name.localeCompare(b.team_name))
      .map(t => `<div class="comp-detail-participant">${teamLink(t)}</div>`)
      .join("");
    participantsHTML = `
      <div class="comp-detail-block">
        <div class="comp-detail-block-title">Participants</div>
        <div class="comp-detail-participants-grid">${items}</div>
      </div>`;
  } else if (participants.length === 0 && leaguesPresent.length > 0) {
    participantsHTML = `<div class="comp-detail-no-results" style="margin-top:1rem;">No full participant list recorded — showing podium results only.</div>`;
  }

  document.getElementById('comp-detail-content').innerHTML = `
    <div class="comp-detail-header">
      <div class="comp-detail-inner">
        <div class="page-tag">Competition</div>
        <div class="page-title" style="font-size:clamp(1.4rem,3vw,2.2rem);margin-bottom:0.75rem;">${comp.name}</div>
        <div class="comp-detail-meta">
          <div class="comp-meta-item">
            <div class="comp-meta-label">Year</div>
            <div class="comp-meta-value">${comp.year}</div>
          </div>
          <div class="comp-meta-item">
            <div class="comp-meta-label">Location</div>
            <div class="comp-meta-value">${comp.city}, ${comp.country}</div>
          </div>
          ${participants.length > 0 ? `<div class="comp-meta-item">
            <div class="comp-meta-label">Teams</div>
            <div class="comp-meta-value">${participants.length}</div>
          </div>` : ""}
        </div>
      </div>
    </div>

    <div class="comp-detail-body">
      <div class="comp-detail-inner">
        <div class="comp-detail-block">
          <div class="comp-detail-block-title">Podium</div>
          <div class="comp-detail-leagues">${resultsHTML}</div>
        </div>
        ${participantsHTML}
      </div>
    </div>`;
}

load();
