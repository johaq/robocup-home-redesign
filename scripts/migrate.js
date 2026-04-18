#!/usr/bin/env node
// One-time migration: Google Sheets → Firestore
// Usage:
//   1. Download service account key from Firebase Console → Project Settings → Service Accounts
//   2. Save it as scripts/service-account.json
//   3. cd scripts && npm install && npm run migrate

import admin from 'firebase-admin';
import Papa from 'papaparse';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SA_PATH   = join(__dirname, 'service-account.json');

if (!existsSync(SA_PATH)) {
  console.error('Missing scripts/service-account.json');
  console.error('Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(SA_PATH, 'utf8')))
});
const db = admin.firestore();

const SHEET_ID = '1ff1rmnkY2Sg44vei5j0dZJsJzOrgXqlOVjVoW2G0H5k';

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function fetchSheet(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch sheet "${name}": ${res.status}`);
  const { data, errors } = Papa.parse(await res.text(), { header: true, skipEmptyLines: true });
  if (errors.length) console.warn(`  Parse warnings for "${name}":`, errors.slice(0, 3));
  return data;
}

async function batchWrite(label, entries) {
  if (!entries.length) { console.log(`  ${label}: nothing to write`); return; }
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = db.batch();
    for (const { ref, data } of entries.slice(i, i + CHUNK)) {
      batch.set(ref, data);
    }
    await batch.commit();
  }
  console.log(`  ✓ ${entries.length} ${label}`);
}

const splitList = str =>
  str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];

// ── TEAMS ─────────────────────────────────────────────────────────────────────

async function migrateTeams(rows) {
  console.log('\nMigrating teams…');
  const entries = rows.flatMap(row => {
    const id = String(row.team_id ?? '').trim();
    if (!id) return [];
    return [{
      ref: db.collection('teams').doc(id),
      data: {
        id,
        name:        row.team_name?.trim()     || '',
        institution: row.institution?.trim()   || '',
        country:     row.country?.trim()       || '',
        city:        row.city?.trim()          || '',
        lat:         parseFloat(row.latitude)  || null,
        lng:         parseFloat(row.longitude) || null,
        website:     row.website?.trim()       || '',
        tdp:         row.tdp?.trim()           || '',
        video:       row.video?.trim()         || '',
        contact:     row.contact?.trim()       || '',
        altNames:    splitList(row.alt_names),
        parentTeams: splitList(row.parent_teams),
      }
    }];
  });
  await batchWrite('teams', entries);
}

// ── COMPETITIONS ──────────────────────────────────────────────────────────────

async function migrateCompetitions(rows) {
  console.log('\nMigrating competitions…');
  const entries = rows.flatMap(row => {
    const id = String(row.competition_id ?? '').trim();
    if (!id) return [];
    return [{
      ref: db.collection('competitions').doc(id),
      data: {
        id,
        name:    row.name?.trim()    || '',
        year:    parseInt(row.year)  || null,
        city:    row.city?.trim()    || '',
        country: row.country?.trim() || '',
      }
    }];
  });
  await batchWrite('competitions', entries);
}

// ── PARTICIPATIONS ────────────────────────────────────────────────────────────
// Merges two sources:
//   Results tab  → team placed top-3, has league + place
//   Teams.participations column → team participated, no place info
//
// Document ID: {teamId}_{competitionId} — safe to re-run (idempotent)
// Note: participations-only records have league: null (not stored in sheet)

async function migrateParticipations(teamRows, resultRows) {
  console.log('\nMigrating participations…');
  const entries = new Map();

  // Results first (have league + place)
  for (const row of resultRows) {
    const teamId = String(row.team_id ?? '').trim();
    const compId = String(row.competition_id ?? '').trim();
    if (!teamId || !compId) continue;

    const key = `${teamId}_${compId}`;
    entries.set(key, {
      ref:  db.collection('participations').doc(key),
      data: {
        teamId,
        competitionId: compId,
        league: row.league?.trim() || null,
        place:  parseInt(row.place) || null,
      }
    });
  }

  // Participations column — add any not already covered by a result
  for (const row of teamRows) {
    const teamId = String(row.team_id ?? '').trim();
    if (!teamId) continue;

    for (const compId of splitList(row.participations)) {
      const key = `${teamId}_${compId}`;
      if (!entries.has(key)) {
        entries.set(key, {
          ref:  db.collection('participations').doc(key),
          data: { teamId, competitionId: compId, league: null, place: null }
        });
      }
    }
  }

  await batchWrite('participation records', [...entries.values()]);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching sheets…');
  const [teamRows, compRows, resultRows] = await Promise.all([
    fetchSheet('Teams'),
    fetchSheet('Competitions'),
    fetchSheet('Results'),
  ]);
  console.log(`  Teams: ${teamRows.length} rows, Competitions: ${compRows.length} rows, Results: ${resultRows.length} rows`);

  await migrateTeams(teamRows);
  await migrateCompetitions(compRows);
  await migrateParticipations(teamRows, resultRows);

  console.log('\n✓ Migration complete');
}

main().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
