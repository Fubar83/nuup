import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SKIPPED, planUpgrades, sitesIn, writeUpgrades } from '../src/upgrade.js';

const created = [];
after(() => Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true }))));

async function repo(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'nuup-tests-'));
  created.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const full = path.join(root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

/** A feed answering with fixed versions per package. */
const feed = (catalogue, problems = []) => async (args) => {
  const id = args[2].toLowerCase();
  const versions = Object.entries(catalogue).find(([key]) => key.toLowerCase() === id)?.[1] ?? [];
  return {
    code: 0,
    stdout: JSON.stringify({
      version: 2,
      problems: [],
      searchResult: [
        {
          sourceName: 'test',
          problems,
          packages: versions.map((version) => ({ id: args[2], version })),
        },
      ],
    }),
    stderr: '',
  };
};

const csproj = (body) => `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${body}\n  </ItemGroup>\n</Project>`;
const reasons = (plan) => Object.fromEntries(plan.skipped.map((s) => [s.package, s.reason]));

test('a site is found in every kind of file that can hold one', async () => {
  const root = await repo({
    'src/Api/Api.csproj': csproj('    <PackageReference Include="Serilog" Version="3.1.1" />'),
    'Directory.Packages.props': '<Project><ItemGroup><PackageVersion Include="Polly" Version="7.0.0" /></ItemGroup></Project>',
    'legacy/packages.config': '<packages><package id="Newtonsoft.Json" version="12.0.1" /></packages>',
  });

  const names = sitesIn(root).map((site) => site.package).sort();
  assert.deepEqual(names, ['Newtonsoft.Json', 'Polly', 'Serilog']);
});

test('an upgrade is planned but nothing is written', async () => {
  const source = csproj('    <PackageReference Include="Serilog" Version="3.1.1" />');
  const root = await repo({ 'Api.csproj': source });

  const plan = await planUpgrades(root, { run: feed({ Serilog: ['3.1.1', '3.4.0'] }) });

  assert.equal(plan.upgrades.length, 1);
  assert.deepEqual(
    { package: plan.upgrades[0].package, from: plan.upgrades[0].from, to: plan.upgrades[0].to },
    { package: 'Serilog', from: '3.1.1', to: '3.4.0' },
  );
  assert.equal(readFileSync(path.join(root, 'Api.csproj'), 'utf8'), source, 'planning writes nothing');
});

test('writing applies the plan and changes nothing else', async () => {
  const source = csproj(
    '    <PackageReference Include="Serilog" Version="3.1.1" />\n' +
      '    <PackageReference Include="Polly" Version="7.0.0" />',
  );
  const root = await repo({ 'Api.csproj': source });

  const plan = await planUpgrades(root, {
    run: feed({ Serilog: ['3.4.0'], Polly: ['7.2.4'] }),
  });
  const { written, failures } = writeUpgrades(plan.upgrades);

  assert.equal(written.length, 1, 'one file, written once for both upgrades');
  assert.equal(written[0].count, 2);
  assert.deepEqual(failures, []);

  const after = readFileSync(path.join(root, 'Api.csproj'), 'utf8');
  assert.equal(after, source.replace('3.1.1', '3.4.0').replace('7.0.0', '7.2.4'));
});

test('nothing is locked by default; a lock is opted into', async () => {
  const root = await repo({ 'Api.csproj': csproj('    <PackageReference Include="Serilog" Version="3.1.1" />') });
  const versions = { Serilog: ['3.1.1', '3.4.0', '4.0.0'] };

  const byDefault = await planUpgrades(root, { run: feed(versions) });
  assert.equal(byDefault.upgrades[0].to, '4.0.0', 'the newest there is');

  const locked = await planUpgrades(root, { lock: 'major', run: feed(versions) });
  assert.equal(locked.upgrades[0].to, '3.4.0');
});

test('a filter decides which packages are considered at all', async () => {
  const root = await repo({
    'Api.csproj': csproj(
      '    <PackageReference Include="MyCompany.Core" Version="1.0.0" />\n' +
        '    <PackageReference Include="Serilog" Version="3.1.1" />',
    ),
  });

  const plan = await planUpgrades(root, {
    filters: ['MyCompany.*'],
    run: feed({ 'MyCompany.Core': ['1.1.0'], Serilog: ['4.0.0'] }),
  });

  assert.equal(plan.upgrades.length, 1);
  assert.equal(plan.upgrades[0].package, 'MyCompany.Core');
  assert.equal(plan.skipped.length, 0, 'a filtered-out package is not even reported as skipped');
});

// The four reasons a site is left alone are different things to do about it.
test('up to date and could-not-check are told apart', async () => {
  const root = await repo({
    'Api.csproj': csproj(
      '    <PackageReference Include="Current" Version="2.0.0" />\n' +
        '    <PackageReference Include="Missing" Version="1.0.0" />',
    ),
  });

  const fine = await planUpgrades(root, { run: feed({ Current: ['2.0.0'], Missing: [] }) });
  assert.deepEqual(reasons(fine), { Current: SKIPPED.UP_TO_DATE, Missing: SKIPPED.NOT_FOUND });

  const broken = await planUpgrades(root, {
    run: feed({}, [{ text: 'source unreachable', problemType: 'Error' }]),
  });
  assert.deepEqual(reasons(broken), {
    Current: SKIPPED.UNCHECKED,
    Missing: SKIPPED.UNCHECKED,
  });
  assert.equal(broken.problems.length, 1, 'the failing source is reported once');
});

test('a property or a range is reported, never rewritten', async () => {
  const source = csproj(
    '    <PackageReference Include="Prop" Version="$(CoreVersion)" />\n' +
      '    <PackageReference Include="Range" Version="[1.0,2.0)" />',
  );
  const root = await repo({ 'Api.csproj': source });

  const plan = await planUpgrades(root, { run: feed({ Prop: ['9.9.9'], Range: ['9.9.9'] }) });

  assert.equal(plan.upgrades.length, 0);
  assert.deepEqual(reasons(plan), {
    Prop: SKIPPED.NOT_A_VERSION,
    Range: SKIPPED.NOT_A_VERSION,
  });

  writeUpgrades(plan.upgrades);
  assert.equal(readFileSync(path.join(root, 'Api.csproj'), 'utf8'), source);
});

test('a commented-out reference is never upgraded', async () => {
  const root = await repo({
    'Api.csproj': csproj('    <!-- <PackageReference Include="Ghost" Version="0.0.1" /> -->'),
  });

  const plan = await planUpgrades(root, { run: feed({ Ghost: ['9.9.9'] }) });
  assert.deepEqual(plan.upgrades, []);
  assert.deepEqual(plan.skipped, []);
});

// Under central package management the csproj holds no version at all, so the
// props file is the only place an edit belongs.
test('a central version is upgraded where it is declared', async () => {
  const root = await repo({
    'src/Api/Api.csproj': csproj('    <PackageReference Include="Serilog" />'),
    'Directory.Packages.props':
      '<Project>\n  <ItemGroup>\n    <PackageVersion Include="Serilog" Version="3.1.1" />\n  </ItemGroup>\n</Project>',
  });

  const plan = await planUpgrades(root, { run: feed({ Serilog: ['3.4.0'] }) });

  assert.equal(plan.upgrades.length, 1);
  assert.equal(plan.upgrades[0].file, 'Directory.Packages.props');
  writeUpgrades(plan.upgrades);

  assert.match(readFileSync(path.join(root, 'Directory.Packages.props'), 'utf8'), /Version="3\.4\.0"/);
  assert.match(
    readFileSync(path.join(root, 'src/Api/Api.csproj'), 'utf8'),
    /<PackageReference Include="Serilog" \/>/,
    'the project file never had a version and must not gain one',
  );
});

test('build output is not scanned', async () => {
  const root = await repo({
    'Api.csproj': csproj('    <PackageReference Include="Real" Version="1.0.0" />'),
    'obj/project.assets.csproj': csproj('    <PackageReference Include="Ghost" Version="1.0.0" />'),
  });

  assert.deepEqual(sitesIn(root).map((s) => s.package), ['Real']);
});

test('files are reported with forward slashes, whatever the platform', async () => {
  const root = await repo({
    'src/Api/Api.csproj': csproj('    <PackageReference Include="Serilog" Version="3.1.1" />'),
  });

  const plan = await planUpgrades(root, { run: feed({ Serilog: ['3.4.0'] }) });
  assert.equal(plan.upgrades[0].file, 'src/Api/Api.csproj');
});

// Being on the newest 8.x while 10.x exists is not being up to date. Saying
// so reads as the tool having missed the newer version — which is exactly
// how this was reported.
test('a version the lock excludes is held, not up to date', async () => {
  const root = await repo({
    'Api.csproj': csproj('    <PackageReference Include="M.E.DI" Version="8.0.1" />'),
  });
  const versions = { 'M.E.DI': ['8.0.1', '9.0.20', '10.0.12'] };

  const locked = await planUpgrades(root, { lock: 'major', run: feed(versions) });
  assert.deepEqual(locked.upgrades, []);
  assert.equal(locked.skipped[0].reason, SKIPPED.HELD);
  assert.equal(locked.skipped[0].newest, '10.0.12', 'it says what it is holding back');

  const unlocked = await planUpgrades(root, { lock: 'none', run: feed(versions) });
  assert.equal(unlocked.upgrades[0].to, '10.0.12');
});

test('genuinely newest is up to date, not held', async () => {
  const root = await repo({
    'Api.csproj': csproj('    <PackageReference Include="Current" Version="2.0.0" />'),
  });

  const plan = await planUpgrades(root, { run: feed({ Current: ['1.0.0', '2.0.0'] }) });
  assert.equal(plan.skipped[0].reason, SKIPPED.UP_TO_DATE);
  assert.equal(plan.skipped[0].newest, undefined);
});

test('a ceiling holds things back too, and says so', async () => {
  const root = await repo({
    'Api.csproj': csproj('    <PackageReference Include="P" Version="5.0.0" />'),
  });

  const plan = await planUpgrades(root, {
    lock: '<6.0.0',
    run: feed({ P: ['5.0.0', '5.9.1', '7.0.0'] }),
  });

  assert.equal(plan.upgrades[0].to, '5.9.1', 'it still takes the best below the ceiling');
  assert.deepEqual(plan.skipped, [], 'an upgrade was found, so nothing is held');
});

test('held is reported per site, so nothing is lost in a count', async () => {
  const root = await repo({
    'Api.csproj': csproj(
      '    <PackageReference Include="A" Version="1.0.0" />\n' +
        '    <PackageReference Include="B" Version="1.0.0" />',
    ),
  });

  const plan = await planUpgrades(root, {
    lock: 'major',
    run: feed({ A: ['2.0.0'], B: ['2.0.0'] }),
  });
  assert.equal(plan.skipped.length, 2);
  assert.deepEqual(
    plan.skipped.map((row) => `${row.package}->${row.newest}`).sort(),
    ['A->2.0.0', 'B->2.0.0'],
  );
});
