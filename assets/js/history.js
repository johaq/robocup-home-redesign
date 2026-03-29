const SHEET_ID = "1ff1rmnkY2Sg44vei5j0dZJsJzOrgXqlOVjVoW2G0H5k";
const RESULTS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Results`;
const COMPETITIONS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Competitions`;
const TEAMS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Teams`;

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

// Global state
let allCompetitions = [];
let resultsByComp = {};
let teamMap = {};
let activeLeague = "all";
let activeCompType = "all";

const COMP_TYPES = {
  rc: "RoboCup World Championship",
  go: "German Open",
  eo: "European Open",
  po: "Portugal Open",
  jo: "Japan Open",
  bo: "Brazil Open",
};

function getCompType(competition_id) {
  const prefix = competition_id.replace(/[0-9]/g, "");
  return COMP_TYPES[prefix] || "Other";
}

function renderTimeline() {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";

  // Filter competitions
  let filtered = allCompetitions.filter(c => {
    if (activeCompType !== "all") {
      const prefix = c.competition_id.replace(/[0-9]/g, "");
      if (prefix !== activeCompType) return false;
    }
    // If league filter active, only show competitions that have results for that league
    if (activeLeague !== "all") {
      const compResults = resultsByComp[c.competition_id] || [];
      if (!compResults.some(r => r.league === activeLeague)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    timeline.innerHTML = `<div class="tl-no-results" style="padding:2rem 0;">No competitions match the selected filters.</div>`;
    return;
  }

  // Group by year
  const byYear = {};
  filtered.forEach(c => {
    if (!byYear[c.year]) byYear[c.year] = [];
    byYear[c.year].push(c);
  });

  Object.keys(byYear)
    .sort((a, b) => parseInt(b) - parseInt(a))
    .forEach(year => {
      const yearBlock = document.createElement("div");
      yearBlock.className = "tl-year-block";

      const yearLabel = document.createElement("div");
      yearLabel.className = "tl-year-label";
      yearLabel.textContent = year;
      yearBlock.appendChild(yearLabel);

      byYear[year].forEach(comp => {
        const compResults = resultsByComp[comp.competition_id] || [];

        // Group results by league
        const byLeague = {};
        compResults.forEach(r => {
          if (!byLeague[r.league]) byLeague[r.league] = [];
          byLeague[r.league].push(r);
        });
        Object.keys(byLeague).forEach(league => {
          byLeague[league].sort((a, b) => parseInt(a.place) - parseInt(b.place));
        });

        // Apply league filter
        const leaguesPresent = LEAGUE_ORDER.filter(l => {
          if (activeLeague !== "all" && l !== activeLeague) return false;
          return byLeague[l] && byLeague[l].length > 0;
        });

        const card = document.createElement("div");
        card.className = "tl-card";
        card.innerHTML = `
          <div class="tl-card-header">
            <div class="tl-comp-name">${comp.name}</div>
            <div class="tl-comp-loc">${comp.city}, ${comp.country}</div>
          </div>`;

        if (leaguesPresent.length === 0) {
          card.innerHTML += `<div class="tl-no-results">No results recorded for this competition.</div>`;
        } else {
          leaguesPresent.forEach((league, i) => {
            const isLast = i === leaguesPresent.length - 1;
            const placements = byLeague[league].slice(0, 3);
            const placesHTML = placements.map(r => {
              const team = teamMap[String(r.team_id).trim()];
              const teamName = team ? team.team_name : r.team_id;
              const teamLink = team
                ? `<a href="team.html?id=${r.team_id}&from=history" class="tl-team-link">${teamName}</a>`
                : `<span class="tl-team-name">${teamName}</span>`;
              return `<div class="tl-place"><div class="tl-medal ${medalClass(r.place)}">${placeLabel(r.place)}</div>${teamLink}</div>`;
            }).join("");

            card.innerHTML += `
              <div class="tl-league${isLast ? " tl-league-last" : ""}">
                <div class="tl-league-name">${LEAGUE_LABELS[league] || league}</div>
                <div class="tl-places">${placesHTML}</div>
              </div>`;
          });
        }

        const dot = document.createElement("div");
        dot.className = "tl-dot";
        const item = document.createElement("div");
        item.className = "tl-item";
        item.appendChild(dot);
        item.appendChild(card);
        yearBlock.appendChild(item);
      });

      timeline.appendChild(yearBlock);
    });
}

function setLeague(league, btn) {
  activeLeague = league;
  document.querySelectorAll(".filter-btn-league").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderTimeline();
}

function setCompType(type, btn) {
  activeCompType = type;
  document.querySelectorAll(".filter-btn-comp").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderTimeline();
}

async function load() {
  const [competitions, results, teams] = await Promise.all([
    fetchCSV(COMPETITIONS_URL),
    fetchCSV(RESULTS_URL),
    fetchCSV(TEAMS_URL),
  ]);

  teams.forEach(t => { if (t.team_id) teamMap[String(t.team_id).trim()] = t; });
  results.forEach(r => {
    if (!r.competition_id) return;
    if (!resultsByComp[r.competition_id]) resultsByComp[r.competition_id] = [];
    resultsByComp[r.competition_id].push(r);
  });

  allCompetitions = competitions
    .filter(c => c.competition_id)
    .sort((a, b) => parseInt(b.year) - parseInt(a.year));

  // Build filter UI
  const filtersEl = document.getElementById("history-filters");

  // Competition type filters
  const compTypes = [...new Set(allCompetitions.map(c => c.competition_id.replace(/[0-9]/g, "")))];
  const compRow = document.createElement("div");
  compRow.className = "filter-row";
  compRow.innerHTML = `<span class="filter-label">Competition</span>`;

  const allCompBtn = document.createElement("button");
  allCompBtn.className = "filter-btn filter-btn-comp active";
  allCompBtn.textContent = "All";
  allCompBtn.onclick = () => setCompType("all", allCompBtn);
  compRow.appendChild(allCompBtn);

  compTypes.forEach(prefix => {
    const label = Object.keys(COMP_TYPES).includes(prefix) ? COMP_TYPES[prefix].replace(" Championship", "").replace("World", "") : prefix;
    const btn = document.createElement("button");
    btn.className = "filter-btn filter-btn-comp";
    btn.textContent = label;
    btn.onclick = () => setCompType(prefix, btn);
    compRow.appendChild(btn);
  });

  // League filters
  const leagueRow = document.createElement("div");
  leagueRow.className = "filter-row";
  leagueRow.innerHTML = `<span class="filter-label">League</span>`;

  const allLeagueBtn = document.createElement("button");
  allLeagueBtn.className = "filter-btn filter-btn-league active";
  allLeagueBtn.textContent = "All";
  allLeagueBtn.onclick = () => setLeague("all", allLeagueBtn);
  leagueRow.appendChild(allLeagueBtn);

  Object.entries(LEAGUE_LABELS).forEach(([key, label]) => {
    const btn = document.createElement("button");
    btn.className = "filter-btn filter-btn-league";
    btn.textContent = key;
    btn.title = label;
    btn.onclick = () => setLeague(key, btn);
    leagueRow.appendChild(btn);
  });

  filtersEl.appendChild(compRow);
  filtersEl.appendChild(leagueRow);

  renderTimeline();
}

load();