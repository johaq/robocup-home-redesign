// Shared pure utilities used by both the public competition page
// (assets/js/competition.js) and the referee competition view
// (assets/referee-tool/competition.js).

export function todayInZone(tz) {
  return new Intl.DateTimeFormat('sv', { timeZone: tz }).format(new Date());
}

export function nowTimeInZone(tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date()).replace('.', ':');
}

export function utcOffsetLabel(tz) {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: tz, timeZoneName: 'shortOffset'
    }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
  } catch (_) { return ''; }
}

export function formatDateRange(startDate, endDate, tz) {
  if (!startDate) return '';
  const opts = { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' };
  const s = new Date(startDate + 'T12:00:00').toLocaleDateString('en-GB', opts);
  if (!endDate || endDate === startDate) return s;
  const e = new Date(endDate + 'T12:00:00').toLocaleDateString('en-GB', opts);
  return `${s} – ${e}`;
}

export function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function schedDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
