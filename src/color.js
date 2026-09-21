/**
 * Colour for terminal output, and only for terminal output.
 *
 * Copied between the tools rather than imported: they stay standalone, so a
 * change here belongs in each of them.
 *
 * Two rules decide everything:
 *
 *   - Colour is decided per stream. These tools put data on stdout and
 *     commentary on stderr, and the two are redirected independently —
 *     `nuls > packages.ndjson` still wants a readable summary on the terminal,
 *     and escape codes in the file would be corruption.
 *   - A stream that is not a terminal never gets colour, so a pipe or a file
 *     receives exactly the bytes it would have received before any of this
 *     existed. That is what keeps `nuls | nuls --merge` and
 *     `repwrk foreach --parallel nuls` working.
 *
 * `NO_COLOR` (any non-empty value) turns it off, and `FORCE_COLOR` turns it on
 * where there is no terminal to detect — both as the wider convention has
 * settled them. `FORCE_COLOR=0` is the explicit off switch.
 */

const CODES = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  grey: 90,
  bold: 1,
  dim: 2,
};

const RESET = '[0m';

/** Whether `stream` should be written to in colour. */
export function supportsColor(stream, env = process.env) {
  // An explicit instruction outranks anything that could be detected.
  if (env.FORCE_COLOR === '0') return false;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;

  if (!stream?.isTTY) return false;
  // A terminal that says it cannot do anything is taken at its word.
  if (env.TERM === 'dumb') return false;
  return true;
}

/**
 * The palette for one stream.
 *
 * Every name is always callable, so nothing at a call site has to ask whether
 * colour is on: when it is off, each one simply hands the text back. That is
 * what keeps the formatting code readable, and what makes it impossible to
 * forget the check on one branch.
 */
export function paletteFor(stream, env = process.env) {
  const enabled = supportsColor(stream, env);

  const palette = { enabled };
  for (const [name, code] of Object.entries(CODES)) {
    palette[name] = enabled
      ? (text) => `[${code}m${text}${RESET}`
      : (text) => String(text);
  }
  return palette;
}
