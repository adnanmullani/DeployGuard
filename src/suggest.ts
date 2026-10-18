import { createHash } from 'crypto';
import { Suggestion } from './linerules';

const MAX_PER_RUN = 15;
const TAG = 'dg-fix';

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

export const fixable = (s: Suggestion[]) => s.filter((x) => x.replacement !== null);

export function suggestionKey(s: Suggestion): string {
  const h = createHash('sha1').update(s.original.trim()).digest('hex').slice(0, 10);
  return `${s.ruleId}:${s.path}:${h}`;
}

export function renderSuggestion(s: Suggestion): string {
  return [
    `<!-- ${TAG}:${suggestionKey(s)} -->`,
    `🛡️ **DeployGuard**: ${s.title}`,
    '',
    s.detail,
    '',
    '```suggestion',
    s.replacement ?? '',
    '```',
    s.fixNote ? `> ${s.fixNote}` : '',
    '<sub>Click **Commit suggestion** to apply. Nothing changes until you do.</sub>',
    '<sub>Need a different value? Click the **±** icon in the reply box to write your own suggestion, or edit the file directly.</sub>',
  ].join('\n');
}

/** Posts one-click "Suggested change" review comments. Returns how many new ones were posted. */
export async function postSuggestions(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  commit_id: string,
  suggestions: Suggestion[],
): Promise<number> {
  const existing = await octokit.paginate(octokit.rest.pulls.listReviewComments, { owner, repo, pull_number, per_page: 100 });
  // Keyed on content, so a pushed commit that shifts line numbers does not duplicate a comment,
  // and a fix the author already dismissed is not nagged again.
  const posted = new Set(
    existing.map((c) => /<!-- dg-fix:(\S+) -->/.exec(c.body ?? '')?.[1]).filter((k): k is string => !!k),
  );
  const fresh = fixable(suggestions).filter((s) => !posted.has(suggestionKey(s))).slice(0, MAX_PER_RUN);
  if (!fresh.length) return 0;

  await octokit.rest.pulls.createReview({
    owner, repo, pull_number, commit_id, event: 'COMMENT',
    comments: fresh.map((s) => ({ path: s.path, line: s.line, side: 'RIGHT' as const, body: renderSuggestion(s) })),
  });
  return fresh.length;
}
