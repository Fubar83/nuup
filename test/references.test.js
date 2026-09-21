import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProject, referencesByProject, referencesIn, projectsUsing } from '../src/references.js';
import { affectedBy } from '../src/upgrade.js';

const csproj = (body) => `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>${body}</ItemGroup></Project>`;

test('an Include is a reference, with or without a version', () => {
  assert.deepEqual(referencesIn(csproj('<PackageReference Include="Serilog" Version="3.1.1" />')), [
    'Serilog',
  ]);
  // Under central package management the project carries no version at all.
  assert.deepEqual(referencesIn(csproj('<PackageReference Include="Serilog" />')), ['Serilog']);
});

// An Update carries a version for a reference declared elsewhere. It does not
// pull the package into anything, so it is not a reference.
test('an Update is not a reference, and neither is a PackageVersion', () => {
  assert.deepEqual(referencesIn(csproj('<PackageReference Update="Serilog" Version="3.1.1" />')), []);
  assert.deepEqual(referencesIn(csproj('<PackageVersion Include="Serilog" Version="3.1.1" />')), []);
});

test('a commented-out reference is not a reference', () => {
  assert.deepEqual(referencesIn(csproj('<!-- <PackageReference Include="Ghost" /> -->')), []);
});

test('a packages.config entry is a reference', () => {
  assert.deepEqual(
    referencesIn('<packages><package id="Serilog" version="2.10.0" /></packages>'),
    ['Serilog'],
  );
});

test('a project is a project, and a shared file is not', () => {
  for (const file of ['Api.csproj', 'a/B.fsproj', 'x.vbproj', 'legacy/packages.config']) {
    assert.equal(isProject(file), true, file);
  }
  for (const file of ['Directory.Packages.props', 'Directory.Build.props']) {
    assert.equal(isProject(file), false, file);
  }
});

// The usual way a repository gives every test project xunit without repeating
// itself: a reference in Directory.Build.props belongs to the projects below.
test('a reference in a shared file belongs to every project below it', () => {
  const projects = referencesByProject([
    { path: 'tests/Directory.Build.props', text: csproj('<PackageReference Include="xunit" />') },
    { path: 'tests/A/A.csproj', text: csproj('') },
    { path: 'src/Api/Api.csproj', text: csproj('<PackageReference Include="Serilog" />') },
  ]);

  assert.deepEqual(projectsUsing(projects, 'xunit'), ['tests/A/A.csproj']);
  assert.deepEqual(projectsUsing(projects, 'Serilog'), ['src/Api/Api.csproj']);
});

test('package names are matched however they are cased', () => {
  const projects = referencesByProject([
    { path: 'A.csproj', text: csproj('<PackageReference Include="Serilog" />') },
  ]);
  assert.deepEqual(projectsUsing(projects, 'serilog'), ['A.csproj']);
  assert.deepEqual(projectsUsing(projects, 'SERILOG'), ['A.csproj']);
});

// Two projects pinning the same package separately are two independent
// upgrades. Showing each under both would be a straight lie.
test('a version inside a project speaks only for that project', () => {
  const projects = referencesByProject([
    { path: 'A.csproj', text: csproj('<PackageReference Include="Newtonsoft.Json" Version="9.0.1" />') },
    { path: 'B.csproj', text: csproj('<PackageReference Include="Newtonsoft.Json" Version="11.0.1" />') },
  ]);

  assert.deepEqual(affectedBy({ path: 'A.csproj', package: 'Newtonsoft.Json' }, projects), [
    'A.csproj',
  ]);
  assert.deepEqual(affectedBy({ path: 'B.csproj', package: 'Newtonsoft.Json' }, projects), [
    'B.csproj',
  ]);
});

test('a central version speaks for every project that references the package', () => {
  const projects = referencesByProject([
    { path: 'src/A/A.csproj', text: csproj('<PackageReference Include="xunit" />') },
    { path: 'src/B/B.csproj', text: csproj('<PackageReference Include="xunit" />') },
    { path: 'src/C/C.csproj', text: csproj('<PackageReference Include="Serilog" />') },
  ]);

  assert.deepEqual(affectedBy({ path: 'Directory.Packages.props', package: 'xunit' }, projects), [
    'src/A/A.csproj',
    'src/B/B.csproj',
  ]);
});

// A nested Directory.Packages.props governs its own subtree and nothing above.
test('a shared version does not speak for projects outside its directory', () => {
  const projects = referencesByProject([
    { path: 'tests/A/A.csproj', text: csproj('<PackageReference Include="xunit" />') },
    { path: 'src/B/B.csproj', text: csproj('<PackageReference Include="xunit" />') },
  ]);

  assert.deepEqual(
    affectedBy({ path: 'tests/Directory.Packages.props', package: 'xunit' }, projects),
    ['tests/A/A.csproj'],
  );
});

test('a version nothing references falls back to the file declaring it', () => {
  const projects = referencesByProject([
    { path: 'A.csproj', text: csproj('<PackageReference Include="Serilog" />') },
  ]);

  // A PackageVersion left behind after the last project using it went away.
  assert.deepEqual(affectedBy({ path: 'Directory.Packages.props', package: 'Orphan' }, projects), [
    'Directory.Packages.props',
  ]);
});
