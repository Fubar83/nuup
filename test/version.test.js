import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allows,
  compareVersions,
  isPrerelease,
  parseVersion,
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
