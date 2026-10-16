# Changelog

All notable changes to CatSVN are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-16

First public release.

### Added

- **Sparse working copies.** Connecting creates an empty-depth working copy
  (`svn checkout --depth empty`); content is fetched file by file as you browse
  instead of downloading the whole tree up front.
- **Remote browsing without a checkout.** The remote view lists folders on
  demand through `svn list`, so you can look around a huge repository before
  deciding what to pull down.
- **Single-file preview and editing.** Previews stream from the repository with
  `svn cat` and never touch the disk; editing fetches only that file with
  `svn update --parents`.
- **Folder checkouts at a chosen depth.** Files only, immediate children, the
  full subtree, or a custom number of directory levels.
- **Removing a local checkout.** Drops a folder from the working copy with
  `svn update --set-depth exclude`, releasing the disk space without touching
  the repository.
- **Editing and committing.** Text editing, a unified diff before committing,
  plus update, revert and commit for the current file.
- **Uploads.** Files and folders (including drag and drop from Finder) are
  staged in the working copy with `svn add` and committed as one atomic
  revision. Pending uploads and local uncommitted changes can be reviewed and
  discarded.
- **History.** Repository, folder and file history, with a diff of any revision
  against HEAD.
- **Binary files.** Fetched on demand and handed to the default application
  instead of failing inside the editor.
- **Navigation.** Back and forward through visited folders via the toolbar, the
  mouse side buttons, or `⌘[` / `⌘]`; arrow keys walk the list, `Enter` opens.
- **Bilingual interface** (English / 简体中文) that follows the system language,
  with light and dark appearance and native macOS window vibrancy.

### Notes

- Built for macOS. The DMG in this release contains an Apple Silicon (`arm64`)
  build; there is no Intel build yet.
- The bundle is ad-hoc signed and not notarized, so macOS will warn on first
  launch. See the release notes for the one-line workaround.
- CatSVN requires a Subversion command line client (1.8 or newer) on the
  machine; it is not bundled.

[0.1.0]: https://github.com/iamtorson/CatSVN/releases/tag/v0.1.0
