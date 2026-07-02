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
