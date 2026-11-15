// Launch Ledger v9 — entry point (Node 22, standard library only).
//
// Reads the sealed snapshot, scores the board with lib/ledger.ts, and writes
// the entry's outputs:
//
//   /output/board.json            the ranked board (198 rows)
//   /output/dashboard/data.js    the dashboard's dataset, written beside the page
//   /output/dashboard/           the static page (copied from dashboard/)
//   /output/screenshots/         the four screenshots (copied from screenshots/)
//   /output/dossier.json         buildDossier's summary, written last
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
//
// The program is deterministic: same snapshot in, same bytes out. No clock,
// no randomness, no network; every sort has a total tie-break by slug.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/ledger.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launch ledger: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch ledger: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'dashboard'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });

writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);

/** Copy one directory's top-level regular files into `to`, skipping dot-names. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashCopied = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The dataset is written after the copy so the page always ships the data
// this run computed — never a stale data.js from the repository.
writeFileSync(join(out, 'dashboard', 'data.js'), dataScript(radar));

const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`launch ledger: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in the board, a detail view, a filtered view and the model screen\n`);
  process.exit(1);
}
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launch ledger: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const c = radar.counts;
process.stdout.write(
  `launch ledger: ${c.scanned} protocols scanned, ${c.watchlist} on the watchlist, ${c.ranked} rows ranked ` +
    `(${c.early} early: ${c.below_floor} below the floor, ${c.above_floor} above it; ${c.trading} already trading, ${c.set_aside} set aside)\n` +
    `launch ledger: top 3 ${board[0]!.name} $${(board[0]!.implied_value_usd / 1e6).toFixed(1)}M, ` +
    `${board[1]!.name} $${(board[1]!.implied_value_usd / 1e6).toFixed(1)}M, ` +
    `${board[2]!.name} $${(board[2]!.implied_value_usd / 1e6).toFixed(1)}M; total implied $${(c.total_implied_usd / 1e9).toFixed(2)}B\n` +
    `launch ledger: wrote ${join(out, 'board.json')}, ${join(out, 'dashboard')} (${dashCopied.length} files + data.js), ` +
    `${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
