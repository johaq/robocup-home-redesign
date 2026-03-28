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

async function load() {
  const [competitions, results, teams] = await Promise.all([
    fetchCSV(COMPETITIONS_URL),
    fetchCSV(RESULTS_URL),
    fetchCSV(TEAMS_URL),
  ]);

  // Build team lookup by id
  const teamMap = {};
  teams.forEach(t => { if (t.team_id) teamMap[t.team_id] = t; });

  // Group results by competition_id
  const resultsByComp = {};
  results.forEach(r => {
    if (!r.competition_id) return;
    if (!resultsByComp[r.competition_id]) resultsByComp[r.competition_id] = [];
    resultsByComp[r.competition_id].push(r);
  });

  // Sort competitions newest first
  const sorted = competitions
    .filter(c => c.competition_id)
    .sort((a, b) => parseInt(b.year) - parseInt(a.year));

  // Group competitions by year for the year labels
  const byYear = {};
  sorted.forEach(c => {
    if (!byYear[c.year]) byYear[c.year] = [];
    byYear[c.year].push(c);
  });

  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";

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

        // Group results by league, sorted by place
        const byLeague = {};
        compResults.forEach(r => {
          if (!byLeague[r.league]) byLeague[r.league] = [];
          byLeague[r.league].push(r);
        });
        Object.keys(byLeague).forEach(league => {
          byLeague[league].sort((a, b) => parseInt(a.place) - parseInt(b.place));
        });

        // Only include leagues that have results
        const leaguesPresent = LEAGUE_ORDER.filter(l => byLeague[l] && byLeague[l].length > 0);

        const card = document.createElement("div");
        card.className = "tl-card";

        // Card header
        card.innerHTML = `
          <div class="tl-card-header">
            <div class="tl-comp-name">${comp.name}</div>
            <div class="tl-comp-loc">${comp.city}, ${comp.country}</div>
          </div>`;

        // League rows
        if (leaguesPresent.length === 0) {
          card.innerHTML += `<div class="tl-no-results">No results recorded for this competition.</div>`;
        } else {
          leaguesPresent.forEach((league, i) => {
            const isLast = i === leaguesPresent.length - 1;
            const placements = byLeague[league].slice(0, 3);

            const placesHTML = placements.map(r => {
              const team = teamMap[r.team_id];
              const teamName = team ? team.team_name : r.team_id;
              const teamLink = team
                ? `<a href="team.html?id=${r.team_id}" class="tl-team-link">${teamName}</a>`
                : `<span class="tl-team-name">${teamName}</span>`;
              return `
                <div class="tl-place">
                  <div class="tl-medal ${medalClass(r.place)}">${placeLabel(r.place)}</div>
                  ${teamLink}
                </div>`;
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

load();
