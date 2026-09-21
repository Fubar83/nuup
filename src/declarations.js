/**
 * Finding every place a package version is *written*.
 *
 * This is deliberately not the question `nuls` answers. `nuls` reports what a
 * project effectively references, resolving central versions and inherited
 * ones onto the project that sees them. An editor needs the opposite: the
 * literal text, in the file that holds it, at the offset it sits at.
 *
 * Asking it this way makes central package management fall out for free. A
 * `<PackageReference Include="Serilog" />` under CPM carries no version, so it
 * is not a site and nothing here edits it; the `<PackageVersion>` over in
 * Directory.Packages.props is the site, and it is found in its own right
 * rather than by reasoning about which project inherits it.
 *
 * Offsets are into the original text, so an edit replaces exactly the version
 * and leaves every byte around it — formatting, attribute order, encoding,
 * line endings — untouched.
 */

/**
 * Blank out comment bodies, keeping the length identical.
 *
 * A commented-out reference is not a reference, but the offsets of everything
 * after it still have to be true, so the comments are masked rather than
 * removed. `nuls` strips them outright; it only ever reads.
 */
export function maskComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
}

// The `d` flag gives capture-group offsets, which is what makes a surgical
// edit possible without counting characters by hand.
const ELEMENT = /<(PackageReference|PackageVersion)\s([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/dgi;
const LEGACY = /<package\s([^>]*?)\/?>/dgi;
const ATTRIBUTE = /\b(VersionOverride|Version)\s*=\s*"([^"]*)"/di;
const LEGACY_ID = /\bid\s*=\s*"([^"]*)"/i;
const LEGACY_VERSION = /\bversion\s*=\s*"([^"]*)"/di;
const CHILD = /<Version>([^<]*)<\/Version>/di;
const identifier = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];

/**
 * Every version literal in one file.
 *
 * Each site carries the exact range of the version text — not including the
 * quotes or tags around it — so applying an upgrade is a splice.
 */
export function declarationsIn(text, { file = null } = {}) {
  const masked = maskComments(text);
  const found = [];

  for (const match of masked.matchAll(ELEMENT)) {
    const [, element, tag, body] = match;
    const id = identifier(tag, 'Include') ?? identifier(tag, 'Update');
    if (!id) continue;

    const tagStart = match.indices[2][0];
    const attribute = ATTRIBUTE.exec(tag);

    if (attribute) {
      const [start, end] = attribute.indices[2];
      found.push({
        file,
        package: id,
        version: attribute[2],
        start: tagStart + start,
        end: tagStart + end,
        element,
        attribute: attribute[1],
      });
      continue;
    }

    // `<PackageReference Include="X"><Version>1.2.3</Version></PackageReference>`
    if (body !== undefined) {
      const child = CHILD.exec(body);
      if (child) {
        const bodyStart = match.indices[3][0];
        const [start, end] = child.indices[1];
        found.push({
          file,
          package: id,
          version: child[1],
          start: bodyStart + start,
          end: bodyStart + end,
          element,
          attribute: null,
        });
        continue;
      }
    }

    // No version anywhere on it: central package management holds it, and the
    // site is the PackageVersion elsewhere. Nothing to edit here.
  }

  for (const match of masked.matchAll(LEGACY)) {
    const tag = match[1];
    const id = LEGACY_ID.exec(tag)?.[1];
    const version = LEGACY_VERSION.exec(tag);
    if (!id || !version) continue;

    const tagStart = match.indices[1][0];
    const [start, end] = version.indices[1];
    found.push({
      file,
      package: id,
      version: version[1],
      start: tagStart + start,
      end: tagStart + end,
      element: 'package',
      attribute: 'version',
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * Apply upgrades to a file's text.
 *
 * `upgrades` are `{ start, end, to }`. They are spliced from the back so that
 * earlier offsets stay valid as later ones are replaced, and nothing outside
 * the version ranges is rewritten — the file comes back byte-identical apart
 * from the versions themselves.
 */
export function applyUpgrades(text, upgrades) {
  const ordered = [...upgrades].sort((a, b) => b.start - a.start);

  let result = text;
  for (const { start, end, to } of ordered) {
    result = result.slice(0, start) + to + result.slice(end);
  }
  return result;
}
