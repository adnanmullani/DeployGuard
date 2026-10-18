import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { parseReview } from '../src/ai';
import { classify, infraFiles } from '../src/files';
import { maskSecrets } from '../src/mask';
import { parsePlan } from '../src/plan';
import { diffRules, suggestFixes } from '../src/linerules';
import { planRules } from '../src/rules';
import { addedLinesNumbered } from '../src/files';

const plan = parsePlan(readFileSync('examples/sample-plan.json', 'utf8'));

describe('plan parser', () => {
  it('detects replace and drops no-op', () => {
    expect(plan.map((c) => c.action)).toEqual(['replace', 'update', 'create']);
  });
});

describe('plan rules', () => {
  const ids = planRules(plan).map((f) => f.id);
  it('flags replaced stateful DB as high', () => {
    const f = planRules(plan).find((x) => x.id === 'plan-replace');
    expect(f?.severity).toBe('high');
  });
  it('flags open ingress, IAM wildcard, public RDS, unencrypted', () => {
    expect(ids).toEqual(expect.arrayContaining(['open-ingress', 'iam-wildcard', 'rds-public', 'unencrypted-storage']));
  });
});

describe('file classification', () => {
  it('classifies infra files', () => {
    expect(classify({ filename: 'infra/main.tf' })).toBe('terraform');
    expect(classify({ filename: 'app/Dockerfile' })).toBe('docker');
    expect(classify({ filename: '.github/workflows/ci.yml' })).toBe('pipeline');
    expect(classify({ filename: 'k8s/dep.yaml', patch: '+apiVersion: apps/v1' })).toBe('kubernetes');
    expect(classify({ filename: 'src/app.ts' })).toBe('other');
  });
  it('drops removed files', () => {
    expect(infraFiles([{ filename: 'a.tf', status: 'removed' }])).toHaveLength(0);
  });
});

describe('diff rules', () => {
  it('flags latest tag and root user in Dockerfile', () => {
    const files = infraFiles([{ filename: 'Dockerfile', status: 'modified', patch: '@@\n+FROM node:latest\n+USER root' }]);
    expect(diffRules(files, false).map((f) => f.id)).toEqual(['docker-latest', 'docker-root']);
  });
  it('flags privileged pods and pull_request_target', () => {
    const k = infraFiles([{ filename: 'd.yaml', status: 'added', patch: '+kind: Pod\n+privileged: true' }]);
    const w = infraFiles([{ filename: '.github/workflows/x.yml', status: 'added', patch: '+on: pull_request_target' }]);
    expect(diffRules(k, false)[0].id).toBe('k8s-privileged');
    expect(diffRules(w, false)[0].id).toBe('ci-pr-target');
  });
  it('skips plan-covered rules when a plan is present', () => {
    const files = infraFiles([{ filename: 'a.tf', status: 'added', patch: '+  cidr_blocks = ["0.0.0.0/0"]' }]);
    expect(diffRules(files, true)).toHaveLength(0);
    expect(diffRules(files, false)).toHaveLength(1);
  });
});

describe('secret masking', () => {
  it('redacts keys and assignments', () => {
    const out = maskSecrets('key AKIAABCDEFGHIJKLMNOP\npassword = "hunter2hunter2"');
    expect(out).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(out).not.toContain('hunter2');
  });
});

describe('ai response parsing', () => {
  it('extracts json from fenced output and normalises risk', () => {
    const r = parseReview('```json\n{"risk":"HIGH","summary":"s","blastRadius":["a"],"rollback":["b"]}\n```');
    expect(r.risk).toBe('high');
    expect(r.rollback).toEqual(['b']);
  });
  it('throws without json', () => {
    expect(() => parseReview('nope')).toThrow();
  });
});

describe('line numbers', () => {
  it('maps added lines to new-file line numbers', () => {
    const patch = '@@ -1,3 +10,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2';
    expect(addedLinesNumbered(patch)).toEqual([{ line: 11, text: 'new1' }, { line: 12, text: 'new2' }]);
  });
});

describe('suggested fixes', () => {
  const sug = (filename: string, body: string) =>
    suggestFixes(infraFiles([{ filename, status: 'modified', patch: `@@ -1,1 +1,${body.split('\n').length} @@\n` + body.split('\n').map((l) => '+' + l).join('\n') }]));

  it('pins known official images, never guesses unknown ones', () => {
    expect(sug('Dockerfile', 'FROM node:latest')[0].replacement).toBe('FROM node:20');
    expect(sug('Dockerfile', 'FROM myorg/node:latest')[0].replacement).toBeNull();
    expect(sug('Dockerfile', 'FROM somecustom:latest')[0].replacement).toBeNull();
  });
  it('keeps indentation and targets the right line', () => {
    const s = sug('main.tf', 'resource "aws_db_instance" "a" {\n  publicly_accessible = true\n}');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ line: 2, replacement: '  publicly_accessible = false' });
  });
  it('does not suggest closing 0.0.0.0/0 on port 443', () => {
    const s = sug('main.tf', '  from_port = 443\n  cidr_blocks = ["0.0.0.0/0"]');
    expect(s[0].replacement).toBeNull();
  });
  it('suggests a narrower CIDR otherwise', () => {
    const s = sug('main.tf', '  from_port = 22\n  cidr_blocks = ["0.0.0.0/0"]');
    expect(s[0].replacement).toBe('  cidr_blocks = ["10.0.0.0/16"]');
  });
  it('fixes k8s and workflow settings', () => {
    expect(sug('d.yaml', 'kind: Pod\n  privileged: true')[0].replacement).toBe('  privileged: false');
    expect(sug('.github/workflows/a.yml', 'permissions: write-all')[0].replacement).toBe('permissions: read-all');
  });
});
