import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Finding the files that can declare a package version.
 *
 * Copied from nuls rather than imported: these tools stay standalone. The two
 * must agree about which files count, or `nuls` would report a package that
 * `nuup` refuses to touch — so a change here belongs in both.
 *
 * Two filters decide what is read, and a file has to pass both: a fixed floor
 * of directories that only ever hold build output, and — inside a repository
 * — the repository's own ignore rules, which are the only thing that knows
 * what *this* repository calls its output.
 */

/** Never worth reading, whatever the repository says about them. */
const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'packages', 'TestResults']);

const PROJECT = /\.(cs|fs|vb)proj$/i;
const PACKAGES_CONFIG = /^packages\.config$/i;
// The files MSBuild imports on its own, and so the ones that can hold a
// version on behalf of a project that does not state one.
const VERSION_SOURCE = /^directory\.(packages\.props|build\.props|build\.targets)$/i;

export const isInteresting = (name) =>
  PROJECT.test(name) || PACKAGES_CONFIG.test(name) || VERSION_SOURCE.test(name);

/** Whether any directory leading to `file` is one never worth reading. */
function underSkipped(file) {
  // git spells every path with forward slashes, on every platform.
  return file.split('/').slice(0, -1).some((segment) => SKIP.has(segment));
}

/**
 * The paths git considers part of the repository: tracked, plus untracked and
 * not ignored. Null when this is not a repository or git is not installed —
 * both ordinary, and the filesystem walk answers for them.
 */
function gitPaths(directory) {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

  if (listed.error || listed.status !== 0) return null;
  return listed.stdout.split('\0').filter(Boolean);
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (SKIP.has(entry.name)) continue;
      try {
        yield* walk(full);
      } catch {
        // A link pointing nowhere, or a directory we may not read.
      }
    } else if (isInteresting(entry.name)) {
      yield full;
    }
  }
}

/** Every file worth reading under `directory`, as the repository sees them. */
export function* projectFiles(directory) {
  const listed = gitPaths(directory);
  if (listed === null) {
    yield* walk(directory);
    return;
  }

  for (const file of listed) {
    if (underSkipped(file)) continue;
    if (!isInteresting(file.slice(file.lastIndexOf('/') + 1))) continue;

    const full = path.join(directory, file);
    // --cached lists a tracked file deleted from the working tree.
    if (existsSync(full)) yield full;
  }
}
