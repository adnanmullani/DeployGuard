import { AiReview, Finding, PlanChange, Risk } from './types';

export const MARKER = '<!-- deployguard-comment -->';

const BADGE: Record<Risk, string> = { high: '🔴 HIGH RISK', medium: '🟠 MEDIUM RISK', low: '🟢 LOW RISK' };
const ICON: Record<Risk, string> = { high: '🔴', medium: '🟠', low: '🟡' };

export interface CommentInput {
  risk: Risk;
  findings: Finding[];
  plan: PlanChange[];
  ai: AiReview | null;
  aiError?: string;
  filesReviewed: number;
  failOn: string;
  fixCount?: number;
}

export function renderComment(i: CommentInput): string {
  const lines: string[] = [MARKER, `## 🛡️ DeployGuard: ${BADGE[i.risk]}`, ''];

  if (i.ai?.summary) lines.push(i.ai.summary, '');

  if (i.findings.length) {
    lines.push('### Findings');
    const sorted = [...i.findings].sort((a, b) => order(b.severity) - order(a.severity));
    for (const f of sorted) {
      lines.push(`- ${ICON[f.severity]} **${f.title}**${f.location ? ` (\`${f.location}\`)` : ''}: ${f.detail}`);
    }
    lines.push('');
  } else {
    lines.push('No rule violations found.', '');
  }

  if (i.plan.length) {
    lines.push('<details><summary>Terraform plan changes</summary>', '', '| Action | Resource |', '|---|---|');
    for (const c of i.plan) lines.push(`| ${c.action} | \`${c.address}\` |`);
    lines.push('', '</details>', '');
  }

  if (i.ai?.blastRadius.length) {
    lines.push('### 💥 Blast radius', ...i.ai.blastRadius.map((b) => `- ${b}`), '');
  }
  if (i.ai?.rollback.length) {
    lines.push('### ↩️ Rollback plan', ...i.ai.rollback.map((r, n) => `${n + 1}. ${r}`), '');
  }
  if (i.fixCount) {
    lines.push(
      `### 💡 ${i.fixCount} one-click fix${i.fixCount > 1 ? 'es' : ''}`,
      'See the inline **Suggested change** comments in *Files changed*.',
      i.fixCount > 1
        ? 'Tip: click **Add suggestion to batch** on each one, then **Commit suggestions** once to apply them all in a single commit.'
        : 'Click **Commit suggestion** to apply it.',
      '',
    );
  }
  if (i.aiError) lines.push(`> ⚠️ AI review unavailable (${i.aiError}). Showing rule-based results only.`, '');

  lines.push(
    '---',
    `<sub>${i.filesReviewed} infra file(s) reviewed · merge gate: \`fail-on: ${i.failOn}\` · [DeployGuard](https://github.com/adnanmullani/DeployGuard)</sub>`,
  );
  return lines.join('\n');
}

const order = (r: Risk) => ({ low: 0, medium: 1, high: 2 })[r];
