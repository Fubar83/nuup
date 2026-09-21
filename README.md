# nuup

Upgrade the NuGet packages a repository references, by editing the files that declare them. No restore, no build, no project evaluation.

`nu(get)` `up(grade)`.

```console
$ nuup -f "MyCompany.*"
src/Api/Api.csproj: MyCompany.Core 1.4.0 -> 1.6.2
Directory.Packages.props: MyCompany.Messaging 2.0.1 -> 2.3.0
nuup: 2 to upgrade, 7 up to date, 1 not a plain version
nuup: nothing was written; pass --write to apply
```

## Why this exists

`dotnet outdated` needs the project to restore. Across an estate that is all-or-nothing: one unreachable feed, one pinned SDK, one unsupported target framework, and the whole repository reports nothing — including the packages that would have resolved perfectly.

```console
$ dotnet outdated      # one private feed is down
error NU1301: Unable to load the service index for source https://nuget.corp.example/v3/index.json
Failed to restore App.csproj — exit code: 1

$ nuup                 # same repository, same moment
App.csproj: Serilog 3.1.1 -> 3.4.0
nuup: 1 to upgrade, 1 could not be checked
nuup: 1 package was not checked because a source failed; it is not known to be up to date
```

`nuup` reads the project files directly and asks the feeds which versions exist. A repository that will never restore on your machine is still answerable.

**It is not Renovate or Dependabot.** Those are the right answer for continuous, per-repository, bot-driven updates. This is for the other thing: a campaign across an estate you have just cloned, where you want to build and verify before anything leaves your machine.

## Requirements

- The [.NET SDK](https://dotnet.microsoft.com/download), version 9 or newer — `nuup` asks `dotnet package search` which versions exist
- `git`, so a repository's ignore rules can be honoured
- Node.js 22 or newer

## Install

```bash
npm install -g @fub4r/nuup
```

## The whole parameter surface

```
nuup
  -f,  --filter <glob>          (repeatable)
  -vl, --version-lock <major|minor|none|"<6.0.0"|"<=5.9.9">
       --prerelease
  -w,  --write
  -j,  --json
  -h,  --help
```

`nuup` edits files and stops. It never restores, builds, commits, pushes or opens a pull request — verifying the change is yours.

### `--filter <glob>`

Package names, anchored and case-insensitive: `MyCompany.*` matches `MyCompany.Core` but not `Contrib.MyCompany.Core`. Repeatable, and repeats are OR-ed:

```bash
nuup -f "MyCompany.*" -f "Serilog*"
```

Omitted, every package is considered.

### `--version-lock <lock>`

How far up to go. Two shapes, because there are two ways to say "not past here".

**A keyword** pins a part of whatever version each project is already on, so it means something different for each of them. On `3.1.1`, with 3.1.2, 3.4.0 and 4.4.0 available:

| lock | picks | |
|---|---|---|
| `major` | 3.4.0 | the major stays; minor and patch move — **the default** |
| `minor` | 3.1.2 | major and minor stay; only the patch moves |
| `none` | 4.4.0 | nothing pinned, major bumps included |

**A ceiling** names one version and means the same thing everywhere. On `3.1.1`, with 4.2.0, 5.0.0, 5.9.1, 6.0.0 and 6.1.0 available:

| lock | picks | |
|---|---|---|
| `"<6.0.0"` | 5.9.1 | the highest 5.x there is |
| `"<5.0.0"` | 4.2.0 | the highest 4.x there is |
| `"<=5.4.9"` | 5.4.9 | up to and including the version named |

A ceiling will cross majors on the way up — `3.1.1` to `5.9.1` is two major bumps — because the ceiling is what you asked for, not the major. That is the point of it: *get as current as you can without going into 6*.

> **Quote it.** `<` is a redirection operator in every shell. `nuup -vl <6.0.0` never reaches nuup at all — bash reports `6.0.0: No such file or directory`, and cmd and PowerShell fail their own way. Write `-vl "<6.0.0"`.

A partial version works (`"<6"` is the same as `"<6.0.0"`), and a floor is refused: an upgrade never goes below where it started, so `">=5.0.0"` would add nothing.

The default is `major`, so an unqualified run can never cross a major boundary. That differs from `dotnet outdated`, which defaults to none — the difference matters more when a tool is editing forty repositories at once.

There is no `patch`: locking the patch would pin all three parts and permit nothing. Passing it says so and suggests `--version-lock minor`, which is how you ask for patch-only updates.

### `--prerelease`

Consider prerelease versions. A package already **on** a prerelease is offered newer prereleases regardless — somebody chose that, and hiding the newer ones would answer a question they did not ask.

### `--write`

Apply the upgrades. Without it nothing is written: `nuup` prints what it would do and exits.

Only the version text is replaced, at the exact offset it sits at. Formatting, attribute order, comments, encoding and line endings come back byte-identical, so `git diff` shows the versions and nothing else.

## What it will not touch

- **Commented-out references.** A commented-out reference is not a reference.
- **MSBuild properties.** `Version="$(CoreVersion)"` is reported as `not a plain version` and left alone — the literal lives in a property, and rewriting it into a fixed version would change what the file means.
- **Ranges and floating versions.** `[1.0,2.0)` and `1.2.*` have no single meaning for "upgrade", so they are reported rather than guessed at.
- **Anything a repository ignores**, or that sits under `bin`, `obj`, `node_modules`, `.vs`, `packages` or `TestResults`.

## Central package management

A `<PackageReference Include="Serilog" />` under CPM carries no version, so it is not a site and nothing is written there. The `<PackageVersion>` in `Directory.Packages.props` is the site, and that is where the edit lands. `packages.config`, `Directory.Build.props` and `Directory.Build.targets` are all read the same way: `nuup` edits wherever a version is actually written.

## Up to date is not the same as unchecked

If a source fails, the packages it serves come back with no versions. Reporting that as "up to date" is how a sweep silently skips every internal package in an estate and still exits 0. `nuup` tells them apart, says which source failed, and exits non-zero:

```console
nuup: 3 to upgrade, 12 up to date, 4 could not be checked
nuup: corp-feed — Unable to load the service index for source https://nuget.corp.example/v3/index.json
nuup: 4 packages were not checked because a source failed; they are not known to be up to date
```

## Across many repositories

```bash
repwrk clone -o my-org -t my-team -b chore/bump-packages
repwrk foreach nuup -f "MyCompany.*" --write
repwrk foreach --parallel dotnet build
repwrk foreach git commit -am "Bump internal packages"
```

`nuls` lists what an estate references; `nuup` changes it. They are separate tools on purpose, and neither depends on the other.

## Exit codes

| | |
|---|---|
| `0` | Success |
| `1` | A source could not be reached, or a file could not be written |
| `2` | Usage error |

A run where some source failed exits `1` even when the upgrades it did find were applied, so a script cannot mistake a partial answer for a complete one.

## Licence

MIT
