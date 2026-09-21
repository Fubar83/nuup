/**
 * NuGet versions, and which upgrade a version lock permits.
 *
 * NuGet versions are close to SemVer but not the same, and the differences
 * are exactly the ones that go wrong quietly:
 *
 *   - There is a fourth part. `1.2.3.4` is legal, and `1.2.3` means `1.2.3.0`,
 *     so the two compare equal. A SemVer library reads `1.2.3.4` as invalid
 *     or, worse, as `1.2.3`.
 *   - Comparison is case-insensitive. `1.0.0-Beta` and `1.0.0-beta` are the
 *     same version.
 *   - Build metadata is not part of identity. `1.0.0+abc` equals `1.0.0`.
 *
 * Nothing here is lenient about what a version is. A range (`[1.0,2.0)`), a
 * floating version (`1.2.*`) and an MSBuild property (`$(SerilogVersion)`)
 * all parse as null, so a caller has to decide what to do about them rather
 * than being handed a number that looks usable.
 */

const VERSION =
  /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/**
 * Parse a NuGet version, or null if the text is not one.
 *
 * `parts` is always four numbers, so `1.2.3` and `1.2.3.0` become the same
 * thing and no comparison has to think about length.
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = VERSION.exec(text.trim());
  if (!match) return null;

  const [, major, minor, patch, revision, prerelease, metadata] = match;
  return {
    parts: [major, minor, patch, revision].map((part) => Number(part ?? 0)),
    prerelease: prerelease ?? null,
    metadata: metadata ?? null,
    original: text.trim(),
  };
}

export const isPrerelease = (version) => version?.prerelease !== null;

/**
 * Order two prerelease labels.
 *
 * Absent beats present — `1.0.0` is newer than `1.0.0-rc` — and within a
 * label, dot-separated identifiers are compared one at a time: numeric ones
 * numerically and below alphanumeric ones, the rest case-insensitively,
 * because that is what NuGet does.
 */
function comparePrerelease(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const left = a.split('.');
  const right = b.split('.');

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index];
    const other = right[index];
    // A label that ran out is the lower one: `1.0-rc` precedes `1.0-rc.1`.
    if (one === undefined) return -1;
    if (other === undefined) return 1;

    const oneIsNumber = /^\d+$/.test(one);
    const otherIsNumber = /^\d+$/.test(other);
    if (oneIsNumber && otherIsNumber) {
      if (Number(one) !== Number(other)) return Number(one) < Number(other) ? -1 : 1;
      continue;
    }
    if (oneIsNumber !== otherIsNumber) return oneIsNumber ? -1 : 1;

    const lower = one.toLowerCase();
    const otherLower = other.toLowerCase();
    if (lower !== otherLower) return lower < otherLower ? -1 : 1;
  }

  return 0;
}

/** -1, 0 or 1. Build metadata is ignored, as NuGet ignores it. */
export function compareVersions(a, b) {
  for (let index = 0; index < 4; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** The version locks, from the one that permits least to the one that permits most. */
export const LOCKS = ['minor', 'major', 'none'];

/**
 * Read what a `--version-lock` was asked for.
 *
 * Two shapes, because there are two ways to say "not past here". A keyword
 * pins a part of whatever version a project is on, and so means something
 * different for each project. A ceiling names one version and means the same
 * thing everywhere:
 *
 *   major     the major stays; minor and patch may move
 *   minor     the major and minor stay; only the patch may move
 *   none      nothing is pinned
 *   <6.0.0    anything below 6.0.0, so the highest 5.x there is
 *   <=5.9.9   anything up to and including 5.9.9
 *
 * Returns null for anything else, so a caller can complain about it rather
 * than quietly treating a typo as "no limit".
 */
export function parseLock(text = 'major') {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (LOCKS.includes(trimmed.toLowerCase())) return { keyword: trimmed.toLowerCase() };

  const comparator = /^(<=|<)\s*(.+)$/.exec(trimmed);
  if (comparator === null) return null;

  const below = parseVersion(comparator[2]);
  if (below === null) return null;
  return { below, inclusive: comparator[1] === '<=' };
}

/** Whether two versions are the same release, ignoring any prerelease label. */
const sameRelease = (a, b) => a.parts.every((part, index) => part === b.parts[index]);

/**
 * Whether `candidate` is an upgrade `lock` permits over `current`.
 *
 * `lock` is either a string to be read by `parseLock` or one it has already
 * read. An upgrade is never a downgrade, so the current version is always the
 * floor and a lock only ever says how far up to go.
 */
export function allows(current, candidate, lock = 'major') {
  const rule = typeof lock === 'string' ? parseLock(lock) : lock;
  if (!rule) return false;
  if (compareVersions(candidate, current) <= 0) return false;

  if (rule.below) {
    const against = compareVersions(candidate, rule.below);
    if (rule.inclusive ? against > 0 : against >= 0) return false;
    // `<6.0.0` reads as "not 6", and 6.0.0-rc.1 is a 6 by anyone's reading,
    // even though it sorts below 6.0.0. Excluding it is the least surprising
    // answer, and it is the rule npm's semver settled on for the same reason.
    if (!rule.inclusive && isPrerelease(candidate) && sameRelease(candidate, rule.below)) {
      return false;
    }
    return true;
  }

  if (rule.keyword === 'none') return true;
  if (candidate.parts[0] !== current.parts[0]) return false;
  if (rule.keyword === 'major') return true;
  return candidate.parts[1] === current.parts[1];
}

/**
 * The version to move to, or null when nothing qualifies.
 *
 * Prereleases are left out unless asked for — with one exception. A project
 * already on a prerelease is being tracked deliberately, and hiding every
 * newer prerelease from it would answer "nothing to do" while a newer one
 * sits on the feed.
 */
export function pickUpgrade(current, available, { lock = 'major', prerelease = false } = {}) {
  const from = parseVersion(current);
  if (from === null) return null;

  const rule = typeof lock === 'string' ? parseLock(lock) : lock;
  if (rule === null) return null;

  const wantPrerelease = prerelease || isPrerelease(from);

  let best = null;
  for (const text of available) {
    const candidate = parseVersion(text);
    if (candidate === null) continue;
    if (isPrerelease(candidate) && !wantPrerelease) continue;
    if (!allows(from, candidate, rule)) continue;
    if (best === null || compareVersions(candidate, best) > 0) best = candidate;
  }

  return best === null ? null : best.original;
}
