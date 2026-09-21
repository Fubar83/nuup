import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paletteFor } from '../src/color.js';
import { tabulate } from '../src/table.js';

const plain = paletteFor({ isTTY: false }, {});
const coloured = paletteFor({ isTTY: true }, {});

const row = (file, name, from, to) => ({ file, package: name, from, to });

/** Where the arrow sits on each row, with any colour taken off. */
const arrows = (lines) =>
  lines
    .map((line) => line.replace(/\x1B\[\d+m/g, ''))
    .filter((line) => line.includes('->'))
    .map((line) => line.indexOf('->'));

test('nothing to show is no table at all', () => {
  assert.deepEqual(tabulate([], plain), []);
});

test('packages sit under the file that holds them', () => {
  const lines = tabulate(
    [row('Api.csproj', 'Serilog', '3.1.1', '3.4.0'), row('Api.csproj', 'Polly', '7.0.0', '7.2.4')],
    plain,
  );

  assert.equal(lines[0], 'Api.csproj');
  assert.match(lines[1], /^ {2}Serilog \.+ 3\.1\.1 -> 3\.4\.0$/);
  assert.match(lines[2], /^ {2}Polly \.+ 7\.0\.0 -> 7\.2\.4$/);
});

test('a blank line separates one file from the next', () => {
  const lines = tabulate(
    [row('a.csproj', 'A', '1.0.0', '1.1.0'), row('b.csproj', 'B', '1.0.0', '1.1.0')],
    plain,
  );

  assert.deepEqual(
    lines.map((line) => (line === '' ? '<blank>' : line.trim().split(' ')[0])),
    ['a.csproj', 'A', '<blank>', 'b.csproj', 'B'],
  );
  assert.notEqual(lines[0], '', 'but not before the first file');
});

// The point of a table: read the new versions straight down the page.
test('every arrow lines up, whatever the names and versions are', () => {
  const lines = tabulate(
    [
      row('f', 'x', '1.0', '2.0'),
      row('f', 'Newtonsoft.Json', '11.0.1', '13.0.4'),
      row('f', 'Serilog', '2.10.0', '4.4.0'),
    ],
    plain,
  );

  const columns = arrows(lines);
  assert.equal(new Set(columns).size, 1, `ragged: ${columns.join(', ')}`);
});

// Colour codes take no space on screen but plenty in a string. Padding by the
// string's length is how a table comes out ragged the moment colour is on.
test('colour does not shift the columns', () => {
  const rows = [
    row('f', 'x', '1.0', '2.0'),
    row('f', 'Newtonsoft.Json', '11.0.1', '13.0.4'),
  ];

  assert.deepEqual(arrows(tabulate(rows, coloured)), arrows(tabulate(rows, plain)));
});

// Without the allowance, the longest name is the one row whose version lands a
// column to the right of every other — the bug this test exists to hold shut.
test('the longest name still gets its dots, and stays in line', () => {
  const lines = tabulate(
    [row('f', 'Newtonsoft.Json', '1.0', '2.0'), row('f', 'xunit', '1.0', '2.0')],
    plain,
  );

  assert.equal(new Set(arrows(lines)).size, 1);
  assert.match(lines[1], /Newtonsoft\.Json \.\.+ /, 'at least two dots');
});

test('a very long name keeps its own row readable rather than widening every other', () => {
  const long = 'A'.repeat(80);
  const lines = tabulate([row('f', long, '1.0', '2.0'), row('f', 'x', '1.0', '2.0')], plain);

  assert.ok(lines[1].includes(long), 'the name is never cut');
  assert.match(lines[1], /A \.\. 1\.0 -> 2\.0$/, 'and falls back to the minimum dots');
});

test('the versions are the text they were given', () => {
  const [, line] = tabulate([row('f', 'P', '1.0.0-rc.1', '2.0.0+build')], plain);
  assert.match(line, /1\.0\.0-rc\.1 -> 2\.0\.0\+build$/);
});

test('with colour, the text still reads the same once the escapes come off', () => {
  const [, line] = tabulate([row('f', 'Serilog', '3.1.1', '3.4.0')], coloured);

  assert.notEqual(line, line.replace(/\x1B\[\d+m/g, ''), 'colour was applied');
  assert.match(line.replace(/\x1B\[\d+m/g, ''), /^ {2}Serilog \.+ 3\.1\.1 -> 3\.4\.0$/);
});
