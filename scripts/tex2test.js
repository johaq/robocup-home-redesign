#!/usr/bin/env node
/**
 * tex2test.js
 * Converts RoboCup@Home scoresheet .tex files to JSON test definitions.
 *
 * Usage:
 *   node tex2test.js <input-dir>  [output-dir]
 *   node tex2test.js <input.tex>  [output.json]
 *
 * Recognised macros (all pts values must be positive):
 *   \begin{scorelist}[timelimit=N]
 *   \scoreheading{Text}
 *   \scoreitem[N]{pts}{Label}       — boolean (no N) or count (with N)
 *   \scoremod[N]{pts}{Label}        — bonus modifier on previous \scoreitem
 *   \scorepen[N]{pts}{Label}        — fixed penalty on previous \scoreitem
 *   \scorepenpcent{Label}           — percentage-input penalty on previous \scoreitem
 *   \penaltyitem[N]{pts}{Label}     — standalone penalty counter
 *   \infoitem{Text}                 — non-scoring info line
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ── HELPERS ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 50);
}

/** Ensure id is unique within the set; append _2, _3 … if needed. */
function uniqueId(base, seen) {
  let id = base;
  let n  = 2;
  while (seen.has(id)) id = `${base}_${n++}`;
  seen.add(id);
  return id;
}

/** Parse the first balanced {…} starting at pos; returns [content, nextPos]. */
function parseBrace(str, pos) {
  // skip leading whitespace
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  if (str[pos] !== '{') return [null, pos];
  let depth = 0, start = pos + 1;
  for (let i = pos; i < str.length; i++) {
    if      (str[i] === '{') depth++;
    else if (str[i] === '}') { if (--depth === 0) return [str.slice(start, i), i + 1]; }
  }
  return [null, pos];
}

/** Parse an optional [N] at pos; returns [N|null, nextPos]. */
function parseBracket(str, pos) {
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  if (str[pos] !== '[') return [null, pos];
  const end = str.indexOf(']', pos);
  if (end === -1) return [null, pos];
  return [str.slice(pos + 1, end).trim(), end + 1];
}

/** Strip TeX formatting from a label string and normalise whitespace. */
function cleanLabel(raw) {
  return raw
    // Extract content from common formatting commands: \textit{x} → x
    .replace(/\\(?:textit|textbf|emph|enquote|textsc)\{([^}]*)\}/g, '$1')
    // Drop remaining unknown commands
    .replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, (m, arg) => arg ? arg.slice(1, -1) : '')
    // Collapse line breaks and extra whitespace
    .replace(/\\\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── MACRO PARSER ──────────────────────────────────────────────────────────────

const MACRO_RE = /\\(scoreheading|scoreitem|scoremod|scorepen|scorepenpcent|penaltyitem|infoitem)\b/;

function parseMacroOnLine(line) {
  const m = MACRO_RE.exec(line);
  if (!m) return null;

  const macro = m[1];
  let pos     = m.index + m[0].length;

  if (macro === 'scoreheading' || macro === 'infoitem') {
    const [label] = parseBrace(line, pos);
    return label != null ? { macro, label: cleanLabel(label) } : null;
  }

  if (macro === 'scorepenpcent') {
    const [label] = parseBrace(line, pos);
    return label != null ? { macro, label: cleanLabel(label) } : null;
  }

  // Optional [maxCount]
  let maxCount = null;
  const [nStr, p1] = parseBracket(line, pos);
  if (nStr !== null) { maxCount = parseInt(nStr, 10); pos = p1; }

  // {pts}{label}
  const [ptsStr, p2] = parseBrace(line, pos);
  const [rawLabel   ] = parseBrace(line, p2);
  if (ptsStr == null || rawLabel == null) return null;

  return {
    macro,
    maxCount,
    points: Math.abs(parseInt(ptsStr, 10)),   // always positive
    label:  cleanLabel(rawLabel),
  };
}

// ── MAIN CONVERTER ────────────────────────────────────────────────────────────

function convertFile(texPath) {
  const raw = fs.readFileSync(texPath, 'utf8');

  // Strip line comments (but not \%)
  const content = raw
    .split('\n')
    .map(l => l.replace(/(?<!\\)%.*$/, ''))
    .join('\n');

  // --- scorelist options ---
  const optMatch = content.match(/\\begin\{scorelist\}\s*(?:\[([^\]]*)\])?/);
  if (!optMatch) throw new Error('No \\begin{scorelist} found');

  const opts = {};
  if (optMatch[1]) {
    optMatch[1].split(',').forEach(pair => {
      const [k, v] = pair.split('=').map(s => s.trim());
      if (k) opts[k] = v !== undefined ? v : true;
    });
  }

  const timeLimit = opts.timelimit ? parseInt(opts.timelimit, 10) : null;

  // --- derive id and name from filename ---
  const basename = path.basename(texPath, '.tex');
  // CamelCase → snake_case, handles GPSR-style all-caps words too
  const testId = basename
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')   // ABCDef → ABC_Def
    .replace(/([a-z])([A-Z])/g, '$1_$2')           // camelCase → camel_Case
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const testName = basename
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();

  // --- parse body ---
  const seenIds   = new Set();
  const sections  = [];
  let curSection  = null;   // current section object
  let curItem     = null;   // last \scoreitem (for attaching mods/pens)

  function ensureSection(defaultHeading = 'General') {
    if (!curSection) {
      curSection = { id: slugify(defaultHeading), heading: defaultHeading, items: [] };
      sections.push(curSection);
    }
  }

  for (const line of content.split('\n')) {
    const p = parseMacroOnLine(line);
    if (!p) continue;

    const { macro, maxCount, points, label } = p;

    switch (macro) {
      case 'scoreheading': {
        curSection = { id: uniqueId(slugify(label), seenIds), heading: label, items: [] };
        sections.push(curSection);
        curItem = null;
        break;
      }

      case 'scoreitem': {
        ensureSection();
        const id = uniqueId(slugify(label), seenIds);
        // maxCount === 1 is treated as boolean (single-occurrence item)
        curItem = (maxCount != null && maxCount > 1)
          ? { id, type: 'count', label, points, maxCount }
          : { id, type: 'boolean', label, points };
        curSection.items.push(curItem);
        break;
      }

      case 'scoremod': {
        if (!curItem) { warn(texPath, `\\scoremod outside \\scoreitem — skipped: "${label}"`); break; }
        const mod = { id: uniqueId(slugify(label), seenIds), label, points };
        // maxCount === 1 treated as boolean modifier
        if (maxCount != null && maxCount > 1) { mod.type = 'count'; mod.maxCount = maxCount; }
        else                                  { mod.type = 'boolean'; }
        (curItem.modifiers = curItem.modifiers || []).push(mod);
        break;
      }

      case 'scorepen': {
        if (!curItem) { warn(texPath, `\\scorepen outside \\scoreitem — skipped: "${label}"`); break; }
        const pen = { id: uniqueId(slugify(label), seenIds), type: 'fixed', label, points };
        if (maxCount != null) pen.maxCount = maxCount;
        (curItem.penalties = curItem.penalties || []).push(pen);
        break;
      }

      case 'scorepenpcent': {
        if (!curItem) { warn(texPath, `\\scorepenpcent outside \\scoreitem — skipped: "${label}"`); break; }
        const pen = {
          id:     uniqueId(slugify(label), seenIds),
          type:   'percentage',
          label,
          points: curItem.points,   // 100 % = full parent item value
        };
        (curItem.penalties = curItem.penalties || []).push(pen);
        break;
      }

      case 'penaltyitem': {
        ensureSection();
        const id   = uniqueId(slugify(label), seenIds);
        const item = { id, type: 'standalone_penalty', label, points };
        if (maxCount != null) item.maxCount = maxCount;
        curSection.items.push(item);
        curItem = null;   // penaltyitems don't accept sub-items
        break;
      }

      case 'infoitem': {
        ensureSection();
        curSection.items.push({ id: uniqueId(slugify(label), seenIds), type: 'info', label });
        curItem = null;
        break;
      }
    }
  }

  if (!sections.length) throw new Error('No sections or items found — is this a scorelist file?');

  return { id: testId, name: testName, timeLimit, sections };
}

function warn(file, msg) {
  console.warn(`  ⚠  ${path.basename(file)}: ${msg}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const [,, inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error(
    'Usage:\n' +
    '  node tex2test.js <input-dir> [output-dir]\n' +
    '  node tex2test.js <input.tex> [output.json]'
  );
  process.exit(1);
}

const inputStat = fs.statSync(inputArg);
const files = inputStat.isDirectory()
  ? fs.readdirSync(inputArg)
      .filter(f => f.endsWith('.tex'))
      .map(f => path.join(inputArg, f))
  : [inputArg];

const outputDir = outputArg
  ? (outputArg.endsWith('.json') ? path.dirname(outputArg) : outputArg)
  : (inputStat.isDirectory() ? inputArg : path.dirname(inputArg));

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

let ok = 0, skipped = 0, failed = 0;

for (const file of files) {
  const outName = (outputArg && outputArg.endsWith('.json') && files.length === 1)
    ? path.basename(outputArg)
    : path.basename(file, '.tex')
        .replace(/([A-Z])/g, (c, _, i) => (i > 0 ? '_' : '') + c.toLowerCase())
        .replace(/__+/g, '_') + '.json';
  const outPath = path.join(outputDir, outName);

  try {
    const result = convertFile(file);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(`  ✓  ${path.basename(file)} → ${outName}`);
    ok++;
  } catch (e) {
    if (e.message.includes('No \\begin{scorelist}')) {
      console.log(`  –  ${path.basename(file)} (skipped — not a scorelist file)`);
      skipped++;
    } else {
      console.error(`  ✗  ${path.basename(file)}: ${e.message}`);
      failed++;
    }
  }
}

console.log(`\nDone: ${ok} converted, ${skipped} skipped, ${failed} failed.`);
