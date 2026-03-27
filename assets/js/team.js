const SHEET_ID = "1ff1rmnkY2Sg44vei5j0dZJsJzOrgXqlOVjVoW2G0H5k";
const TEAMS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Teams`;
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Results`;
const COMPETITIONS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Competitions`;

const params = new URLSearchParams(window.location.search);
const teamId = params.get('id');

function fetchCSV(url) {
  return new Promise((resolve) => {
    Papa.parse(url, { download: true, header: true, complete: (r) => resolve(r.data) });
  });
}

function placeBadge(place) {
  const n = parseInt(place);
  const cls = n === 1 ? 'place-1' : n === 2 ? 'place-2' : n === 3 ? 'place-3' : 'place-other';
  const label = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  return `<span class="place-badge ${cls}">${label}</span>`;
}

async function load() {
  if (!teamId) {
    document.getElementById('team-content').innerHTML = '<p style="color:var(--muted);">No team specified.</p>';
    return;
  }

  const [teams, results, competitions] = await Promise.all([
    fetchCSV(TEAMS_URL),
    fetchCSV(RESULTS_URL),
    fetchCSV(COMPETITIONS_URL)
  ]);

  const team = teams.find(t => t.team_id === teamId);
  if (!team) {
    document.getElementById('team-content').innerHTML = '<p style="color:var(--muted);">Team not found.</p>';
    return;
  }

  document.title = `RoboCup@Home — ${team.team_name}`;

  // Build competition lookup
  const compMap = {};
  competitions.forEach(c => { compMap[c.competition_id] = c; });

  // Get this team's results
  const teamResults = results.filter(r => r.team_id === teamId);

  // Build results table rows
  let resultsHTML = '';
  if (teamResults.length === 0) {
    resultsHTML = `<div class="no-results">No competition results recorded yet.</div>`;
  } else {
    const rows = teamResults.map(r => {
      const comp = compMap[r.competition_id] || {};
      const compName = comp.name || r.competition_id;
      const location = comp.city && comp.country ? `${comp.city}, ${comp.country}` : '—';
      const year = comp.year || '—';
      return `<tr>
        <td>${year}</td>
        <td>${compName}</td>
        <td>${location}</td>
        <td>${r.league}</td>
        <td>${placeBadge(r.place)}</td>
      </tr>`;
    }).join('');

    resultsHTML = `
      <table class="results-table">
        <thead>
          <tr>
            <th>Year</th>
            <th>Competition</th>
            <th>Location</th>
            <th>League</th>
            <th>Place</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // Build links
  const links = [];
  if (team.website) links.push(`<a href="${team.website}" target="_blank" class="team-link-btn primary">Website ↗</a>`);
  if (team.tdp && team.tdp !== 'Placeholder') links.push(`<a href="${team.tdp}" target="_blank" class="team-link-btn">Team Description Paper ↗</a>`);
  if (team.video) links.push(`<a href="${team.video}" target="_blank" class="team-link-btn">Video ↗</a>`);

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
        ${team.contact ? `<div class="team-meta-item">
          <span class="team-meta-label">Contact</span>
          <span class="team-meta-value">${team.contact}</span>
        </div>` : ''}
      </div>
      <div class="team-links">${links.join('')}</div>
    </div>

    <div class="section">
      <div class="section-label">Track Record</div>
      <div class="section-title">Competition history</div>
      ${resultsHTML}
    </div>`;
}

load();

