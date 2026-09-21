/**
 * Which projects reference a package.
 *
 * This is a different question from "where is its version written", and both
 * are needed for different reasons. The version literal is what gets edited;
 * the projects are what a person reads. Under central package management the
 * two are never the same file — the version sits in Directory.Packages.props
 * and the projects that use it say only `Include`.
 *
 * Answering it needs no version resolution at all, which is what keeps this
 * short: a reference is an `Include`, whether or not a version rides along.
 */

const REFERENCE = /<PackageReference\s([^>]*?)(?:\/>|>[\s\S]*?<\/PackageReference>)/gi;
const LEGACY = /<package\s([^>]*?)\/?>/gi;
const attribute = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];

/** Blank out comments, keeping length, so a commented-out reference is not one. */
const withoutComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));

/**
 * The package ids a file references.
 *
 * `Include` adds a reference; `Update` does not — it only carries a version
 * for a reference declared elsewhere, which is how a shared props file sets a
 * version without pulling the package into anything. `PackageVersion` is a
 * version declaration too, and never a reference.
 */
export function referencesIn(text) {
  const xml = withoutComments(text);
  const found = [];

  for (const [, tag] of xml.matchAll(REFERENCE)) {
    const id = attribute(tag, 'Include');
    if (id) found.push(id);
  }
  for (const [, tag] of xml.matchAll(LEGACY)) {
    const id = attribute(tag, 'id');
    if (id) found.push(id);
  }

  return [...new Set(found)];
}

/** Whether a path is a thing a person would call a project. */
export const isProject = (file) => /\.(cs|fs|vb)proj$/i.test(file) || /packages\.config$/i.test(file);

/** Whether a file is one MSBuild imports on a project's behalf. */
export const isShared = (file) => /directory\.build\.(props|targets)$/i.test(file);

/**
 * Attribute every reference to the projects that see it.
 *
 * A `PackageReference Include` in a Directory.Build.props is the usual way a
 * repository gives every test project xunit without repeating itself, so such
 * a reference belongs to each project at or below that file's directory. A
 * project's own references are its own.
 *
 * `files` are `{ path, text }` with forward-slash paths relative to the root.
 * Returns a Map of project path to the set of package ids it references,
 * lowercased because NuGet ids are case-insensitive.
 */
export function referencesByProject(files) {
  const projects = new Map();
  const shared = [];

  for (const { path, text } of files) {
    const ids = referencesIn(text);
    if (isProject(path)) projects.set(path, new Set(ids.map((id) => id.toLowerCase())));
    else if (isShared(path) && ids.length > 0) shared.push({ path, ids });
  }

  for (const { path, ids } of shared) {
    // "" for a file at the root, so every project is below it.
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const [project, owned] of projects) {
      if (project.startsWith(directory)) {
        for (const id of ids) owned.add(id.toLowerCase());
      }
    }
  }

  return projects;
}

/** The projects referencing `packageId`, in path order. */
export function projectsUsing(projects, packageId) {
  const wanted = packageId.toLowerCase();
  return [...projects]
    .filter(([, ids]) => ids.has(wanted))
    .map(([project]) => project)
    .sort();
}
