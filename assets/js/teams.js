const TEAMS_URL = "https://docs.google.com/spreadsheets/d/1ff1rmnkY2Sg44vei5j0dZJsJzOrgXqlOVjVoW2G0H5k/gviz/tq?tqx=out:csv&sheet=Teams";

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

Papa.parse(TEAMS_URL, {
  download: true,
  header: true,
  complete: function(results) {
    const grid = document.getElementById('teams-grid');
    grid.innerHTML = '';

    results.data.forEach(team => {
      if (!team.team_name) return;

      // Map pin
      const lat = parseFloat(team.latitude);
      const lng = parseFloat(team.longitude);
      if (!isNaN(lat) && !isNaN(lng)) {
        const websiteLink = team.website ? `<a href="${team.website}" target="_blank" style="color:#00e5a0;font-family:monospace;font-size:12px;">Website ↗</a>` : '';
        const tdpLink = team.tdp && team.tdp !== 'Placeholder' ? `<a href="${team.tdp}" target="_blank" style="color:#00e5a0;font-family:monospace;font-size:12px;">TDP ↗</a>` : '';
        const links = [websiteLink, tdpLink].filter(Boolean).join(' &nbsp;·&nbsp; ');
        const profileLink = `<a href="team.html?id=${team.team_id}" style="color:#00e5a0;font-family:monospace;font-size:12px;">View profile ↗</a>`;        const popup = `
          <div style="font-family:'DM Sans',sans-serif;min-width:180px;">
            <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${team.team_name}</div>
            <div style="font-size:12px;color:#666;margin-bottom:2px;">${team.institution}</div>
            <div style="font-size:12px;color:#666;margin-bottom:8px;">${team.city}, ${team.country}</div>
            <div style="font-size:12px;">${profileLink}</div>
            <div style="font-size:12px;">${links}</div>
          </div>`;
        L.marker([lat, lng], { icon: markerIcon }).addTo(map).bindPopup(popup);
      }

      // Team card
      const websiteLink = team.website ? `<a href="${team.website}" target="_blank" class="team-link">Website ↗</a>` : '';
      const tdpLink = team.tdp && team.tdp !== 'Placeholder' ? `<a href="${team.tdp}" target="_blank" class="team-link">TDP ↗</a>` : '';

      const card = document.createElement('div');
      card.className = 'team-card';
      card.innerHTML = `
        <a href="team.html?id=${team.team_id}" style="text-decoration:none;color:inherit;">
        <div class="team-name">${team.team_name}</div>
        <div class="team-institution">${team.institution}</div>
        <div class="team-location">${team.city}, ${team.country}</div>
        <div class="team-links">${websiteLink}${tdpLink}</div>`;
      grid.appendChild(card);
    });
  }
});

