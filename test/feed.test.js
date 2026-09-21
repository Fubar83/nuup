import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableVersions, availableVersionsFor } from '../src/feed.js';

/** A stand-in for `dotnet package search`, answering with the shape it really uses. */
const answering = (sources, { code = 0, stderr = '' } = {}) => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { code, stdout: code === 0 ? JSON.stringify({ version: 2, problems: [], searchResult: sources }) : '', stderr };
  };
  return { run, calls };
};

const source = (name, packages, problems = []) => ({ sourceName: name, packages, problems });
const pkg = (id, versions) => versions.map((version) => ({ id, version }));

test('versions come back from every source that answered', async () => {
  const { run } = answering([source('nuget.org', pkg('Serilog', ['3.1.1', '4.0.0']))]);
  const { versions, problems } = await availableVersions('Serilog', { run });

  assert.deepEqual(versions, ['3.1.1', '4.0.0']);
  assert.deepEqual(problems, []);
});

test('the same version from two sources is reported once', async () => {
  const { run } = answering([
    source('nuget.org', pkg('Serilog', ['3.1.1', '4.0.0'])),
    source('corp', pkg('Serilog', ['4.0.0'])),
  ]);
  const { versions } = await availableVersions('Serilog', { run });
  assert.deepEqual(versions, ['3.1.1', '4.0.0']);
});

// The failure that matters most: a private feed being unreachable must never
// look like "this package has no newer version".
test('a source that failed is reported as a problem, not as silence', async () => {
  const { run } = answering([
    source('corp', [], [{ text: 'Unable to load the service index', problemType: 'Error' }]),
  ]);
  const { versions, problems } = await availableVersions('Corp.Thing', { run });

  assert.deepEqual(versions, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].source, 'corp');
  assert.match(problems[0].text, /service index/);
});

test('one source failing does not hide another that answered', async () => {
  const { run } = answering([
    source('corp', [], [{ text: 'down', problemType: 'Error' }]),
    source('nuget.org', pkg('Serilog', ['4.0.0'])),
  ]);
  const { versions, problems } = await availableVersions('Serilog', { run });

  assert.deepEqual(versions, ['4.0.0']);
  assert.equal(problems.length, 1, 'the failure is still worth saying');
});

test('a package nobody has is empty, and not an error', async () => {
  const { run } = answering([source('nuget.org', [])]);
  const { versions, problems } = await availableVersions('Nope', { run });

  assert.deepEqual(versions, []);
  assert.deepEqual(problems, []);
});

// NuGet ids are case-insensitive, and a project file may spell one its own way.
test('a differently cased id is still the package that was asked for', async () => {
  const { run } = answering([source('nuget.org', pkg('serilog', ['4.0.0']))]);
  const { versions } = await availableVersions('Serilog', { run });
  assert.deepEqual(versions, ['4.0.0']);
});

test('a different package in the answer is not mistaken for this one', async () => {
  const { run } = answering([
    source('nuget.org', [...pkg('Serilog', ['4.0.0']), ...pkg('Serilog.Sinks.File', ['6.0.0'])]),
  ]);
  const { versions } = await availableVersions('Serilog', { run });
  assert.deepEqual(versions, ['4.0.0']);
});

test('the query asks for an exact match in machine-readable form', async () => {
  const { run, calls } = answering([source('nuget.org', [])]);
  await availableVersions('Serilog', { run });

  assert.deepEqual(calls[0], ['package', 'search', 'Serilog', '--exact-match', '--format', 'json']);
});

test('prereleases and explicit sources are passed through', async () => {
  const { run, calls } = answering([source('nuget.org', [])]);
  await availableVersions('Serilog', { run, prerelease: true, sources: ['https://corp/v3'] });

  assert.ok(calls[0].includes('--prerelease'));
  assert.deepEqual(calls[0].slice(-2), ['--source', 'https://corp/v3']);
});

test('a missing SDK is said plainly, not as a parse failure', async () => {
  const run = async () => ({ code: 127, stdout: '', stderr: 'spawn dotnet ENOENT' });
  await assert.rejects(availableVersions('Serilog', { run }), /was not found on PATH/);
});

// `dotnet package search` arrived in the .NET 9 SDK; an older one prints a
// complaint and no JSON, which is worth translating.
test('an SDK too old to search says so', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: "Unrecognized command or argument 'search'" });
  await assert.rejects(availableVersions('Serilog', { run }), /needs the \.NET 9 SDK or newer/);
});

test('unreadable output is an error rather than an empty answer', async () => {
  const run = async () => ({ code: 0, stdout: 'not json at all', stderr: '' });
  await assert.rejects(availableVersions('Serilog', { run }), /could not read the answer/);
});

test('each package is asked about once, however often it is mentioned', async () => {
  const { run, calls } = answering([source('nuget.org', pkg('Serilog', ['4.0.0']))]);
  const answers = await availableVersionsFor(['Serilog', 'serilog', 'SERILOG'], { run });

  assert.equal(calls.length, 1, 'one query for one package, whatever the casing');
  assert.deepEqual(answers.get('serilog').versions, ['4.0.0']);
});

test('answers are keyed so any spelling of an id finds them', async () => {
  const { run } = answering([source('nuget.org', pkg('Serilog', ['4.0.0']))]);
  const answers = await availableVersionsFor(['Serilog'], { run });
  assert.ok(answers.has('serilog'));
});

test('no packages is no queries', async () => {
  const { run, calls } = answering([source('nuget.org', [])]);
  const answers = await availableVersionsFor([], { run });

  assert.equal(calls.length, 0);
  assert.equal(answers.size, 0);
});
