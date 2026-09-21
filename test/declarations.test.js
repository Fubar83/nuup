import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyUpgrades, declarationsIn, maskComments } from '../src/declarations.js';

const found = (xml) => declarationsIn(xml).map((d) => `${d.package}@${d.version}`);

/** Replace one package's version, the way the tool will. */
const upgrade = (xml, name, to) => {
  const site = declarationsIn(xml).find((d) => d.package === name);
  return applyUpgrades(xml, [{ start: site.start, end: site.end, to }]);
};

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.1.1" />
    <PackageReference Include="Polly">
      <Version>7.2.4</Version>
    </PackageReference>
  </ItemGroup>
</Project>`;

test('an attribute version is found', () => {
  assert.ok(found(CSPROJ).includes('Serilog@3.1.1'));
});

test('a child-element version is found', () => {
  assert.ok(found(CSPROJ).includes('Polly@7.2.4'));
});

test('the offsets point at exactly the version text', () => {
  const [site] = declarationsIn('<PackageReference Include="Serilog" Version="3.1.1" />');
  assert.equal(site.version, '3.1.1');
  assert.equal(
    '<PackageReference Include="Serilog" Version="3.1.1" />'.slice(site.start, site.end),
    '3.1.1',
  );
});

// The whole point of tracking offsets: everything except the version stays
// byte-for-byte as it was.
test('an upgrade changes the version and nothing else', () => {
  const after = upgrade(CSPROJ, 'Serilog', '3.4.1');

  assert.ok(after.includes('<PackageReference Include="Serilog" Version="3.4.1" />'));
  assert.equal(after.replace('3.4.1', '3.1.1'), CSPROJ, 'not one other byte moved');
});

test('a child-element version upgrades in place too', () => {
  const after = upgrade(CSPROJ, 'Polly', '8.0.0');
  assert.ok(after.includes('<Version>8.0.0</Version>'));
  assert.equal(after.replace('8.0.0', '7.2.4'), CSPROJ);
});

test('several upgrades in one file do not disturb each other', () => {
  const sites = declarationsIn(CSPROJ);
  const after = applyUpgrades(
    CSPROJ,
    sites.map((site) => ({ start: site.start, end: site.end, to: '9.9.9' })),
  );

  assert.ok(after.includes('Version="9.9.9"'));
  assert.ok(after.includes('<Version>9.9.9</Version>'));
  assert.equal(after.match(/9\.9\.9/g).length, 2);
});

// A longer replacement shifts every later offset, which is why edits are
// applied from the back.
test('a replacement of a different length keeps the later ones correct', () => {
  const xml = `<ItemGroup>
    <PackageReference Include="A" Version="1.0" />
    <PackageReference Include="B" Version="2.0" />
  </ItemGroup>`;
  const sites = declarationsIn(xml);
  const after = applyUpgrades(xml, [
    { start: sites[0].start, end: sites[0].end, to: '1.10.100-preview.1' },
    { start: sites[1].start, end: sites[1].end, to: '2.1' },
  ]);

  assert.ok(after.includes('Include="A" Version="1.10.100-preview.1"'));
  assert.ok(after.includes('Include="B" Version="2.1"'));
});

// nuls strips comments; an editor cannot, because the offsets after them have
// to stay true. They are blanked to the same length instead.
test('a commented-out reference is not a site', () => {
  const xml = `<ItemGroup>
    <!-- <PackageReference Include="Ghost" Version="9.9.9" /> -->
    <PackageReference Include="Real" Version="1.0.0" />
  </ItemGroup>`;

  assert.deepEqual(found(xml), ['Real@1.0.0']);
});

test('masking a comment keeps every later offset true', () => {
  const xml = `<!-- hidden --><PackageReference Include="Real" Version="1.0.0" />`;
  assert.equal(maskComments(xml).length, xml.length);

  const [site] = declarationsIn(xml);
  assert.equal(xml.slice(site.start, site.end), '1.0.0');
});

test('a PackageVersion under central package management is a site', () => {
  const props = `<Project>
  <ItemGroup>
    <PackageVersion Include="Serilog" Version="4.2.0" />
  </ItemGroup>
</Project>`;

  const [site] = declarationsIn(props);
  assert.equal(site.package, 'Serilog');
  assert.equal(site.element, 'PackageVersion');
  assert.equal(site.version, '4.2.0');
});

// Under CPM the csproj carries no version at all. It is not a site, and the
// tool must not invent one there — the PackageVersion elsewhere is the site.
test('a reference carrying no version is not a site', () => {
  assert.deepEqual(declarationsIn('<PackageReference Include="Serilog" />'), []);
});

test('an Update spelling is a site, as it sets a version for others', () => {
  const [site] = declarationsIn('<PackageReference Update="Serilog" Version="3.1.1" />');
  assert.equal(site.package, 'Serilog');
  assert.equal(site.version, '3.1.1');
});

test('VersionOverride is the site when a project carries one', () => {
  const [site] = declarationsIn(
    '<PackageReference Include="Serilog" VersionOverride="3.9.9" />',
  );
  assert.equal(site.attribute, 'VersionOverride');
  assert.equal(site.version, '3.9.9');
});

test('packages.config entries are sites', () => {
  const config = `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="Serilog" version="2.10.0" targetFramework="net472" />
  <package id="Newtonsoft.Json" version="12.0.3" targetFramework="net472" />
</packages>`;

  assert.deepEqual(found(config), ['Serilog@2.10.0', 'Newtonsoft.Json@12.0.3']);
  assert.ok(upgrade(config, 'Serilog', '2.12.0').includes('id="Serilog" version="2.12.0"'));
});

// The `<?xml version="1.0"?>` declaration is not a package.
test('the xml declaration is not mistaken for a package', () => {
  const config = `<?xml version="1.0" encoding="utf-8"?>\n<packages></packages>`;
  assert.deepEqual(declarationsIn(config), []);
});

test('attribute order and odd spacing do not hide a version', () => {
  const xml = `<PackageReference Version = "3.1.1"   Include="Serilog"/>`;
  const [site] = declarationsIn(xml);
  assert.equal(site.package, 'Serilog');
  assert.equal(site.version, '3.1.1');
});

test('a version written as a property is reported as written, not resolved', () => {
  const [site] = declarationsIn('<PackageReference Include="X" Version="$(CoreVersion)" />');
  assert.equal(site.version, '$(CoreVersion)');
});

test('sites come back in the order they appear', () => {
  const xml = `<ItemGroup>
    <PackageReference Include="B" Version="1.0" />
    <PackageReference Include="A" Version="2.0" />
  </ItemGroup>`;
  assert.deepEqual(found(xml), ['B@1.0', 'A@2.0']);
});

test('a file with nothing in it yields nothing', () => {
  assert.deepEqual(declarationsIn(''), []);
  assert.deepEqual(declarationsIn('<Project></Project>'), []);
});
