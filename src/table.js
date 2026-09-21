/**
 * The listing table, shared in form by nuls and nuup.
 *
 * Copied between the tools rather than imported: they stay standalone, so a
 * change here belongs in both. What must not drift is the shape — run `nuls`
 * and `nuup` over the same repository and the rows should line up, with nuup
 * adding ` -> <version>` and nothing else.
 *
 * That is why the name column is a fixed width rather than the longest name
 * in the rows. nuls lists every package and nuup lists only the ones with an
 * upgrade, so a width measured from each tool's own rows would come out
 * different for the same repository — which is the one thing this is for.
 *
 * Dot leaders rather than padded spaces: these lists run long, and the eye
 * needs something to follow from a package name across to the version.
 */

/** Where the version column begins. Fixed, so the two tools agree. */
export const NAME_COLUMN = 41;

/** The fewest dots a row ever gets, however long its name. */
const MIN_DOTS = 2;

/**
 * Render rows of `{ group, name, version, to?, warn? }`.
 *
 * `group` heads a block — the project or file the row belongs to. `to` is the
 * version being moved to, which only nuup has. `warn` marks a version worth
 * noticing rather than reading past.
 *
 * Dots are counted from the name's real length, never its coloured length:
 * colour codes take no space on screen but plenty in a string, and padding by
 * the latter is how a table comes out ragged the moment colour is on.
 */
export function tabulate(rows, ink) {
  if (rows.length === 0) return [];

  // Only a table with a target needs its versions padded, and padding them
  // when there is no target would leave trailing spaces on every line.
  const hasTarget = rows.some((row) => row.to);
  const versionWidth = hasTarget ? Math.max(...rows.map((row) => row.version.length)) : 0;

  const lines = [];
  let group = null;

  for (const row of rows) {
    if (row.group !== group) {
      if (group !== null) lines.push('');
      lines.push(ink.grey(row.group));
      group = row.group;
    }

    const dots = '.'.repeat(Math.max(MIN_DOTS, NAME_COLUMN - row.name.length));
    const version = row.warn ? ink.yellow(row.version) : row.version.padEnd(versionWidth);
    const target = row.to ? ` ${ink.dim('->')} ${ink.green(row.to)}` : '';

    lines.push(`  ${ink.bold(row.name)} ${ink.dim(dots)} ${version}${target}`);
  }

  return lines;
}
