import { SOURCE_LIMITS } from '../limits.ts';

// An app is a map of path → text, sent by an agent. It never becomes files on disk:
// the bundler reads from the map, so a path can only ever name another entry of it.

export type SourceFiles = Record<string, string>;

export interface BuildProblem {
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

export class BuildFailure extends Error {
  readonly problems: BuildProblem[];
  constructor(problems: BuildProblem[]) {
    super(problems.map((problem) => problem.message).join('; '));
    this.problems = problems;
  }
}

/** web/ is the screens, server/ the functions, shared/ what both import, migrations/ the schema. */
export const FOLDERS = ['web', 'server', 'shared', 'migrations'] as const;

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const EXTENSIONS: Record<string, readonly string[]> = {
  web: ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.svg'],
  server: ['.ts', '.js', '.json'],
  shared: ['.ts', '.js', '.json'],
  migrations: ['.sql'],
};

export function extension(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function pathProblem(file: string): string | null {
  if (file === 'app.json') return null;
  if (file.length > SOURCE_LIMITS.maxPathLength) return 'path too long';
  const segments = file.split('/');
  const folder = segments[0] ?? '';
  const allowed = EXTENSIONS[folder];
  if (!allowed || segments.length < 2)
    return `files go in ${FOLDERS.map((name) => `${name}/`).join(', ')} or are app.json`;
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    return 'path segments may only use letters, digits, "_", "-" and ".", and cannot start with "." or "-"';
  }
  if (folder === 'migrations' && segments.length !== 2) return 'migrations/ has no sub-folders';
  if (!allowed.includes(extension(file))) return `${folder}/ accepts ${allowed.join(', ')} files`;
  return null;
}

/** Checks the shape of what was sent, before anything reads it. */
export function checkFiles(files: unknown): BuildProblem[] {
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return [{ message: 'expected an object of path → text' }];
  }
  const entries = Object.entries(files);
  if (entries.length === 0) return [{ message: 'the app has no file' }];
  if (entries.length > SOURCE_LIMITS.maxFiles) return [{ message: `too many files (limit ${SOURCE_LIMITS.maxFiles})` }];
  const problems: BuildProblem[] = [];
  let total = 0;
  for (const [file, text] of entries) {
    if (typeof text !== 'string') {
      problems.push({ file, message: 'the content must be text' });
      continue;
    }
    const problem = pathProblem(file);
    if (problem) problems.push({ file, message: problem });
    if (text.length > SOURCE_LIMITS.maxFileBytes) {
      problems.push({ file, message: `file too large (limit ${SOURCE_LIMITS.maxFileBytes / 1024} KiB)` });
    }
    total += text.length;
  }
  if (total > SOURCE_LIMITS.maxTotalBytes) {
    problems.push({
      message: `the app is too large (limit ${SOURCE_LIMITS.maxTotalBytes / 1024 / 1024} MiB of sources)`,
    });
  }
  return problems;
}
