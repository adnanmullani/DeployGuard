import { readFileSync, writeFileSync } from 'fs';
import { renderComment } from '../src/comment';
import { infraFiles } from '../src/files';
import { parsePlan } from '../src/plan';
import { diffRules, suggestFixes } from '../src/linerules';
import { planRules } from '../src/rules';
import { renderSuggestion } from '../src/suggest';
import { maxRisk, Risk } from '../src/types';

const plan = parsePlan(readFileSync('examples/sample-plan.json', 'utf8'));
const files = infraFiles([
  { filename: 'examples/k8s/deployment.yaml', status: 'added', patch: readFileSync('examples/k8s/deployment.yaml', 'utf8').split('\n').map((l) => '+' + l).join('\n') },
]);
const findings = [...planRules(plan), ...diffRules(files, true)];
const risk = findings.reduce<Risk>((r, f) => maxRisk(r, f.severity), 'low');
const ai = {
  risk: 'high' as Risk,
  summary: 'This PR replaces the production Postgres instance and opens SSH to the internet. Both can cause downtime or compromise.',
  blastRadius: ['api and worker lose database connectivity during replacement', 'SSH exposed to the whole internet on aws_security_group.web'],
  rollback: ['Revert the PR and re-apply the previous plan', 'Restore app-db from the latest snapshot if the old instance was destroyed', 'Re-apply the previous security group rules'],
};
const fixes = suggestFixes(files).filter((x) => x.replacement !== null);
const md = renderComment({ risk, findings, plan, ai, filesReviewed: files.length, failOn: 'high', fixCount: fixes.length });
writeFileSync('preview.md', md);
console.log(md);
console.log('\n\n===== INLINE REVIEW COMMENTS (examples/k8s/deployment.yaml) =====\n');
console.log(fixes.map((f) => `line ${f.line}:\n${renderSuggestion(f)}`).join('\n\n'));
