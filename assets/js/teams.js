const SHEET_ID = "1ff1rmnkY2Sg44vei5j0dZJsJzOrgXqlOVjVoW2G0H5k";
const TEAMS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Teams`;
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Results`;
const COMPETITIONS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Competitions`;

function fetchCSV(url) {
  return new Promise((resolve) => {
    Papa.parse(url, { download: true, header: true, complete: (r) => resolve(r.data) });
  });
}

const map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([20, 10], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap © CARTO',
  maxZoom: 18
}).addTo(map);

const markerIcon = L.divIcon({
  className: '',
  html: `<div style="width:12px;height:12px;border-radius:50%;background:#00e5a0;border:2px solid #fff;box-shadow:0 0 6px rgba(0,229,160,0.6);"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6]
});

let allTeams = [];
let teamLastYear = {}; // team_id -> most recent competition year
let markers = {};      // team_id -> leaflet marker
let activeMinYear = 2022;
const CURRENT_YEAR = new Date().getFullYear();

function updateMapAndGrid(minYear) {
  activeMinYear = minYear;
  document.getElementById("slider-label").textContent =
    minYear <= 2006 ? "All time" : `Active since ${minYear}`;

  const grid = document.getElementById('teams-grid');
  grid.innerHTML = '';

  allTeams.forEach(team => {
    const tid = String(team.team_id).trim();
    const lastYear = teamLastYear[tid] || CURRENT_YEAR;
    const visible = lastYear >= minYear;

    if (markers[tid]) {
      if (visible) {
        markers[tid].addTo(map);
      } else {
        markers[tid].remove();
      }
    }

    // Rebuild card list — only show visible teams
    if (!visible) return;
    const websiteLink = team.website ? `<a href="${team.website}" target="_blank" class="team-link">Website ↗</a>` : '';
    const tdpLink = team.tdp && team.tdp !== 'Placeholder' ? `<a href="${team.tdp}" target="_blank" class="team-link">TDP ↗</a>` : '';

    const card = document.createElement('div');
    card.className = 'team-card';
    card.innerHTML = `
      <a href="team.html?id=${team.team_id}&from=teams" style="text-decoration:none;color:inherit;">
      <div class="team-name">${team.team_name}</div>
      <div class="team-institution">${team.institution || ''}</div>
      <div class="team-location">${[team.city, team.country].filter(Boolean).join(', ')}</div>
      <div class="team-links">${websiteLink}${tdpLink}</div>
      </a>`;
    grid.appendChild(card);
  });
}

async function load() {
  const [teams, results, competitions] = await Promise.all([
    fetchCSV(TEAMS_URL),
    fetchCSV(RESULTS_URL),
    fetchCSV(COMPETITIONS_URL),
  ]);

  // Build competition year lookup
  const compYearMap = {};
  competitions.forEach(c => { if (c.competition_id) compYearMap[c.competition_id] = parseInt(c.year) || 0; });

  // Build last active year per team
  results.forEach(r => {
    if (!r.team_id || !r.competition_id) return;
    const year = compYearMap[r.competition_id] || 0;
    const tid = String(r.team_id).trim();
    if (!teamLastYear[tid] || year > teamLastYear[tid]) {
      teamLastYear[tid] = year;
    }
  });

  allTeams = teams.filter(t => t.team_name);

  // Build slider
  const sliderWrap = document.getElementById("activity-slider-wrap");
  const minYear = 2006;
  sliderWrap.innerHTML = `
    <div class="slider-row">
      <span class="filter-label">Show teams</span>
      <input type="range" id="activity-slider" min="${minYear - 1}" max="${CURRENT_YEAR}" value="2022" step="1"
        style="flex:1;margin:0 1rem;" />
      <span id="slider-label" style="font-family:var(--font-head);font-size:13px;min-width:120px;">Active since 2022</span>
    </div>`;

  document.getElementById("activity-slider").addEventListener("input", e => {
    updateMapAndGrid(parseInt(e.target.value));
  });

  // Build map markers (all of them first, filtering happens in updateMapAndGrid)
  allTeams.forEach(team => {
    if (!team.team_id) return;
    const tid = String(team.team_id).trim();
    const lat = parseFloat(team.latitude);
    const lng = parseFloat(team.longitude);
    if (isNaN(lat) || isNaN(lng)) return;

    const websiteLink = team.website ? `<a href="${team.website}" target="_blank" style="color:#00e5a0;font-family:monospace;font-size:12px;">Website ↗</a>` : '';
    const tdpLink = team.tdp && team.tdp !== 'Placeholder' ? `<a href="${team.tdp}" target="_blank" style="color:#00e5a0;font-family:monospace;font-size:12px;">TDP ↗</a>` : '';
    const profileLink = `<a href="team.html?id=${tid}&from=teams" style="color:#00e5a0;font-family:monospace;font-size:12px;">View profile ↗</a>`;
    const lastSeen = teamLastYear[tid] ? `Last competed: ${teamLastYear[tid]}` : '';
    const links = [websiteLink, tdpLink].filter(Boolean).join(' &nbsp;·&nbsp; ');

    const popup = `
      <div style="font-family:'DM Sans',sans-serif;min-width:180px;">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${team.team_name}</div>
        <div style="font-size:12px;color:#666;margin-bottom:2px;">${team.institution || ''}</div>
        <div style="font-size:12px;color:#666;margin-bottom:4px;">${[team.city, team.country].filter(Boolean).join(', ')}</div>
        ${lastSeen ? `<div style="font-size:11px;color:#999;margin-bottom:6px;">${lastSeen}</div>` : ''}
        <div style="font-size:12px;margin-bottom:4px;">${profileLink}</div>
        <div style="font-size:12px;">${links}</div>
      </div>`;

    const marker = L.marker([lat, lng], { icon: markerIcon }).bindPopup(popup);
    markers[tid] = marker;
  });

  // Initial render with default filter (2022)
  updateMapAndGrid(2022);
}

load();