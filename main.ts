// Ember Yard, a threejs-fps-01 entry (Node 22, standard library only): the game
// is this directory's game/ folder — plain static files the browser loads as ES
// modules, with three.js from an import map — and this program hands it in. It
// copies game/ and screenshots/ from beside this file to the output directory
// and writes dossier.json there, the summary the judge reads, with the vendored
// make.fun library.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The entry is checked against the scorer's caps before anything is copied, so
// a build that would be refused fails here with a readable message instead of
// at grading time: at most 4 screenshots of 256 KiB each, at most 993 files
// and 48 MiB in game/ (beside /output's own 1000-entry cap), and a dossier
// under the text cap. The caps live in DOSSIER_OPTIONS, next to the checks
// that enforce them, so a cap and its check cannot drift apart.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the
// bytes; the others refuse an entry the scorer would refuse (more than 4
// screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of
// game files, in all: game/ counts beside /output's own 1000-entry cap, its
// screenshots/ and dossier.json).
const DOSSIER_OPTIONS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
};

function fail(message) {
  throw new Error(`Ember Yard: ${message}`);
}

// Walk a directory tree and total its files and bytes.
function countTree(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countTree(path);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(path).size;
    }
  }
  return { files, bytes };
}

// The game folder must fit the scorer's file and byte caps.
function checkGame(dir) {
  const stats = countTree(dir);
  if (stats.files > DOSSIER_OPTIONS.game_max_files) {
    fail(`game/ has ${stats.files} files, max is ${DOSSIER_OPTIONS.game_max_files}`);
  }
  if (stats.bytes > DOSSIER_OPTIONS.game_max_bytes) {
    fail(`game/ is ${stats.bytes} bytes, max is ${DOSSIER_OPTIONS.game_max_bytes}`);
  }
  return stats;
}

// Screenshots: at most 4, each at most 256 KiB. A missing folder counts as none.
function checkShots(dir) {
  if (!existsSync(dir)) return { count: 0, bytes: 0 };
  const shots = readdirSync(dir).filter((name) => /\.(jpg|jpeg|png)$/i.test(name));
  if (shots.length > DOSSIER_OPTIONS.screenshots.max) {
    fail(`${shots.length} screenshots, max is ${DOSSIER_OPTIONS.screenshots.max}`);
  }
  let bytes = 0;
  for (const name of shots) {
    const size = statSync(join(dir, name)).size;
    if (size > DOSSIER_OPTIONS.screenshots.max_bytes) {
      fail(`screenshot ${name} is ${size} bytes, max is ${DOSSIER_OPTIONS.screenshots.max_bytes}`);
    }
    bytes += size;
  }
  return { count: shots.length, bytes };
}

// Copy the entry beside this file into the output directory.
function copyEntry(gameDir, shotDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  cpSync(gameDir, join(outDir, 'game'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  if (existsSync(shotDir)) cpSync(shotDir, join(outDir, 'screenshots'), { recursive: true });
}

function main() {
  const gameDir = join(here, 'game');
  const shotDir = join(here, 'screenshots');
  const gameStats = checkGame(gameDir);
  const shotStats = checkShots(shotDir);
  copyEntry(gameDir, shotDir, out);
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, DOSSIER_OPTIONS));
  console.log(
    `Ember Yard: ${gameStats.files} game files (${gameStats.bytes} bytes), `
    + `${shotStats.count} screenshots (${shotStats.bytes} bytes) -> ${out}`,
  );
}

main();
