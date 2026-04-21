import { db, ensureRefereeAuth } from './firebase.js';
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js";

const p             = new URLSearchParams(window.location.search);
const competitionId = p.get('competition');
const teamId        = p.get('team');
const teamName      = p.get('teamName') || 'Unknown Team';
const slotId        = p.get('slot');

// Doc refs are created inside init() to avoid module-level crash on missing params

// ── STATE ─────────────────────────────────────────────────────────────────────

const checks = { collisionAvoidance: false, loudnessOfVoice: false, appearanceCheck: false };
const texts  = { externalDevices: '', startButton: '', customContainers: '', emergencyButton: '', notes: '' };
let result   = null; // 'pass' | 'fail' | null
let saveTimer = null;
let submitted = false;
let inspRef   = null;
let runRef    = null;

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  await ensureRefereeAuth();

  if (!competitionId || !teamId) {
    document.getElementById('loading').textContent = 'Missing competition or team parameter.';
    return;
  }

  inspRef = doc(db, 'competitions', competitionId, 'inspections', teamId);
  runRef  = slotId ? doc(db, 'competitions', competitionId, 'runs', `${slotId}_${teamId}`) : null;

  document.getElementById('insp-team-name').textContent = teamName;

  if (p.get('back')) {
    document.getElementById('back-link').href = p.get('back');
  }

  // Build prev/next nav if we have a slot context
  if (slotId) {
    const slotSnap = await getDoc(doc(db, 'competitions', competitionId, 'slots', slotId));
    if (slotSnap.exists()) {
      const slotTeams = slotSnap.data().teams || [];
      const idx = slotTeams.findIndex(t => String(t.teamId) === String(teamId));
      const prev = slotTeams[idx - 1];
      const next = slotTeams[idx + 1];

      const makeNavUrl = t => {
        const np = new URLSearchParams(p);
        np.set('team', t.teamId);
        np.set('teamName', t.teamName);
        return `inspection.html?${np}`;
      };

      const navEl = document.getElementById('insp-nav');
      if (navEl) {
        if (prev) { const a = document.createElement('a'); a.className = 'sheet-nav-link'; a.href = makeNavUrl(prev); a.textContent = '← Prev'; navEl.appendChild(a); }
        const pos = document.createElement('span'); pos.className = 'sheet-nav-link'; pos.style.cursor = 'default'; pos.textContent = `${idx + 1} / ${slotTeams.length}`; navEl.appendChild(pos);
        if (next) { const a = document.createElement('a'); a.className = 'sheet-nav-link'; a.href = makeNavUrl(next); a.textContent = 'Next →'; navEl.appendChild(a); }
      }
    }
  }

  // Load existing data
  const snap = await getDoc(inspRef);
  if (snap.exists()) {
    const d = snap.data();
    Object.assign(checks, {
      collisionAvoidance: !!d.collisionAvoidance,
      loudnessOfVoice:    !!d.loudnessOfVoice,
      appearanceCheck:    !!d.appearanceCheck,
    });
    Object.assign(texts, {
      externalDevices:  d.externalDevices  || '',
      startButton:      d.startButton      || '',
      customContainers: d.customContainers || '',
      emergencyButton:  d.emergencyButton  || '',
      notes:            d.notes            || '',
    });
    result    = d.result || null;
    submitted = d.submitted || false;
  }

  renderAll();

  if (submitted) lockForm();

  document.getElementById('loading').hidden = true;
  document.getElementById('app').hidden     = false;
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function renderAll() {
  // Checkboxes
  document.querySelectorAll('.insp-check-item').forEach(el => {
    const field = el.dataset.field;
    el.classList.toggle('checked', !!checks[field]);
    el.onclick = () => {
      if (submitted) return;
      checks[field] = !checks[field];
      el.classList.toggle('checked', checks[field]);
      updateSubmitBtn();
      scheduleSave();
    };
  });

  // Text fields
  for (const [key, val] of Object.entries(texts)) {
    const el = document.getElementById(`field-${key}`);
    if (el) {
      el.value = val;
      el.oninput = () => {
        texts[key] = el.value;
        scheduleSave();
      };
    }
  }

  // Result buttons
  renderResult();
  document.getElementById('btn-pass').onclick = () => setResult('pass');
  document.getElementById('btn-fail').onclick = () => setResult('fail');
  document.getElementById('submit-btn').onclick = submitInspection;

  updateSubmitBtn();
}

function renderResult() {
  document.getElementById('btn-pass').classList.toggle('active', result === 'pass');
  document.getElementById('btn-fail').classList.toggle('active', result === 'fail');
}

function setResult(r) {
  if (submitted) return;
  result = result === r ? null : r; // toggle off if same
  renderResult();
  updateSubmitBtn();
  scheduleSave();
}

function updateSubmitBtn() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = submitted || result === null;
}

// ── SAVE ──────────────────────────────────────────────────────────────────────

function scheduleSave() {
  setSaveStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await save('draft');
    saveTimer = null;
  }, 1200);
}

async function save(status) {
  if (!inspRef) return;
  try {
    const payload = {
      teamId, teamName, competitionId, slotId,
      ...checks,
      ...Object.fromEntries(Object.entries(texts).filter(([k]) => k !== 'notes')),
      notes: texts.notes,
      result,
      submitted: status === 'submitted',
      updatedAt: serverTimestamp(),
      ...(status === 'submitted' ? { submittedAt: serverTimestamp() } : {})
    };
    await setDoc(inspRef, payload, { merge: true });
    if (runRef) {
      await setDoc(runRef, { status, teamId, teamName, slotId, updatedAt: serverTimestamp() }, { merge: true });
    }
    setSaveStatus(status === 'submitted' ? '' : 'Saved');
    if (status !== 'submitted') setTimeout(() => setSaveStatus(''), 2000);
  } catch (err) {
    setSaveStatus('Save failed');
    console.error(err);
  }
}

async function submitInspection() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  clearTimeout(saveTimer);
  await save('submitted');
  submitted = true;
  lockForm();
}

function lockForm() {
  document.getElementById('submit-btn').textContent = result === 'pass' ? 'Passed ✓' : 'Failed ✗';
  document.getElementById('submit-btn').disabled = true;
  document.querySelectorAll('.insp-check-item').forEach(el => el.classList.add('locked'));
  document.querySelectorAll('.insp-textarea').forEach(el => el.disabled = true);
  document.getElementById('btn-pass').disabled = true;
  document.getElementById('btn-fail').disabled = true;
  setSaveStatus('Inspection submitted.');
}

function setSaveStatus(msg) {
  document.getElementById('save-status').textContent = msg;
}

// ── GO ────────────────────────────────────────────────────────────────────────

init().catch(err => {
  document.getElementById('loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
