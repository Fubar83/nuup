import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allows,
  compareVersions,
  isPrerelease,
  parseVersion,
  parseLock,
  pickUpgrade,
} from '../src/version.js';

const v = (text) => parseVersion(text);
const order = (a, b) => compareVersions(v(a), v(b));

// The available versions of one package, as a feed would report them.
const FEED = ['3.1.1', '3.1.2', '3.4.0', '3.4.1', '4.0.0', '4.4.0'];

test('a version parses into four parts, however many were written', () => {
  assert.deepEqual(v('3.1.1').parts, [3, 1, 1, 0]);
  assert.deepEqual(v('1.2.3.4').parts, [1, 2, 3, 4]);
  assert.deepEqual(v('1.2').parts, [1, 2, 0, 0]);
});

// The trap a SemVer library falls into: NuGet has a fourth part, and a
// missing part is a zero rather than a difference.
test('a fourth part is a version, not a parse failure', () => {
  assert.notEqual(v('1.2.3.4'), null);
  assert.equal(order('1.2.3', '1.2.3.0'), 0);
  assert.equal(order('1.2.3.4', '1.2.3'), 1);
});

test('build metadata is not part of identity', () => {
  assert.equal(order('1.0.0+abc', '1.0.0'), 0);
  assert.equal(order('1.0.0+abc', '1.0.0+xyz'), 0);
});

test('a prerelease precedes the release it leads to', () => {
  assert.equal(order('1.0.0-rc', '1.0.0'), -1);
  assert.equal(order('1.0.0', '1.0.0-rc'), 1);
  assert.equal(isPrerelease(v('1.0.0-rc')), true);
  assert.equal(isPrerelease(v('1.0.0')), false);
});

test('prerelease labels compare piece by piece', () => {
  assert.equal(order('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(order('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(order('1.0.0-rc', '1.0.0-rc.1'), -1, 'fewer identifiers is lower');
  // Numeric identifiers sort below alphanumeric ones.
  assert.equal(order('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(order('1.0.0-2', '1.0.0-10'), -1, 'numerically, not as text');
});

// NuGet compares case-insensitively; SemVer does not. Getting this wrong
// makes 1.0.0-Beta and 1.0.0-beta two different versions.
test('prerelease labels are case-insensitive', () => {
  assert.equal(order('1.0.0-Beta', '1.0.0-beta'), 0);
  assert.equal(order('1.0.0-BETA', '1.0.0-alpha'), 1);
});

// Anything that is not a plain version must not be mistaken for one, or the
// tool would happily rewrite a range into a fixed version.
test('a range, a float and a property are not versions', () => {
  for (const text of ['[1.0,2.0)', '(1.0,)', '1.2.*', '*', '$(SerilogVersion)', '', 'latest']) {
    assert.equal(parseVersion(text), null, `${text} must not parse as a version`);
  }
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion(null), null);
});

// The lock names what must NOT change.
test('lock major keeps the major and moves the rest', () => {
  assert.equal(pickUpgrade('3.1.1', FEED, { lock: 'major' }), '3.4.1');
});

test('lock minor keeps the major and minor, moving only the patch', () => {
  assert.equal(pickUpgrade('3.1.1', FEED, { lock: 'minor' }), '3.1.2');
});

test('lock none takes the newest there is', () => {
  assert.equal(pickUpgrade('3.1.1', FEED, { lock: 'none' }), '4.4.0');
});

test('major is the default lock, so an unqualified run cannot cross a major', () => {
  assert.equal(pickUpgrade('3.1.1', FEED), '3.4.1');
});

test('an upgrade is never a downgrade, and never a sideways move', () => {
  assert.equal(pickUpgrade('4.4.0', FEED, { lock: 'none' }), null, 'already newest');
  assert.equal(pickUpgrade('3.4.1', FEED, { lock: 'major' }), null, 'newest within the major');
  assert.equal(allows(v('1.0.0'), v('1.0.0'), 'none'), false, 'the same version is not an upgrade');
});

test('prereleases are left out unless asked for', () => {
  const feed = ['1.0.0', '1.1.0', '2.0.0-rc.1'];
  assert.equal(pickUpgrade('1.0.0', feed, { lock: 'none' }), '1.1.0');
  assert.equal(pickUpgrade('1.0.0', feed, { lock: 'none', prerelease: true }), '2.0.0-rc.1');
});

// Somebody on a prerelease chose it. Reporting "nothing to do" while a newer
// prerelease sits on the feed would be answering a question they did not ask.
test('a project already on a prerelease is offered newer prereleases', () => {
  const feed = ['2.0.0-rc.1', '2.0.0-rc.2'];
  assert.equal(pickUpgrade('2.0.0-rc.1', feed), '2.0.0-rc.2');
});

test('a prerelease still upgrades to the release it leads to', () => {
  assert.equal(pickUpgrade('2.0.0-rc.1', ['2.0.0-rc.1', '2.0.0'], { lock: 'major' }), '2.0.0');
});

test('an unparseable current version upgrades to nothing', () => {
  for (const current of ['$(SerilogVersion)', '[1.0,2.0)', '1.2.*']) {
    assert.equal(pickUpgrade(current, FEED, { lock: 'none' }), null);
  }
});

test('junk on the feed is skipped rather than chosen', () => {
  assert.equal(pickUpgrade('1.0.0', ['1.1.0', 'not-a-version', '', '1.2.*'], { lock: 'none' }), '1.1.0');
});

test('an empty feed is not an upgrade', () => {
  assert.equal(pickUpgrade('1.0.0', [], { lock: 'none' }), null);
});

test('the newest allowed version wins, whatever order the feed gave them', () => {
  const shuffled = ['3.4.0', '3.1.2', '4.4.0', '3.4.1', '3.1.1'];
  assert.equal(pickUpgrade('3.1.1', shuffled, { lock: 'major' }), '3.4.1');
});

test('the version that comes back is spelled as the feed spelled it', () => {
  // 3.4 and 3.4.0 are the same version; the file should get what the feed said.
  assert.equal(pickUpgrade('3.1.1', ['3.4'], { lock: 'major' }), '3.4');
});

// A ceiling: "not past here", meaning the same thing for every project,
// where a keyword lock means something different for each one.

const CEILING_FEED = ['3.1.1', '4.2.0', '5.0.0', '5.4.9', '5.9.1', '6.0.0', '6.1.0'];

test('a ceiling takes the highest version below it', () => {
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<6.0.0' }), '5.9.1');
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<5.0.0' }), '4.2.0');
});

test('a ceiling crosses majors freely on the way up', () => {
  // The whole point: 3.1.1 to 5.9.1 is two major bumps, and that is allowed
  // because the ceiling is what was asked for, not the major.
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<6.0.0' }), '5.9.1');
});

test('an inclusive ceiling includes the version it names', () => {
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<=5.4.9' }), '5.4.9');
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<=6.0.0' }), '6.0.0');
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<6.0.0' }), '5.9.1');
});

test('a ceiling at or below the current version permits nothing', () => {
  assert.equal(pickUpgrade('5.9.1', CEILING_FEED, { lock: '<5.0.0' }), null);
  assert.equal(pickUpgrade('6.1.0', CEILING_FEED, { lock: '<6.0.0' }), null);
});

test('whitespace around a ceiling is tolerated', () => {
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '< 6.0.0' }), '5.9.1');
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: ' <=5.4.9 ' }), '5.4.9');
});

test('a ceiling may name a partial version', () => {
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<6' }), '5.9.1');
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<5.5' }), '5.4.9');
});

// `<6.0.0` reads as "not a 6", and 6.0.0-rc.1 is a 6 by anyone's reading even
// though it sorts below 6.0.0. This is the rule npm's semver settled on.
test('a prerelease of the ceiling itself is not below it', () => {
  const feed = ['5.0.0', '6.0.0-rc.1'];
  assert.equal(pickUpgrade('5.0.0', feed, { lock: '<6.0.0', prerelease: true }), null);
  // An inclusive ceiling names 6.0.0 as acceptable, so its prerelease is too.
  assert.equal(pickUpgrade('5.0.0', feed, { lock: '<=6.0.0', prerelease: true }), '6.0.0-rc.1');
});

test('a prerelease below the ceiling is still subject to --prerelease', () => {
  const feed = ['5.0.0', '5.5.0-beta.1'];
  assert.equal(pickUpgrade('5.0.0', feed, { lock: '<6.0.0' }), null, 'off by default');
  assert.equal(pickUpgrade('5.0.0', feed, { lock: '<6.0.0', prerelease: true }), '5.5.0-beta.1');
});

test('the keywords still mean what they meant', () => {
  assert.deepEqual(parseLock('major'), { keyword: 'major' });
  assert.deepEqual(parseLock('NONE'), { keyword: 'none' }, 'a keyword is case-insensitive');
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: 'none' }), '6.1.0');
});

test('a ceiling that is not a version, or a floor, is refused', () => {
  for (const lock of ['<nonsense', '>6.0.0', '>=6.0.0', '6.0.0', '<', '<=', 'patch', '']) {
    assert.equal(parseLock(lock), null, `${lock} should not parse as a lock`);
  }
  assert.equal(pickUpgrade('3.1.1', CEILING_FEED, { lock: '<nonsense' }), null);
});
