import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyUpgrades, declarationsIn } from './declarations.js';
import { projectFiles } from './discover.js';
import { availableVersionsFor } from './feed.js';
import { matchesAny } from './glob.js';
import { parseVersion, pickUpgrade } from './version.js';

/**
 * Working out what to change, and then changing it.
 *
 * Deciding is kept apart from writing so the decision can be looked at — and
 * tested — without a file being touched. That separation is the whole shape
 * of the tool: it reports by default, and writes only when asked.
 */

/** Why a site was left alone. Each is a different thing to do about it. */
export const SKIPPED = {
  UP_TO_DATE: 'up-to-date',
  NOT_A_VERSION: 'not-a-version',
  NOT_FOUND: 'not-found',
  UNCHECKED: 'unchecked',
};

const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

/** Every version literal in the repository, with the file it lives in. */
export function sitesIn(directory) {
  const root = path.resolve(directory);
  const sites = [];

  for (const file of projectFiles(root)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // A file that cannot be read is not a site; a sweep should not stop.
      continue;
    }
    for (const site of declarationsIn(text, { file })) {
      sites.push({ ...site, path: relative(root, file) });
    }
  }

  return sites;
}

/**
 * Decide what each site should become.
 *
 * `up-to-date` and `unchecked` are deliberately different answers. A source
 * that could not be reached returns no versions, and calling that "up to
 * date" is how a sweep silently skips every internal package in an estate
 * while reporting success.
 */
export async function planUpgrades(directory, options = {}) {
  const { filters = [], lock = 'major', prerelease = false } = options;
  const repo = path.basename(path.resolve(directory));

  const wanted = sitesIn(directory).filter((site) => matchesAny(site.package, filters));
  const answers = await availableVersionsFor(
    wanted.map((site) => site.package),
    options,
  );

  const upgrades = [];
  const skipped = [];
  const problems = new Map();

  for (const site of wanted) {
    const answer = answers.get(site.package.toLowerCase()) ?? { versions: [], problems: [] };
    for (const problem of answer.problems) {
      problems.set(`${problem.source}|${problem.text}`, problem);
    }

    const row = { repo, file: site.path, package: site.package, from: site.version };

    // A property, a range or a floating version is not something to reason
    // about, and replacing one with a fixed version would change what the
    // file means. Report it and leave it alone.
    if (parseVersion(site.version) === null) {
      skipped.push({ ...row, reason: SKIPPED.NOT_A_VERSION });
      continue;
    }

    if (answer.problems.length > 0 && answer.versions.length === 0) {
      skipped.push({ ...row, reason: SKIPPED.UNCHECKED });
      continue;
    }
    if (answer.versions.length === 0) {
      skipped.push({ ...row, reason: SKIPPED.NOT_FOUND });
      continue;
    }

    const to = pickUpgrade(site.version, answer.versions, { lock, prerelease });
    if (to === null) {
      skipped.push({ ...row, reason: SKIPPED.UP_TO_DATE });
      continue;
    }

    upgrades.push({ ...row, to, start: site.start, end: site.end, absolute: site.file });
  }

  return { repo, upgrades, skipped, problems: [...problems.values()] };
}

/**
 * Write the upgrades out, one file at a time.
 *
 * Every version in a file is spliced in a single pass, from the back, so the
 * file is read once, written once, and comes back byte-identical apart from
 * the versions themselves.
 */
export function writeUpgrades(upgrades) {
  const byFile = new Map();
  for (const upgrade of upgrades) {
    if (!byFile.has(upgrade.absolute)) byFile.set(upgrade.absolute, []);
    byFile.get(upgrade.absolute).push(upgrade);
  }

  const written = [];
  const failures = [];

  for (const [file, edits] of byFile) {
    try {
      const before = readFileSync(file, 'utf8');
      writeFileSync(file, applyUpgrades(before, edits));
      written.push({ file, count: edits.length });
    } catch (error) {
      failures.push({ file, message: error.message });
    }
  }

  return { written, failures };
}
