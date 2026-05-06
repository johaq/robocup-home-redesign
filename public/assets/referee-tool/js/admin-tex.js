// Browser port of tex2test.js — converts RoboCup@Home scorelist .tex files to JSON test definitions.
// All functions are pure; no DOM or Firebase dependencies.

function texSlugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50);
}

function texUniqueId(base, seen) {
  let id = base, n = 2;
  while (seen.has(id)) id = base + '_' + n++;
  seen.add(id);
  return id;
}

function texParseBrace(str, pos) {
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  if (str[pos] !== '{') return [null, pos];
  let depth = 0, start = pos + 1;
  for (let i = pos; i < str.length; i++) {
    if      (str[i] === '{') depth++;
    else if (str[i] === '}') { if (--depth === 0) return [str.slice(start, i), i + 1]; }
  }
  return [null, pos];
}

function texParseBracket(str, pos) {
  while (pos < str.length && /\s/.test(str[pos])) pos++;
  if (str[pos] !== '[') return [null, pos];
  const end = str.indexOf(']', pos);
  if (end === -1) return [null, pos];
  return [str.slice(pos + 1, end).trim(), end + 1];
}

function texCleanLabel(raw) {
  return raw
    .replace(/\\(?:textit|textbf|emph|enquote|textsc)\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, function(m, arg) { return arg ? arg.slice(1, -1) : ''; })
    .replace(/\\\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TEX_MACRO_RE = /\\(scoreheading|scoreitem|scoremod|scorepen|scorepenpcent|penaltyitem|infoitem)\b/;

function texParseMacroOnLine(line) {
  const m = TEX_MACRO_RE.exec(line);
  if (!m) return null;
  const macro = m[1];
  let pos = m.index + m[0].length;

  if (macro === 'scoreheading' || macro === 'infoitem') {
    const r = texParseBrace(line, pos);
    return r[0] != null ? { macro, label: texCleanLabel(r[0]) } : null;
  }
  if (macro === 'scorepenpcent') {
    const r = texParseBrace(line, pos);
    return r[0] != null ? { macro, label: texCleanLabel(r[0]) } : null;
  }

  let maxCount = null;
  const br = texParseBracket(line, pos);
  if (br[0] !== null) { maxCount = parseInt(br[0], 10); pos = br[1]; }
  const pr = texParseBrace(line, pos);
  const lr = texParseBrace(line, pr[1]);
  if (pr[0] == null || lr[0] == null) return null;
  return { macro, maxCount, points: Math.abs(parseInt(pr[0], 10)), label: texCleanLabel(lr[0]) };
}

export function convertTexToTest(texContent, filename) {
  // Strip line comments
  const content = texContent.split('\n').map(function(l) {
    return l.replace(/(?<!\\)%.*$/, '');
  }).join('\n');

  const optMatch = content.match(/\\begin\{scorelist\}\s*(?:\[([^\]]*)\])?/);
  if (!optMatch) throw new Error('No \\begin{scorelist} found — is this a scorelist file?');

  const opts = {};
  if (optMatch[1]) {
    optMatch[1].split(',').forEach(function(pair) {
      const parts = pair.split('=').map(function(s) { return s.trim(); });
      const k = parts[0], v = parts[1];
      if (k) opts[k] = v !== undefined ? v : true;
    });
  }
  const timeLimit = opts.timelimit ? parseInt(opts.timelimit, 10) : null;

  // Derive id and name from filename
  const basename = filename.replace(/\.tex$/i, '');
  const testId = basename
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const testName = basename
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();

  const seenIds   = new Set();
  const sections  = [];
  let curSection  = null;
  let curItem     = null;

  function ensureSection() {
    if (!curSection) {
      curSection = { id: texSlugify('General'), heading: 'General', items: [] };
      sections.push(curSection);
    }
  }

  for (const line of content.split('\n')) {
    const p = texParseMacroOnLine(line);
    if (!p) continue;
    const { macro, maxCount, points, label } = p;

    if (macro === 'scoreheading') {
      curSection = { id: texUniqueId(texSlugify(label), seenIds), heading: label, items: [] };
      sections.push(curSection);
      curItem = null;
    } else if (macro === 'scoreitem') {
      ensureSection();
      const id = texUniqueId(texSlugify(label), seenIds);
      curItem = (maxCount != null && maxCount > 1)
        ? { id, type: 'count', label, points, maxCount }
        : { id, type: 'boolean', label, points };
      curSection.items.push(curItem);
    } else if (macro === 'scoremod') {
      if (!curItem) continue;
      const mod = { id: texUniqueId(texSlugify(label), seenIds), label, points };
      if (maxCount != null && maxCount > 1) { mod.type = 'count'; mod.maxCount = maxCount; }
      else mod.type = 'boolean';
      if (!curItem.modifiers) curItem.modifiers = [];
      curItem.modifiers.push(mod);
    } else if (macro === 'scorepen') {
      if (!curItem) continue;
      const pen = { id: texUniqueId(texSlugify(label), seenIds), type: 'fixed', label, points };
      if (maxCount != null) pen.maxCount = maxCount;
      if (!curItem.penalties) curItem.penalties = [];
      curItem.penalties.push(pen);
    } else if (macro === 'scorepenpcent') {
      if (!curItem) continue;
      const pen = { id: texUniqueId(texSlugify(label), seenIds), type: 'percentage', label, points: curItem.points };
      if (!curItem.penalties) curItem.penalties = [];
      curItem.penalties.push(pen);
    } else if (macro === 'penaltyitem') {
      ensureSection();
      const id   = texUniqueId(texSlugify(label), seenIds);
      const item = { id, type: 'standalone_penalty', label, points };
      if (maxCount != null) item.maxCount = maxCount;
      curSection.items.push(item);
      curItem = null;
    } else if (macro === 'infoitem') {
      ensureSection();
      curSection.items.push({ id: texUniqueId(texSlugify(label), seenIds), type: 'info', label });
      curItem = null;
    }
  }

  if (!sections.length) throw new Error('No sections or items found — is this a scorelist file?');
  return { id: testId, name: testName, timeLimit, sections };
}
