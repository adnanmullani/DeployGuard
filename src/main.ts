import * as core from '@actions/core';
import * as github from '@actions/github';
import { readFileSync } from 'fs';
import { buildPrompt, DEFAULT_MODELS, Provider, review } from './ai';
import { MARKER, renderComment } from './comment';
import { infraFiles } from './files';
import { maskSecrets } from './mask';
import { parsePlan, summarizePlan } from './plan';
import { diffRules, suggestFixes } from './linerules';
import { planRules } from './rules';
import { fixable, postSuggestions } from './suggest';
import { AiReview, ChangedFile, Finding, maxRisk, PlanChange, Risk, RISK_ORDER } from './types';

async function run(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const planFile = core.getInput('plan-file');
  const provider = (core.getInput('ai-provider') || 'gemini') as Provider;
  const apiKey = core.getInput('api-key');
  const model = core.getInput('model') || DEFAULT_MODELS[provider];
  const failOn = (core.getInput('fail-on') || 'high').toLowerCase();
  const wantFixes = core.getInput('suggest-fixes') !== 'false';
  const maxChars = parseInt(core.getInput('max-diff-chars') || '30000', 10);

  if (!DEFAULT_MODELS[provider]) throw new Error(`Unknown ai-provider "${provider}"`);
  if (!['high', 'medium', 'none'].includes(failOn)) throw new Error(`fail-on must be high, medium or none`);

  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.info('DeployGuard only runs on pull_request events. Skipping.');
    return;
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const all = (await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100,
  })) as ChangedFile[];
  const files = infraFiles(all);

  let plan: PlanChange[] = [];
  if (planFile) plan = parsePlan(readFileSync(planFile, 'utf8'));

  if (!files.length && !plan.length) {
    core.info('No infrastructure changes detected. Nothing to review.');
    core.setOutput('risk-level', 'low');
    core.setOutput('findings-count', 0);
    await upsert(octokit, owner, repo, pr.number, null);
    return;
  }

  const findings: Finding[] = [...planRules(plan), ...diffRules(files, plan.length > 0)];
  let risk: Risk = findings.reduce<Risk>((r, f) => maxRisk(r, f.severity), 'low');

  let ai: AiReview | null = null;
  let aiError: string | undefined;
  if (apiKey) {
    try {
      const diff = maskSecrets(files.map((f) => `### ${f.filename}\n${f.patch ?? ''}`).join('\n\n')).slice(0, maxChars);
      ai = await review(provider, apiKey, model, buildPrompt(findings, maskSecrets(summarizePlan(plan)), diff));
      risk = maxRisk(risk, ai.risk);
    } catch (e) {
      aiError = (e as Error).message.replace(apiKey, '***').slice(0, 200);
      core.warning(`AI review failed: ${aiError}`);
    }
  } else {
    core.info('No api-key provided: running rules only.');
  }

  let fixCount = 0;
  if (wantFixes) {
    const suggestions = suggestFixes(files);
    fixCount = fixable(suggestions).length;
    try {
      const n = await postSuggestions(octokit, owner, repo, pr.number, pr.head.sha, suggestions);
      if (n) core.info(`Posted ${n} suggested fix(es).`);
    } catch (e) {
      // Fork PRs get a read-only token; the main comment is still worth posting.
      core.warning(`Could not post suggested fixes: ${(e as Error).message}`);
      fixCount = 0;
    }
  }

  const body = renderComment({ risk, findings, plan, ai, aiError, filesReviewed: files.length, failOn, fixCount });
  await upsert(octokit, owner, repo, pr.number, body);

  core.setOutput('risk-level', risk);
  core.setOutput('findings-count', findings.length);

  if (failOn !== 'none' && RISK_ORDER[risk] >= RISK_ORDER[failOn as Risk]) {
    core.setFailed(`DeployGuard: ${risk.toUpperCase()} risk detected (fail-on: ${failOn}).`);
  }
}

async function upsert(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issue_number: number,
  body: string | null,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
  const existing = comments.find((c) => c.body?.includes(MARKER));
  if (!body) {
    if (existing) await octokit.rest.issues.deleteComment({ owner, repo, comment_id: existing.id });
    return;
  }
  if (existing) await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  else await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
