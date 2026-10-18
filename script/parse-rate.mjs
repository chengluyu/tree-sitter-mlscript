#!/usr/bin/env node
// Measure how much of a corpus of .mls files parses without ERROR or MISSING
// nodes, and list where each failing file first goes wrong.
//
// Usage: node script/parse-rate.mjs <dir-or-file>...
//
// The tree-sitter CLI is taken from $TS (default: a pinned `npx` version) and
// is run from the repository root, so it uses this grammar. The first run
// passes --rebuild: the CLI caches the compiled parser by language name, so a
// build of another checkout of this grammar could otherwise be picked up.
//
// A failing file is marked "expected" when every one of its innermost errors
// sits in a diff-test block that the reference parser rejects too: a block
// (lines between blank lines) carrying a `:pe` directive or whose `//│` output
// reports a PARSE ERROR or LEXICAL ERROR.

import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TS = process.env.TS || 'npx -y tree-sitter-cli@0.26.9';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function collect(path, out) {
  if (statSync(path).isDirectory()) {
    for (const e of readdirSync(path).sort()) collect(join(path, e), out);
  } else if (path.endsWith('.mls')) {
    out.push(path);
  }
  return out;
}

const files = process.argv.slice(2).flatMap(p => collect(resolve(p), []));
if (files.length === 0) {
  console.error('usage: node script/parse-rate.mjs <dir-or-file>...');
  process.exit(2);
}

const run = cmd =>
  execSync(cmd, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });

const pathsFile = join(mkdtempSync(join(tmpdir(), 'mls-parse-rate-')), 'paths.txt');
writeFileSync(pathsFile, files.join('\n') + '\n');

// `parse --quiet` prints one line per file that has an ERROR or MISSING node.
let quiet;
try {
  quiet = run(`${TS} parse --rebuild --quiet --paths '${pathsFile}'`);
} catch (e) {
  quiet = e.stdout ?? ''; // the CLI exits non-zero when some file fails
}
const failing = quiet
  .split('\n')
  .filter(l => /\((ERROR|MISSING)/.test(l))
  .map(l => l.split(/\s+/)[0]);

// Innermost error nodes: ERROR / MISSING nodes that contain no other one.
function leafErrors(file) {
  let tree;
  try {
    tree = run(`${TS} parse '${file}'`);
  } catch (e) {
    tree = e.stdout ?? '';
  }
  // The tree marks ERROR nodes but prints a MISSING node as an ordinary
  // zero-width one; the per-file summary line after it names the first error
  // of either kind, so it is the fallback when the tree shows no ERROR.
  const pattern = /\((ERROR|MISSING[^[]*?) ?\[(\d+), (\d+)\] - \[(\d+), (\d+)\]/g;
  const lines = tree.split('\n');
  const summary = lines.filter(l => l.includes('Parse:')).join('\n');
  const toNode = (m, i) => ({ i, kind: m[1].trim(), s: [+m[2], +m[3]], e: [+m[4], +m[5]] });
  let nodes = [...lines.filter(l => !l.includes('Parse:')).join('\n').matchAll(pattern)].map(toNode);
  if (nodes.length === 0) nodes = [...summary.matchAll(pattern)].map(toNode);
  const le = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
  // Nodes with equal ranges nest in output order, the outer one first.
  const contains = (a, b) => a.i < b.i && le(a.s, b.s) && le(b.e, a.e);
  return nodes.filter(n => !nodes.some(o => contains(n, o)));
}

function blockOf(lines, row) {
  let a = row;
  while (a > 0 && lines[a - 1].trim() !== '') a--;
  let b = row;
  while (b + 1 < lines.length && lines[b + 1].trim() !== '') b++;
  return lines.slice(a, b + 1);
}

const expectedBlock = block =>
  block.some(l => /^:pe\b/.test(l) || (l.startsWith('//│') && /\[(PARSE|LEXICAL) ERROR\]/.test(l)));

const report = failing.map(file => {
  const lines = readFileSync(file, 'utf8').split('\n');
  const errs = leafErrors(file);
  const first = errs.reduce((a, b) => (!a || b.s[0] < a.s[0] || (b.s[0] === a.s[0] && b.s[1] < a.s[1]) ? b : a), null);
  const expected = errs.length > 0 && errs.every(n => expectedBlock(blockOf(lines, n.s[0])));
  const row = first ? first.s[0] : 0;
  return {
    file,
    line: row + 1,
    kind: first ? first.kind : '?',
    source: (lines[row] ?? '').trim().slice(0, 70),
    expected,
  };
});

const total = files.length;
const clean = total - failing.length;
const expected = report.filter(r => r.expected).length;
const pct = (n, d) => ((100 * n) / d).toFixed(1) + '%';
const common = (() => {
  let p = dirname(files[0]);
  while (!files.every(f => f.startsWith(p + '/'))) p = dirname(p);
  return p + '/';
})();

console.log(`files:      ${total}`);
console.log(`clean:      ${clean} (${pct(clean, total)})`);
console.log(`failing:    ${failing.length}`);
console.log(`  of which every error is in a block the reference rejects (:pe / PARSE ERROR): ${expected}`);
console.log(`clean or expected: ${clean + expected} (${pct(clean + expected, total)})`);
console.log();
for (const r of report) {
  const tag = r.expected ? 'expected' : 'FAIL    ';
  console.log(`${tag}  ${r.file.replace(common, '')}:${r.line}  [${r.kind}]  ${r.source}`);
}
