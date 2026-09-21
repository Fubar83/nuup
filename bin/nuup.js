#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { paletteFor } from '../src/color.js';
import { tabulate } from '../src/table.js';
import { EXIT, UsageError, reportError } from '../src/errors.js';
import { LOCKS, parseLock } from '../src/version.js';
import { SKIPPED, planUpgrades, writeUpgrades } from '../src/upgrade.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const USAGE = `nuup — upgrade the NuGet packages a repository references

Usage:
  nuup [-f <glob>]... [-vl <lock>] [--prerelease] [--write] [--json]

Options:
  -f,  --filter <glob>    Only packages whose name matches, e.g. "MyCompany.*".
                          Repeatable, and repeats are OR-ed. Omitted, every
                          package is considered.
  -vl, --version-lock <lock>
                          How far up to go. Either what must NOT change:
                            major  the major stays; minor and patch may move
                                   (the default)
                            minor  major and minor stay; only the patch moves
                            none   nothing is pinned, major bumps included
                          or a ceiling, which means the same for every project:
                            "<6.0.0"   the highest 5.x there is
                            "<=5.9.9"  up to and including 5.9.9
                          Quote a ceiling. Every shell reads a bare < as a
                          redirection, so -vl <6.0.0 never reaches nuup.
       --prerelease       Consider prerelease versions. A package already on
                          a prerelease is offered newer ones regardless.
  -w,  --write            Apply the upgrades. Without it nothing is written.
  -j,  --json             One JSON object per line, for piping
  -h,  --help             Show this help

Reads the repository in the current directory: no restore, no build, no
project evaluation. Versions come from the sources your NuGet.config defines,
through \`dotnet package search\`, so a repository that will not restore is
still answerable.

nuup edits files and stops there. Building, testing, committing and pushing
stay yours:

  repwrk foreach nuup -f "MyCompany.*" --write
  repwrk foreach --parallel dotnet build`;

const HINT = `Usage:
  nuup [-f <glob>]... [-vl <lock>] [--prerelease] [--write] [--json]`;

const SHORT = { '-f': '--filter', '-vl': '--version-lock', '-w': '--write', '-j': '--json' };

function parse(argv) {
  const options = {
    filters: [],
    lock: 'major',
    prerelease: false,
    write: false,
    json: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const typed = raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw;
    const token = SHORT[typed] ? SHORT[typed] + raw.slice(typed.length) : raw;
    const inline = token.includes('=') ? token.slice(token.indexOf('=') + 1) : null;

    const valueFor = (name) => {
      const value = inline ?? argv[index + 1];
      if (value === undefined || value === '' || (inline === null && value.startsWith('-'))) {
        throw new UsageError(`${typed} requires a value`, { hint: HINT });
      }
      if (inline === null) index += 1;
      return value;
    };

    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--version' || token === '-V') options.version = true;
    else if (token === '--write') options.write = true;
    else if (token === '--json') options.json = true;
    else if (token === '--prerelease') options.prerelease = true;
    else if (token.startsWith('--filter')) options.filters.push(valueFor('--filter'));
    else if (token.startsWith('--version-lock')) {
      const lock = valueFor('--version-lock');
      if (lock.toLowerCase() === 'patch') {
        throw new UsageError(
          'version-lock patch would pin every part and allow nothing to change; ' +
            'did you mean --version-lock minor, which allows patch updates?',
          { hint: HINT },
        );
      }
      if (parseLock(lock) === null) {
        throw new UsageError(
          `--version-lock takes one of ${LOCKS.join(', ')}, or a ceiling such as "<6.0.0" ` +
            'or "<=5.9.9" — quote it, or the shell reads < as a redirection',
          { hint: HINT },
        );
      }
      options.lock = lock;
    } else {
      throw new UsageError(
        typed.startsWith('-') ? `unknown option '${typed}'` : `unexpected argument '${typed}'`,
        { hint: HINT },
      );
    }
  }

  return options;
}

const plural = (count, one, many) => (count === 1 ? one : many);

function report(plan, { write, json }) {
  const out = process.stdout;
  // Decided per stream: `nuup > plan.txt` still wants a readable summary on
  // the terminal, and escape codes in the file would be corruption.
  const ink = paletteFor(process.stdout);
  const note = paletteFor(process.stderr);

  if (json) {
    for (const row of plan.upgrades) {
      out.write(`${JSON.stringify({ ...row, applied: write })}\n`);
    }
  } else {
    const rows = plan.upgrades.map((row) => ({
      group: row.file,
      name: row.package,
      version: row.from,
      to: row.to,
    }));
    for (const line of tabulate(rows, ink)) out.write(`${line}\n`);
  }

  // Everything that is not the answer goes to stderr, so a pipeline sees only
  // the upgrades.
  const counts = new Map();
  for (const row of plan.skipped) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);

  const unchecked = counts.get(SKIPPED.UNCHECKED) ?? 0;
  const notFound = counts.get(SKIPPED.NOT_FOUND) ?? 0;
  const notVersion = counts.get(SKIPPED.NOT_A_VERSION) ?? 0;

  const parts = [note.green(`${plan.upgrades.length} to upgrade`)];
  if (counts.get(SKIPPED.UP_TO_DATE)) parts.push(`${counts.get(SKIPPED.UP_TO_DATE)} up to date`);
  if (notVersion) parts.push(note.dim(`${notVersion} not a plain version`));
  if (notFound) parts.push(note.yellow(`${notFound} not on any source`));
  // Not knowing is the state worth spotting across forty repositories.
  if (unchecked) parts.push(note.yellow(`${unchecked} could not be checked`));
  process.stderr.write(`${note.bold('nuup:')} ${parts.join(', ')}\n`);

  for (const problem of plan.problems) {
    process.stderr.write(
      `${note.bold('nuup:')} ${note.red(`${problem.source ?? 'a source'} — ${problem.text}`)}\n`,
    );
  }
  if (unchecked > 0) {
    process.stderr.write(
      `${note.bold('nuup:')} ${note.yellow(
        `${unchecked} ${plural(unchecked, 'package was', 'packages were')} not checked ` +
          'because a source failed; they are not known to be up to date',
      )}\n`,
    );
  }
}

async function run(argv) {
  const options = parse(argv);

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.SUCCESS;
  }
  if (options.version) {
    process.stdout.write(`${version}\n`);
    return EXIT.SUCCESS;
  }

  const plan = await planUpgrades(process.cwd(), options);
  report(plan, options);

  if (!options.write) {
    if (plan.upgrades.length > 0) {
      process.stderr.write('nuup: nothing was written; pass --write to apply\n');
    }
    // A source that could not be reached leaves the answer incomplete, and
    // saying so with exit 0 would let a sweep treat it as a clean run.
    return plan.problems.length > 0 ? EXIT.RUNTIME : EXIT.SUCCESS;
  }

  const { written, failures } = writeUpgrades(plan.upgrades);
  process.stderr.write(
    `nuup: wrote ${written.length} ${plural(written.length, 'file', 'files')}\n`,
  );
  for (const failure of failures) {
    process.stderr.write(`nuup: could not write ${failure.file} — ${failure.message}\n`);
  }

  return failures.length > 0 || plan.problems.length > 0 ? EXIT.RUNTIME : EXIT.SUCCESS;
}

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(process.exitCode ?? EXIT.SUCCESS);
  process.exit(reportError(error));
});

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error);
}
