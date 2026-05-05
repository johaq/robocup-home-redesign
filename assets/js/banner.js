import { db, ensureAuth } from '../scoring/firebase.js';
import {
  getDocs, collection
} from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';

(async () => {
  try {
    await ensureAuth();
    const snap  = await getDocs(collection(db, 'competitions'));
    const today = new Intl.DateTimeFormat('sv').format(new Date()); // YYYY-MM-DD
    const live  = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .find(c => c.active && c.startDate && c.endDate
              && c.startDate <= today && today <= c.endDate);
    if (!live) return;

    const banner = document.createElement('div');
    banner.id = 'live-banner';
    banner.innerHTML = `
      <div class="live-banner-inner">
        <span class="live-banner-dot"></span>
        <span class="live-banner-label">Live now</span>
        <span id="live-banner-text">${live.name} is happening right now.</span>
        <a id="live-banner-link" href="competition.html?id=${live.id}" class="live-banner-btn">Follow live →</a>
      </div>
    `;

    const navbar = document.getElementById('navbar');
    if (navbar) navbar.after(banner);
    else document.body.prepend(banner);
  } catch (_) { /* non-critical — banner stays hidden */ }
})();
