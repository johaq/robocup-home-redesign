import { db, ensureAuth } from '../scoring/firebase.js';
import { getDocs, collection } from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

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

let allTeams    = [];
let teamLastYear = {};
let markers     = {};
let activeMinYear = 2022;
const CURRENT_YEAR = new Date().getFullYear();

function updateMapAndGrid(minYear) {
  activeMinYear = minYear;
  document.getElementById('slider-label').textContent =
    minYear <= 2006 ? 'All time' : `Active since ${minYear}`;

  const grid = document.getElementById('teams-grid');
  grid.innerHTML = '';

  for (const team of allTeams) {
    const lastYear = teamLastYear[team.id] || CURRENT_YEAR;
    const visible  = lastYear >= minYear;

    if (markers[team.id]) {
      if (visible) markers[team.id].addTo(map);
      else         markers[team.id].remove();
    }

    if (!visible) continue;

    const websiteLink = team.website ? `<a href="${team.website}" target="_blank" class="team-link">Website ↗</a>` : '';
    const tdpLink     = team.tdp && team.tdp !== 'Placeholder'
      ? `<a href="${team.tdp}" target="_blank" class="team-link">TDP ↗</a>` : '';

    const card = document.createElement('div');
    card.className = 'team-card';
    card.innerHTML = `
      <a href="team.html?id=${team.id}&from=teams" style="text-decoration:none;color:inherit;">
        <div class="team-name">${team.name}</div>
        <div class="team-institution">${team.institution || ''}</div>
        <div class="team-location">${[team.city, team.country].filter(Boolean).join(', ')}</div>
        <div class="team-links">${websiteLink}${tdpLink}</div>
      </a>`;
    grid.appendChild(card);
  }
}

async function load() {
  await ensureAuth();

  const [teamsSnap, compsSnap] = await Promise.all([
    getDocs(collection(db, 'teams')),
    getDocs(collection(db, 'competitions')),
  ]);

  // Compute last active year per team from competitions
  for (const d of compsSnap.docs) {
    const comp = d.data();
    const year = parseInt(comp.year) || 0;
    if (!year) continue;
    for (const t of (comp.participatingTeams || [])) {
      if (!teamLastYear[t.teamId] || year > teamLastYear[t.teamId]) teamLastYear[t.teamId] = year;
    }
    for (const p of (comp.podium || [])) {
      if (p.teamId && (!teamLastYear[p.teamId] || year > teamLastYear[p.teamId])) teamLastYear[p.teamId] = year;
    }
  }

  allTeams = teamsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => t.name)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Build slider
  const sliderWrap = document.getElementById('activity-slider-wrap');
  sliderWrap.innerHTML = `
    <div class="slider-row">
      <span class="filter-label">Show teams</span>
      <input type="range" id="activity-slider" min="2005" max="${CURRENT_YEAR}" value="2022" step="1"
        style="flex:1;margin:0 1rem;" />
      <span id="slider-label" style="font-family:var(--font-head);font-size:13px;min-width:120px;">Active since 2022</span>
    </div>`;
  document.getElementById('activity-slider').addEventListener('input', e => {
    updateMapAndGrid(parseInt(e.target.value));
  });

  // Build map markers
  for (const team of allTeams) {
    const lat = team.lat, lng = team.lng;
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) continue;

    const lastSeen    = teamLastYear[team.id] ? `Last participated: ${teamLastYear[team.id]}` : '';
    const websiteLink = team.website
      ? `<a href="${team.website}" target="_blank" style="color:#00e5a0;font-family:monospace;font-size:12px;">Website ↗</a>` : '';
    const tdpLink     = team.tdp && team.tdp !== 'Placeholder'
      ? `<a href="${team.tdp}" target="_blank" style="color:#00e5a0;font-family:monospace;font-size:12px;">TDP ↗</a>` : '';
    const profileLink = `<a href="team.html?id=${team.id}&from=teams" style="color:#00e5a0;font-family:monospace;font-size:12px;">View profile ↗</a>`;
    const links       = [websiteLink, tdpLink].filter(Boolean).join(' &nbsp;·&nbsp; ');

    const popup = `
      <div style="font-family:'DM Sans',sans-serif;min-width:180px;">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${team.name}</div>
        <div style="font-size:12px;color:#666;margin-bottom:2px;">${team.institution || ''}</div>
        <div style="font-size:12px;color:#666;margin-bottom:4px;">${[team.city, team.country].filter(Boolean).join(', ')}</div>
        ${lastSeen ? `<div style="font-size:11px;color:#999;margin-bottom:6px;">${lastSeen}</div>` : ''}
        <div style="font-size:12px;margin-bottom:4px;">${profileLink}</div>
        <div style="font-size:12px;">${links}</div>
      </div>`;

    markers[team.id] = L.marker([lat, lng], { icon: markerIcon }).bindPopup(popup);
  }

  updateMapAndGrid(2022);
}

load();
