import { ChangedFile } from './types';

export type FileKind = 'terraform' | 'kubernetes' | 'docker' | 'pipeline' | 'other';

const K8S_HINT = /^[+\s-]?\s*(apiVersion|kind):/m;

export function classify(file: Pick<ChangedFile, 'filename' | 'patch'>): FileKind {
  const f = file.filename;
  const base = f.split('/').pop() ?? f;
  if (/\.(tf|tfvars)$/.test(f)) return 'terraform';
  if (/^dockerfile(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base)) return 'docker';
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(f) || base === '.gitlab-ci.yml' || base === 'Jenkinsfile') return 'pipeline';
  if (/\.ya?ml$/.test(f) && file.patch && K8S_HINT.test(file.patch)) return 'kubernetes';
  return 'other';
}

/** `*` stays inside a folder, `**` crosses folders, and a trailing `/` means a whole folder. */
export function isExcluded(path: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const p = raw.trim();
    if (!p) return false;
    if (p.endsWith('/')) return path.startsWith(p);
    const DOUBLE = '\u0001';
    const re = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, DOUBLE)
      .replace(/\*/g, '[^/]*')
      .replace(new RegExp(DOUBLE, 'g'), '.*');
    return new RegExp(`^${re}$`).test(path);
  });
}

export function infraFiles(files: ChangedFile[], exclude: string[] = []): (ChangedFile & { kind: FileKind })[] {
  return files
    .filter((f) => !isExcluded(f.filename, exclude))
    .map((f) => ({ ...f, kind: classify(f) }))
    .filter((f) => f.kind !== 'other' && f.status !== 'removed');
}

export function addedLines(patch = ''): string[] {
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

export interface NumberedLine {
  line: number; // line number in the new version of the file
  text: string;
}

export function addedLinesNumbered(patch = ''): NumberedLine[] {
  const out: NumberedLine[] = [];
  let n = 0;
  for (const l of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      n = parseInt(hunk[1], 10);
    } else if (l.startsWith('+') && !l.startsWith('+++')) {
      out.push({ line: n, text: l.slice(1) });
      n++;
    } else if (!l.startsWith('-') && !l.startsWith('\\')) {
      n++; // context line
    }
  }
  return out;
}
