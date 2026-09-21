import { spawn } from 'node:child_process';
import { RuntimeError } from './errors.js';

/**
 * Asking the configured feeds which versions of a package exist.
 *
 * `dotnet package search` is the whole reason this tool can work where
 * `dotnet outdated` cannot. It answers from the sources NuGet.config defines,
 * with the SDK doing credentials, source mapping and the rest — and it needs
 * no project, no restore and no successful build. A repository whose feeds
 * are half-broken still gets an answer for the packages that resolve.
 *
 * Two behaviours matter and are relied on here:
 *
 *   - A source that fails does not fail the query. It comes back with its own
 *     `problems` entry and the other sources still answer.
 *   - A package nobody has comes back as an empty list, not an error.
 *
 * Which is why "no versions" and "could not look" must never be confused: a
 * private feed being down would otherwise read as "nothing to upgrade", and a
 * sweep would quietly skip every internal package in the estate.
 */

/** How many packages to ask about at once. One query costs about a second. */
export const CONCURRENCY = 8;

/** The SDK command, factored out so tests can answer for it. */
export function runDotnet(args) {
  return new Promise((resolve) => {
    const child = spawn('dotnet', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (error) =>
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: error.message }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function searchArgs(packageId, { prerelease = false, sources = [] } = {}) {
  const args = ['package', 'search', packageId, '--exact-match', '--format', 'json'];
  if (prerelease) args.push('--prerelease');
  for (const source of sources) args.push('--source', source);
  return args;
}

/**
 * Every version of one package the sources offer, and every source that could
 * not be asked.
 *
 * Returns `{ versions, problems }`. `problems` being non-empty means the
 * answer is incomplete, whatever `versions` says.
 */
export async function availableVersions(packageId, options = {}) {
  const { run = runDotnet } = options;
  const { code, stdout, stderr } = await run(searchArgs(packageId, options));

  if (code === 127) {
    throw new RuntimeError(
      'dotnet (the .NET SDK) was not found on PATH. nuup asks it which package versions exist; ' +
        'install it from https://dotnet.microsoft.com/download',
      { component: 'feed' },
    );
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    // An SDK without `package search` says so on stderr and prints no JSON.
    const hint = /package search|Unrecognized command|not a valid/i.test(stderr)
      ? '. `dotnet package search` needs the .NET 9 SDK or newer'
      : '';
    throw new RuntimeError(
      `could not read the answer from \`dotnet package search\`${hint}`,
      { component: 'feed' },
    );
  }

  const versions = [];
  const problems = [];

  for (const result of payload.searchResult ?? []) {
    for (const problem of result.problems ?? []) {
      problems.push({ source: result.sourceName, text: problem.text });
    }
    for (const found of result.packages ?? []) {
      // --exact-match still matches case-insensitively, which is right: NuGet
      // ids are case-insensitive, and a file may spell one differently.
      if (found.version && found.id?.toLowerCase() === packageId.toLowerCase()) {
        versions.push(found.version);
      }
    }
  }

  for (const problem of payload.problems ?? []) {
    problems.push({ source: null, text: problem.text ?? String(problem) });
  }

  return { versions: [...new Set(versions)], problems };
}

/**
 * Ask about many packages at once, asking about each one only once however
 * many repositories or files mention it.
 */
export async function availableVersionsFor(packageIds, options = {}) {
  const { concurrency = CONCURRENCY } = options;
  // NuGet ids are case-insensitive, so fold before deduplicating or the same
  // package gets queried twice and cached under two keys.
  const unique = [...new Map(packageIds.map((id) => [id.toLowerCase(), id])).values()];

  const answers = new Map();
  let next = 0;

  const worker = async () => {
    for (let index = next++; index < unique.length; index = next++) {
      const id = unique[index];
      answers.set(id.toLowerCase(), await availableVersions(id, options));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()),
  );

  return answers;
}
