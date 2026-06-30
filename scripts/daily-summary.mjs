#!/usr/bin/env node
/**
 * Daily task summary — turns git commits into a dated work-log entry.
 *
 * Reads the commits in a date window and prints a Markdown entry. With --write it
 * inserts that entry at the top of tasks/DAILY_LOG.md (under the ENTRIES marker),
 * replacing any existing entry for the same day so re-running is idempotent.
 *
 * Usage:
 *   node scripts/daily-summary.mjs                       # today, print only
 *   node scripts/daily-summary.mjs --write               # today, write to log
 *   node scripts/daily-summary.mjs --since=2026-06-29 --until=2026-06-30 --write
 *   node scripts/daily-summary.mjs --date=2026-06-28     # a single past day
 *
 * No dependencies — just git + node.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'tasks', 'DAILY_LOG.md');
const MARKER = '<!-- DAILY-LOG:ENTRIES -->';

// --- args ---------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

function today() {
  // Local YYYY-MM-DD without pulling in a date lib.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const date = args.date ?? null;
const since = date ?? args.since ?? today();
const until = date ?? args.until ?? since;

// --- gather commits -----------------------------------------------------
// git "until" is exclusive at 00:00, so bump it by a day to include `until`.
function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

let raw = '';
try {
  raw = execFileSync(
    'git',
    [
      'log',
      `--since=${since} 00:00`,
      `--until=${nextDay(until)} 00:00`,
      '--no-merges',
      '--date=short',
      '--pretty=format:%ad%s%an',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
} catch (err) {
  console.error('Could not read git log:', err.message);
  process.exit(1);
}

const commits = raw
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [d, subject, author] = line.split('');
    return { date: d, subject, author };
  });

const label = since === until ? since : `${since} → ${until}`;

if (commits.length === 0) {
  const empty = `## ${label}\n\n- _No commits in this window._\n`;
  console.log(empty);
  if (args.write) upsertEntry(label, empty);
  process.exit(0);
}

// --- build the entry ----------------------------------------------------
const authors = [...new Set(commits.map((c) => c.author))];
const byType = {};
for (const c of commits) {
  const type = (c.subject.match(/^(\w+)(?:\(|:)/)?.[1] ?? 'other').toLowerCase();
  (byType[type] ??= []).push(c.subject);
}

const ORDER = ['feat', 'fix', 'perf', 'refactor', 'chore', 'docs', 'test', 'other'];
const typeKeys = Object.keys(byType).sort(
  (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
);

let entry = `## ${label}\n\n`;
entry += `_${commits.length} commit${commits.length === 1 ? '' : 's'}`;
entry += ` · ${authors.join(', ')}_\n\n`;
for (const type of typeKeys) {
  for (const subject of byType[type]) entry += `- ${subject}\n`;
}

console.log(entry);

if (args.write) {
  upsertEntry(label, entry);
  console.log(`✓ Written to ${LOG}`);
}

// --- write helper -------------------------------------------------------
function upsertEntry(dayLabel, entryText) {
  if (!existsSync(LOG)) {
    console.error(`Log file not found: ${LOG}`);
    process.exit(1);
  }
  let body = readFileSync(LOG, 'utf8');
  if (!body.includes(MARKER)) {
    console.error(`Marker "${MARKER}" not found in log; not writing.`);
    process.exit(1);
  }

  const [head, rest] = body.split(MARKER);
  // Drop any existing entry with the same heading so re-runs replace, not duplicate.
  const heading = `## ${dayLabel}`;
  let cleaned = rest;
  const start = rest.indexOf(`\n${heading}\n`);
  if (start !== -1) {
    const after = rest.indexOf('\n## ', start + 1);
    cleaned = rest.slice(0, start + 1) + (after === -1 ? '' : rest.slice(after + 1));
  }

  const normalized = cleaned.replace(/^\n+/, '');
  body = `${head}${MARKER}\n\n${entryText.trimEnd()}\n\n${normalized}`;
  writeFileSync(LOG, body);
}
