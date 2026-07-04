/**
 * Picks the best-scoring run per team+test from a list of submitted runs.
 * Returns a map keyed by `${teamId}__${testId}`, with the original run object
 * plus a `flooredScore` field (totalScore clamped to 0 — competition rule:
 * no run may contribute a negative score to the standings).
 */
export function bestRunsPerTeamTest(submittedRuns) {
  const best = {};
  for (const run of submittedRuns) {
    const { teamId, testId, totalScore } = run;
    if (!teamId || !testId) continue;
    const key = `${teamId}__${testId}`;
    if (!best[key] || (totalScore || 0) > (best[key].totalScore || 0)) {
      best[key] = run;
    }
  }
  // Apply the floor after selecting the best run so comparison uses raw scores
  // (a -5 run is still "better" than a -20 run and should be the one kept).
  return Object.fromEntries(
    Object.entries(best).map(([k, r]) => [k, { ...r, flooredScore: Math.max(0, r.totalScore || 0) }])
  );
}

/**
 * Points for a single scored item, given a run's `scores` map. Pure mirror of
 * scoresheet.js `itemPts`/`instancePts` — keep in sync so awards/aggregations match
 * the score sheet exactly. Handles:
 *   - boolean: base minus fixed penalties, then percentage on the reduced base, plus
 *     boolean/count modifiers (all keyed by penalty/modifier id in scores[item.id]'s peers).
 *   - count: a plain number × points, or an array of per-instance objects scored individually.
 *   - standalone_penalty: negative (count × points).
 * Not floored (the run total is floored elsewhere); an item may be net-negative.
 */
export function instancePoints(item, inst) {
  let pts = item.points;
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'fixed' && inst[pen.id]) pts -= pen.points;
  }
  for (const pen of (item.penalties || [])) {
    if (pen.type === 'percentage' && inst[pen.id]) pts -= Math.round(inst[pen.id] / 100 * pts);
  }
  for (const mod of (item.modifiers || [])) {
    if (mod.type === 'boolean' && inst[mod.id]) pts += mod.points;
    if (mod.type === 'count')                   pts += (inst[mod.id] || 0) * mod.points;
  }
  return pts;
}

export function itemPoints(item, scores) {
  scores = scores || {};
  if (item.type === 'boolean') {
    if (!scores[item.id]) return 0;
    let pts = item.points;
    for (const pen of (item.penalties || [])) {
      if (pen.type === 'fixed' && scores[pen.id]) pts -= pen.points;
    }
    for (const pen of (item.penalties || [])) {
      if (pen.type === 'percentage' && scores[pen.id]) pts -= Math.round(scores[pen.id] / 100 * pts);
    }
    for (const mod of (item.modifiers || [])) {
      if (mod.type === 'boolean' && scores[mod.id]) pts += mod.points;
      if (mod.type === 'count')                     pts += (scores[mod.id] || 0) * mod.points;
    }
    return pts;
  }
  if (item.type === 'count') {
    const v = scores[item.id];
    if (!v) return 0;
    if (Array.isArray(v)) return v.reduce((s, inst) => s + instancePoints(item, inst), 0);
    return v * item.points;
  }
  if (item.type === 'standalone_penalty') {
    return -((scores[item.id] || 0) * item.points);
  }
  return 0;
}

/** Sum specific item ids within one run (test def + the run's scores map). */
export function sumItems(testDef, scores, itemIds) {
  if (!testDef) return 0;
  const wanted = new Set(itemIds);
  return testDef.sections
    .flatMap(s => s.items)
    .filter(it => wanted.has(it.id))
    .reduce((sum, it) => sum + itemPoints(it, scores), 0);
}
