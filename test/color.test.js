import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paletteFor, supportsColor } from '../src/color.js';

const tty = { isTTY: true };
const pipe = { isTTY: false };

test('a terminal gets colour', () => {
  assert.equal(supportsColor(tty, {}), true);
  assert.match(paletteFor(tty, {}).red('x'), /\[31mx\[0m/);
});

// The rule the pipelines depend on: bytes down a pipe are exactly the bytes
// that would have been written before colour existed.
test('a pipe or a file never gets colour', () => {
  assert.equal(supportsColor(pipe, {}), false);
  assert.equal(paletteFor(pipe, {}).red('x'), 'x');
  assert.equal(supportsColor(undefined, {}), false, 'a missing stream is not a terminal');
});

test('the two streams are decided independently', () => {
  // `nuls > packages.ndjson` still wants a readable summary on the terminal.
  const out = paletteFor(pipe, {});
  const err = paletteFor(tty, {});

  assert.equal(out.enabled, false);
  assert.equal(err.enabled, true);
});

test('NO_COLOR turns it off, whatever its value', () => {
  assert.equal(supportsColor(tty, { NO_COLOR: '1' }), false);
  assert.equal(supportsColor(tty, { NO_COLOR: 'anything' }), false);
  // no-color.org: an empty value does not count as being set.
  assert.equal(supportsColor(tty, { NO_COLOR: '' }), true);
});

test('FORCE_COLOR turns it on where nothing could be detected', () => {
  assert.equal(supportsColor(pipe, { FORCE_COLOR: '1' }), true);
  assert.equal(supportsColor(pipe, {}), false);
});

test('FORCE_COLOR=0 is the explicit off switch, and outranks the rest', () => {
  assert.equal(supportsColor(tty, { FORCE_COLOR: '0' }), false);
  assert.equal(supportsColor(pipe, { FORCE_COLOR: '0', NO_COLOR: '' }), false);
});

test('a terminal that says it can do nothing is believed', () => {
  assert.equal(supportsColor(tty, { TERM: 'dumb' }), false);
});

test('every colour is callable whether or not colour is on', () => {
  const on = paletteFor(tty, {});
  const off = paletteFor(pipe, {});

  for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'grey', 'bold', 'dim']) {
    assert.equal(typeof on[name], 'function', `${name} missing when on`);
    assert.equal(typeof off[name], 'function', `${name} missing when off`);
    assert.equal(off[name]('x'), 'x');
  }
});

test('colouring never changes the text itself', () => {
  const on = paletteFor(tty, {});
  // Stripping the escapes must give back exactly what went in.
  const plain = on.green('3.4.1').replace(/\[\d+m/g, '');
  assert.equal(plain, '3.4.1');
});

test('a number survives being coloured', () => {
  assert.equal(paletteFor(pipe, {}).red(7), '7');
  assert.match(paletteFor(tty, {}).red(7), /7/);
});
