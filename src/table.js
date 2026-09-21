/** The widest a name column grows before names are simply allowed to be long. */
const NAME_COLUMN = 44;

/**
 * The upgrades as a table, grouped under the file that holds them.
 *
 * Dot leaders rather than spaces: across forty repositories these lists get
 * long, and the eye needs something to follow from a package name to the
 * version beside it.
 *
 * The dots are counted from the name's real length, not its coloured length.
 * Colour codes take no space on screen but plenty in a string, and padding by
 * the latter is how a table comes out ragged the moment colour is on.
 */
export function tabulate(rows, ink) {
  if (rows.length === 0) return [];

  // Wide enough that even the longest name still gets its two dots — without
  // the +1 the floor below kicks in for exactly that name, and its version
  // ends up a column to the right of everyone else's.
  const longest = Math.max(...rows.map((row) => row.package.length));
  const column = Math.min(NAME_COLUMN, longest + 1);
  // The version moved from is padded too, so every arrow lines up and the
  // column of new versions can be read straight down.
  const fromWidth = Math.max(...rows.map((row) => row.from.length));

  const lines = [];
  let file = null;

  for (const row of rows) {
    if (row.file !== file) {
      if (file !== null) lines.push('');
      lines.push(ink.grey(row.file));
      file = row.file;
    }

    const dots = '.'.repeat(Math.max(2, column - row.package.length + 1));
    lines.push(
      `  ${ink.bold(row.package)} ${ink.dim(dots)} ` +
        `${ink.dim(row.from.padEnd(fromWidth))} ${ink.dim('->')} ${ink.green(row.to)}`,
    );
  }

  return lines;
}
