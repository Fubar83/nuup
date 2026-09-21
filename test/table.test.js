import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paletteFor } from '../src/color.js';
import { NAME_COLUMN, tabulate } from '../src/table.js';

const plain = paletteFor({ isTTY: false }, {});
const coloured = paletteFor({ isTTY: true }, {});

const strip = (text) => text.replace(/\x1B\[\d+m/g, '');
const row = (group, name, version, to) => ({ group, name, version, to });

/** Where the version column starts, with any colour taken off. */
const versionColumn = (line) => {
  const bare = strip(line);
  return bare.length - bare.replace(/\.+\s/, '').length;
};

test('nothing to show is no table at all', () => {
  assert.deepEqual(tabulate([], plain), []);
});

test('rows sit under the group that holds them', () => {
  const lines = tabulate(
    [row('Api.csproj', 'Serilog', '3.1.1', '3.4.0'), row('Api.csproj', 'Polly', '7.0.0', '7.2.4')],
    plain,
  );

  assert.equal(lines[0], 'Api.csproj');
  assert.match(lines[1], /^ {2}Serilog \.+ 3\.1\.1 -> 3\.4\.0$/);
  assert.match(lines[2], /^ {2}Polly \.+ 7\.0\.0 -> 7\.2\.4$/);
});

test('a blank line separates one group from the next, but not before the first', () => {
  const lines = tabulate(
    [row('a.csproj', 'A', '1.0.0', '1.1.0'), row('b.csproj', 'B', '1.0.0', '1.1.0')],
    plain,
  );

  assert.deepEqual(
    lines.map((line) => (line === '' ? '<blank>' : line.trim().split(' ')[0])),
    ['a.csproj', 'A', '<blank>', 'b.csproj', 'B'],
  );
});

// The whole reason the column is a constant rather than measured: nuls lists
// every package and nuup lists only the ones with an upgrade, so a width taken
// from each tool's own rows would differ for the same repository.
test('the version column does not move with the rows it was given', () => {
  const few = tabulate([row('f', 'A', '1.0', '2.0')], plain);
  const many = tabulate(
    [row('f', 'A', '1.0', '2.0'), row('f', 'Microsoft.Extensions.Configuration', '1.0', '2.0')],
    plain,
  );

  assert.equal(versionColumn(few[1]), versionColumn(many[1]));
});

test('a row without a target is the same row, minus the target', () => {
  const [, withTarget] = tabulate([row('f', 'Serilog', '3.1.1', '3.4.0')], plain);
  const [, without] = tabulate([{ group: 'f', name: 'Serilog', version: '3.1.1' }], plain);

  assert.equal(withTarget.replace(' -> 3.4.0', ''), without);
});

test('a table with no targets pads nothing, leaving no trailing space', () => {
  const lines = tabulate(
    [
      { group: 'f', name: 'A', version: '1.0' },
      { group: 'f', name: 'B', version: '10.0.0' },
    ],
    plain,
  );

  for (const line of lines.slice(1)) assert.equal(line, line.trimEnd());
});

// The point of a table: read the new versions straight down the page.
test('every arrow lines up, whatever the versions are', () => {
  const lines = tabulate(
    [
      row('f', 'x', '1.0', '2.0'),
      row('f', 'Newtonsoft.Json', '11.0.1', '13.0.4'),
      row('f', 'Serilog', '2.10.0', '4.4.0'),
    ],
    plain,
  );

  const columns = lines.filter((l) => l.includes('->')).map((l) => l.indexOf('->'));
  assert.equal(new Set(columns).size, 1, `ragged: ${columns.join(', ')}`);
});

// Colour codes take no space on screen but plenty in a string. Padding by the
// string's length is how a table comes out ragged the moment colour is on.
test('colour does not shift the columns', () => {
  const rows = [row('f', 'x', '1.0', '2.0'), row('f', 'Newtonsoft.Json', '11.0.1', '13.0.4')];
  const arrows = (lines) =>
    lines.map(strip).filter((l) => l.includes('->')).map((l) => l.indexOf('->'));

  assert.deepEqual(arrows(tabulate(rows, coloured)), arrows(tabulate(rows, plain)));
});

test('a name longer than the column keeps its dots and is never cut', () => {
  const long = 'A'.repeat(NAME_COLUMN + 20);
  const [, line] = tabulate([row('f', long, '1.0', '2.0')], plain);

  assert.ok(line.includes(long), 'the name is never truncated');
  assert.match(line, /A \.\. 1\.0 -> 2\.0$/, 'and falls back to the minimum dots');
});

test('a version worth noticing is marked rather than padded into line', () => {
  const [, line] = tabulate(
    [{ group: 'f', name: 'P', version: '(no version found)', warn: true }],
    coloured,
  );

  assert.notEqual(line, strip(line), 'it carries colour');
  assert.match(strip(line), /\(no version found\)$/);
});

test('the versions are the text they were given', () => {
  const [, line] = tabulate([row('f', 'P', '1.0.0-rc.1', '2.0.0+build')], plain);
  assert.match(line, /1\.0\.0-rc\.1 -> 2\.0\.0\+build$/);
});
