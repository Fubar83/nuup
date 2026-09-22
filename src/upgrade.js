import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyUpgrades, declarationsIn } from './declarations.js';
import { projectFiles } from './discover.js';
import { availableVersionsFor } from './feed.js';
import { matchesAny } from './glob.js';
import { isProject, projectsUsing, referencesByProject } from './references.js';
import { parseVersion, pickUpgrade } from './version.js';

/**
 * Working out what to change, and then changing it.
 *
 * Deciding is kept apart from writing so the decision can be looked at — and
 * tested — without a file being touched. That separation is the whole shape
 * of the tool: it reports by default, and writes only when asked.
 */

/**
 * Why a site was left alone. Each is a different thing to do about it, and
 * the distinctions are the point: three of these look like "nothing to do"
 * while meaning something else entirely.
 *
 *   up-to-date     nothing newer exists
 *   held           something newer exists, and the lock excludes it
 *   not-found      no source offers this package at all
 *   unchecked      a source failed, so nothing is known either way
 *   not-a-version  a property or range, which is not ours to rewrite
 */
export const SKIPPED = {
  UP_TO_DATE: 'up-to-date',
  HELD: 'held',
  NOT_A_VERSION: 'not-a-version',
  NOT_FOUND: 'not-found',
  UNCHECKED: 'unchecked',
};

const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

/**
 * Read the repository once, answering both questions it holds.
 *
 * `sites` are the version literals — where an edit goes. `projects` maps each
 * project to the packages it references — what a person reads. Under central
 * package management these never coincide, and conflating them is how a
 * report ends up saying `Directory.Packages.props` to somebody who wanted to
 * know which of their services is on the old version.
 */
export function surveyRepo(directory) {
  const root = path.resolve(directory);
  const sites = [];
  const files = [];

  for (const file of projectFiles(root)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // A file that cannot be read is not a site; a sweep should not stop.
      continue;
    }
    const where = relative(root, file);
    files.push({ path: where, text });
    for (const site of declarationsIn(text, { file })) {
      sites.push({ ...site, path: where });
    }
  }

  return { sites, projects: referencesByProject(files) };
}

/** Every version literal in the repository, with the file it lives in. */
export function sitesIn(directory) {
  return surveyRepo(directory).sites;
}

/**
 * The projects a site speaks for.
 *
 * A version written inside a project is that project's own, however many
 * others reference the same package — two projects pinning Newtonsoft.Json
 * separately are two independent upgrades, and showing each under both would
 * be a straight lie.
 *
 * A version in a shared file speaks for every project below it that
 * references the package, which is the whole point of putting it there. The
 * directory matters: a nested Directory.Packages.props governs its own subtree
 * and nothing above it.
 *
 * A version nothing references — a PackageVersion left behind after the last
 * project using it went away — falls back to the file that declares it,
 * because there is no project to show it under.
 */
export function affectedBy(site, projects) {
  if (isProject(site.path)) return [site.path];

  const directory = site.path.includes('/')
    ? site.path.slice(0, site.path.lastIndexOf('/') + 1)
    : '';
  const using = projectsUsing(projects, site.package).filter((project) =>
    project.startsWith(directory),
  );

  return using.length > 0 ? using : [site.path];
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

  const { sites, projects } = surveyRepo(directory);
  const wanted = sites.filter((site) => matchesAny(site.package, filters));
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
      // "Up to date" and "held back by the lock" both look like nothing to do,
      // and only one of them is. Being on the newest 8.x while 10.x exists is
      // not being up to date, and reporting it that way reads as the tool
      // having missed the newer version. Costs no extra request: the versions
      // are already in hand.
      const unlocked = pickUpgrade(site.version, answer.versions, { lock: 'none', prerelease });
      skipped.push(
        unlocked === null
          ? { ...row, reason: SKIPPED.UP_TO_DATE }
          : { ...row, reason: SKIPPED.HELD, newest: unlocked },
      );
      continue;
    }

    upgrades.push({
      ...row,
      to,
      projects: affectedBy(site, projects),
      start: site.start,
      end: site.end,
      absolute: site.file,
    });
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
