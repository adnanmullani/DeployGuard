import { addedLinesNumbered, FileKind, NumberedLine } from './files';
import { ChangedFile, Finding } from './types';

/** Returns the full replacement line, or null when no safe automatic fix exists. */
type Fix = (line: string, ctx: NumberedLine[], idx: number) => string | null;

interface LineRule {
  id: string;
  severity: Finding['severity'];
  kinds: FileKind[];
  re: RegExp;
  title: string;
  detail: string;
  fix?: Fix;
  /** Shown with the suggestion, for fixes that need the author to adjust a value. */
  fixNote?: string;
}

export interface Suggestion {
  ruleId: string;
  path: string;
  line: number;
  original: string;
  replacement: string | null;
  title: string;
  detail: string;
  fixNote?: string;
}

// Stable tags for official images. Anything else gets advice, never a guess.
const PINS: Record<string, string> = {
  node: '20', python: '3.12', nginx: '1.27', alpine: '3.20', ubuntu: '24.04', golang: '1.23',
  postgres: '16', redis: '7', mysql: '8.4', debian: 'bookworm',
};

const pinLatest: Fix = (line) => {
  const m = /([A-Za-z0-9._-]+):latest\b/.exec(line); // official images only: no registry or org prefix
  if (!m || !PINS[m[1]] || line.includes(`/${m[1]}:`)) return null;
  return line.replace(`${m[1]}:latest`, `${m[1]}:${PINS[m[1]]}`);
};

/** Port 80/443 on a public listener is normal, so do not suggest closing it. */
const nearPublicWebPort = (ctx: NumberedLine[], idx: number) =>
  ctx.slice(Math.max(0, idx - 4), idx + 5).some((l) => /(from_port|to_port|port)\s*=\s*(80|443)\b/.test(l.text));

const LINE_RULES: LineRule[] = [
  {
    id: 'tf-open-cidr', severity: 'high', kinds: ['terraform'], re: /(0\.0\.0\.0\/0|::\/0)/,
    title: 'Open CIDR 0.0.0.0/0', detail: 'Exposes a resource to the whole internet.',
    fix: (l, ctx, i) => (l.includes('0.0.0.0/0') && !nearPublicWebPort(ctx, i) ? l.replace('0.0.0.0/0', '10.0.0.0/16') : null),
    fixNote: 'Replace `10.0.0.0/16` with the range that really needs access (VPN, office, VPC).',
  },
  {
    id: 'tf-public-acl', severity: 'high', kinds: ['terraform'], re: /acl\s*=\s*"public-read/,
    title: 'Public S3 ACL', detail: 'Bucket contents may become public.',
    fix: (l) => l.replace(/"public-read[^"]*"/, '"private"'),
  },
  {
    id: 'tf-public-db', severity: 'high', kinds: ['terraform'], re: /publicly_accessible\s*=\s*true/,
    title: 'Database is publicly accessible', detail: 'Databases should live in private subnets.',
    fix: (l) => l.replace(/true/, 'false'),
  },
  {
    id: 'tf-unencrypted', severity: 'medium', kinds: ['terraform'], re: /(storage_encrypted|encrypted)\s*=\s*false/,
    title: 'Encryption disabled', detail: 'Enable encryption at rest.',
    fix: (l) => l.replace(/false/, 'true'),
  },
  {
    id: 'tf-iam-wildcard', severity: 'high', kinds: ['terraform'], re: /"?Action"?\s*[:=]\s*(\[\s*)?"\*"/,
    title: 'IAM Action "*"', detail: 'Overly broad permissions.',
  },
  {
    id: 'tf-force-destroy', severity: 'medium', kinds: ['terraform'], re: /force_destroy\s*=\s*true/,
    title: 'force_destroy = true', detail: 'Resource can be deleted even if it still holds data.',
    fix: (l) => l.replace(/true/, 'false'),
  },
  {
    id: 'tf-prevent-destroy-off', severity: 'medium', kinds: ['terraform'], re: /prevent_destroy\s*=\s*false/,
    title: 'prevent_destroy turned off', detail: 'Removes a safety net.',
    fix: (l) => l.replace(/false/, 'true'),
  },
  {
    id: 'docker-latest', severity: 'medium', kinds: ['docker'], re: /^\s*FROM\s+\S+:latest\b/i,
    title: 'Base image uses :latest', detail: 'Builds are not reproducible. Pin a version.', fix: pinLatest,
    fixNote: 'Pick the exact version your app is tested with.',
  },
  {
    id: 'docker-root', severity: 'medium', kinds: ['docker'], re: /^\s*USER\s+root\s*$/i,
    title: 'Container runs as root', detail: 'Use a non-root user.',
    fix: (l) => l.replace(/root/i, '10001'),
    fixNote: 'Make sure the files your app writes are owned by this user.',
  },
  {
    id: 'docker-curl-sh', severity: 'medium', kinds: ['docker'], re: /(curl|wget)[^|]*\|\s*(ba)?sh/,
    title: 'Pipes remote script to shell', detail: 'Supply chain risk. Download, verify a checksum, then run.',
  },
  {
    id: 'k8s-privileged', severity: 'high', kinds: ['kubernetes'], re: /privileged:\s*true/,
    title: 'Privileged container', detail: 'Grants near host-level access.',
    fix: (l) => l.replace(/true/, 'false'),
  },
  {
    id: 'k8s-host-net', severity: 'medium', kinds: ['kubernetes'], re: /host(Network|PID|IPC):\s*true/,
    title: 'Host namespace sharing', detail: 'Weakens pod isolation.',
    fix: (l) => l.replace(/true/, 'false'),
  },
  {
    id: 'k8s-latest', severity: 'medium', kinds: ['kubernetes'], re: /image:\s*\S+:latest\b/,
    title: 'Image uses :latest', detail: 'Rollouts and rollbacks become unpredictable. Pin a version or digest.', fix: pinLatest,
    fixNote: 'Pick the exact version you deploy.',
  },
  {
    id: 'k8s-run-as-root', severity: 'medium', kinds: ['kubernetes'], re: /runAsUser:\s*0\b/,
    title: 'Runs as UID 0', detail: 'Use a non-root user.',
    fix: (l) => l.replace(/\b0\b/, '10001'),
  },
  {
    id: 'ci-pr-target', severity: 'high', kinds: ['pipeline'], re: /pull_request_target/,
    title: 'pull_request_target trigger', detail: 'Runs with secrets on untrusted PR code.',
  },
  {
    id: 'ci-write-all', severity: 'high', kinds: ['pipeline'], re: /permissions:\s*write-all/,
    title: 'permissions: write-all', detail: 'Grant only the scopes you need.',
    fix: (l) => l.replace('write-all', 'read-all'),
    fixNote: 'Then grant individual `write` scopes only to jobs that need them.',
  },
  {
    id: 'ci-unpinned', severity: 'medium', kinds: ['pipeline'], re: /uses:\s*\S+@(main|master)\b/,
    title: 'Action pinned to a branch', detail: 'Pin to a tag or commit SHA.',
  },
];

// Rules the Terraform plan already covers precisely, so the diff version stays quiet when a plan is given.
const PLAN_COVERED = ['tf-open-cidr', 'tf-public-acl', 'tf-iam-wildcard', 'tf-public-db', 'tf-unencrypted'];

type KindedFile = ChangedFile & { kind: FileKind };

function hits(f: KindedFile) {
  const lines = addedLinesNumbered(f.patch);
  const out: { rule: LineRule; idx: number }[] = [];
  for (const rule of LINE_RULES) {
    if (!rule.kinds.includes(f.kind)) continue;
    lines.forEach((l, idx) => {
      if (!l.text.trim().startsWith('#') && rule.re.test(l.text)) out.push({ rule, idx });
    });
  }
  return { lines, out };
}

export function diffRules(files: KindedFile[], planProvided: boolean): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    const seen = new Set<string>();
    for (const { rule } of hits(f).out) {
      if (planProvided && PLAN_COVERED.includes(rule.id)) continue;
      if (seen.has(rule.id)) continue; // one finding per rule per file
      seen.add(rule.id);
      out.push({ id: rule.id, severity: rule.severity, title: rule.title, detail: rule.detail, location: f.filename });
    }
  }
  return out;
}

/** Line-level fixes. Independent of the plan: they only need the changed line. */
export function suggestFixes(files: KindedFile[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const f of files) {
    const { lines, out: found } = hits(f);
    for (const { rule, idx } of found) {
      const { line, text } = lines[idx];
      const replacement = rule.fix ? rule.fix(text, lines, idx) : null;
      if (replacement === text) continue;
      out.push({
        ruleId: rule.id, path: f.filename, line, original: text, replacement,
        title: rule.title, detail: rule.detail, fixNote: rule.fixNote,
      });
    }
  }
  return out;
}
