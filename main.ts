// Token Radar: one sealed snapshot in, one ranked launch board out.
//
// The run is a short, linear pipeline:
//   1. settle the output directory (MAKEFUN_OUTPUT_DIR, else ./out) and the snapshot to read
//      (--input <path>, else ../input/snapshot.json reached from the output directory);
//   2. score the snapshot through lib/model.ts and refuse to ship a board the gate would reject;
//   3. write board.json and data.js, then copy dashboard/ and screenshots/ next to them;
//   4. seal dossier.json from what is now on disk with the vendored make.fun writer, and print
//      one summary line.
//
// Node's standard library plus erasable TypeScript only, so `node main.ts` needs no build step.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// Where the assets live: dashboard/ and screenshots/ are copied out of this repository.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// The judge's caps. text_max_bytes is the only one that shapes the dossier's bytes; the rest only
// refuse a directory that has outgrown what a submission may hold.
const TEXT_CAP_BYTES = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASH_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const MIN_SHOTS = 3;
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of `--<flag> value` or `--<flag>=value`; undefined when the flag or its value is missing. */
function flagValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === `--${flag}`) {
      const next = argv[i + 1];
      return next === undefined || next.startsWith('--') ? undefined : next;
    }
    if (token.startsWith(`--${flag}=`)) {
      const inline = token.slice(flag.length + 3);
      return inline === '' ? undefined : inline;
    }
  }
  return undefined;
}

/** The run's output directory: the env var when set and non-blank, else ./out, absolute from the cwd. */
function outputDir(): string {
  const env = process.env.MAKEFUN_OUTPUT_DIR;
  return resolve(env !== undefined && env.trim() !== '' ? env : 'out');
}

/** The flags this program understands; anything else on the command line is a typo worth refusing. */
const KNOWN_FLAGS = new Set(['input']);

/** Refuse an argument list this program cannot honour, rather than silently ignoring half of it. */
function checkArguments(): void {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      stop(2, `unexpected argument "${token}": this program takes --input <snapshot.json|directory> only`);
    }
    const name = token.slice(2).split('=')[0]!;
    if (!KNOWN_FLAGS.has(name)) {
      stop(2, `unknown flag "--${name}": this program takes --input <snapshot.json|directory> only`);
    }
    if (!token.includes('=')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) stop(2, `--${name} needs a value, e.g. --${name} ../input/snapshot.json`);
      i++;
    } else if (token.slice(name.length + 3) === '') {
      stop(2, `--${name}= needs a value, e.g. --${name}=../input/snapshot.json`);
    }
  }
}

/** A snapshot path as a file: a path ending in .json names the file, anything else names its directory. */
function asSnapshotFile(path: string): string {
  return path.endsWith('.json') ? path : join(path, 'snapshot.json');
}

/**
 * The snapshot file to read, and the candidates tried so the error can name them. An explicit
 * --input may name the JSON itself or the directory holding it, and it is read from the working
 * directory first and from beside the output directory second -- `--input ../input/snapshot.json`
 * works both from a subdirectory that keeps its own out/ and from the repository root. With no
 * --input, ../input/snapshot.json relative to the output directory is the harness's layout.
 */
function locateSnapshot(out: string): { file: string; tried: string[] } {
  const asked = flagValue('input');
  if (asked === undefined) {
    const fallback = asSnapshotFile(join(out, '..', 'input', 'snapshot.json'));
    return { file: fallback, tried: [fallback] };
  }
  const tried = [asSnapshotFile(resolve(asked)), asSnapshotFile(resolve(out, asked))];
  return { file: tried.find((p) => existsSync(p)) ?? tried[0]!, tried };
}

/** Stop with one clear line on stderr. Exit 2 means the arguments were unusable, 1 means the input or output was. */
function stop(code: number, reason: string): never {
  process.stderr.write(`token radar: ${reason}\n`);
  process.exit(code);
}

/**
 * Copy every regular file sitting directly in `from` into `to` (created if needed), skipping dot
 * files, and hand back the names copied. A missing source directory is an error rather than an
 * empty copy: both asset directories are part of what is handed in.
 */
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    stop(1, `no directory at ${from}: the dashboard and its screenshots are part of the submission`);
  }
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------- the run itself

const out = outputDir();
checkArguments();
const { file: snapshotFile, tried } = locateSnapshot(out);

if (!existsSync(snapshotFile)) {
  stop(2, `no snapshot found; tried ${tried.join(' and ')}. Pass --input <snapshot.json|directory>, or set MAKEFUN_OUTPUT_DIR so ../input/snapshot.json resolves.`);
}

const snapshot = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);

// The model is only as trustworthy as the gate's own rules; a refused board is never shipped.
const refusal = boardIssue(board, snapshot);
if (refusal !== null) stop(1, `the scored board would be rejected: ${refusal}`);

mkdirSync(out, { recursive: true });

// board.json keeps every row in full (model internals included); data.js is the page's dataset.
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board }, null, 1)}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

const dashboardFiles = copyDirectory(join(repoRoot, 'dashboard'), join(out, 'dashboard'));
const shots = copyDirectory(join(repoRoot, 'screenshots'), join(out, 'screenshots'));

// Three views are the floor of the submission: the board, a detail view and a filtered view.
if (shots.length < MIN_SHOTS) {
  stop(1, `screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}; at least ${MIN_SHOTS} are required`);
}
for (const name of shots) {
  if (!PLAIN_NAME.test(name)) stop(1, `screenshots/${name}: a dossier only accepts names of letters, digits and . _ -`);
}

// And last, the dossier: built from what is already on disk so the judge's rebuild matches byte for byte.
const dossier = buildDossier(out, {
  text_max_bytes: TEXT_CAP_BYTES,
  screenshots: SHOT_CAPS,
  dashboard: DASH_CAPS,
});
writeFileSync(join(out, 'dossier.json'), dossier);

// One banner for the run: what was read, what was scored, and everything left in the output directory.
const wrote = [
  `board.json (${board.length} rows)`,
  `data.js (window.RADAR)`,
  `dashboard/ (${dashboardFiles.length} files)`,
  `screenshots/ (${shots.length} images)`,
  `dossier.json (${dossier.length} bytes)`,
];
process.stdout.write(
  `token radar ${radar.model_version}  |  ${snapshot.protocols.length} protocols as of ${snapshot.as_of}\n` +
    `  board  ${board.length} ranked: ${snapshot.watchlist.length} watchlist + ${radar.early_size} early below the floor; ${radar.live_size} live set aside\n` +
    `  wrote  ${out}\n` +
    wrote.map((line) => `         - ${line}\n`).join(''),
);
