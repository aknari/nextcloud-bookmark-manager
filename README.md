# Nextcloud Bookmark Manager

[![MIT license](http://img.shields.io/badge/license-MIT-brightgreen.svg)](http://opensource.org/licenses/MIT) ![GitHub package.json version](https://img.shields.io/github/package-json/v/aknari/nextcloud-bookmark-manager) [![GitHub release (latest by date)](https://img.shields.io/github/v/release/aknari/nextcloud-bookmark-manager?label=latest%20release&logo=github)](https://github.com/aknari/nextcloud-bookmark-manager/releases/latest) ![GitHub All Releases](https://img.shields.io/github/downloads/aknari/nextcloud-bookmark-manager/total)

A Mac App for accessing and managing Nextcloud bookmarks.

> **Fork notice** — This is a maintained fork of [dgmid/nextcloud-bookmark-manager](https://github.com/dgmid/nextcloud-bookmark-manager) by [@dgmid](https://github.com/dgmid).
> All credit for the original app — concept, design, code and EN/IT translations — belongs to the original author.
> Upstream has been inactive for some time, so this fork carries the project forward with fixes and improvements,
> in the hope of being useful to the people who still rely on the app today.

## Downloads

Prebuilt macOS binaries (Apple Silicon `arm64`) are available on the [Releases](https://github.com/aknari/nextcloud-bookmark-manager/releases) page.

> The builds are **unsigned** — on first launch, right-click the app and choose **Open** (macOS Gatekeeper).

![ncbm-2 0 3-light](https://user-images.githubusercontent.com/1267580/81381652-55e69a80-910d-11ea-9c6a-8247512325a0.png)
<small>*dark mode*</small>

![ncbm-2 0 3-dark](https://user-images.githubusercontent.com/1267580/81381733-77e01d00-910d-11ea-8385-3783ba81b0bf.png)
<small>*light mode*</small>

## What's changed in this fork (vs upstream)

- **v3.0.x**: upgraded to **Electron 34**, added **AI-assisted bookmark management** (Auto-Tag, Auto-Organize with destination folders and learned-structure profiles, Repair Titles — bring your own Gemini/OpenRouter/local API key), favicons on demand and a smarter Check Broken Links
- **Auto-Organize move semantics**: bookmarks already organized in the destination are withdrawn from the source folder on Apply; empty source/destination folders can be cleaned up afterwards
- Settings such as "Max items per folder" are remembered across sessions
- Fixed a renderer crash in packaged builds and a full-refresh timeout on large accounts
- Packaging works on modern Node (`@electron/packager` 20)

See the [release notes](https://github.com/aknari/nextcloud-bookmark-manager/releases) for details.

## Requirements

[node.js / npm](https://www.npmjs.com/get-npm)
A server running [Nextcloud](https://nextcloud.com/) with the [Bookmarks](https://github.com/nextcloud/bookmarks) app installed

No global installs are needed — `npm install` brings everything (including `@electron/packager`) as dev dependencies:

```shell
npm install
```

## Quick Start

`cd` to the project directory and run:
```shell
npm install
```

To test the app (run from source):
```shell
npm start
```

## Building

### Compile source to `dist/`

The `gulp build` task compiles everything (SCSS → CSS, minifies HTML/JS, copies assets and i18n):
```shell
npx gulp build
```

### Clean `dist/`
```shell
npx gulp clean
```

> **Note:** `npx gulp build` already runs `clean` automatically as its first step, so you don't need to clean before compiling.

### Watch mode (development)

Automatically rebuild HTML/CSS/JS when source files change:
```shell
gulp watch
```

## Packaging

### Build the `.app` bundle

To package the app into a standalone macOS `.app`:
```shell
npm run package
```

This command:
1. Runs `gulp build` to compile everything
2. Packages with `electron-packager` into `build/` (Apple Silicon `arm64` only) — dev dependencies are pruned from the packaged app automatically via `--prune`

The packaged app will be written to:
```
build/Nextcloud Bookmark Manager-darwin-arm64/
```

> To build for Intel Macs (x64) or a universal binary, modify the `package` script in `package.json`:
> - `--arch=x64` for Intel only
> - `--arch=universal` for both architectures

### Package for Linux

The app only uses cross-platform Electron APIs, so the Linux build can be produced **from the same macOS machine** (no extra tools needed). First compile `dist/`, then package with `electron-packager`:

```shell
npx gulp build
npx electron-packager . --platform=linux --arch=x64 --icon=dist/assets/icon/icon.png --ignore="app-source|gulpfile\.js|README\.md" --out=build
```

> The Linux icon is `dist/assets/icon/icon.png` (already in the repo). For 32-bit or ARM builds, use `--arch=ia32` / `--arch=arm64`.

The packaged app will be written to:
```
build/Nextcloud Bookmark Manager-linux-x64/
```

### Package for Windows

The Windows build can **also** be produced from macOS, but it needs **Wine** installed (electron-packager uses it to stamp the icon/version metadata onto the `.exe`):

```shell
# install Wine first (macOS)
brew install --cask wine-stable

npx gulp build
npx electron-packager . --platform=win32 --arch=x64 --icon=dist/assets/icon/icon.ico --ignore="app-source|gulpfile\.js|README\.md" --out=build
```

> The `.ico` icon is generated automatically by `gulp build` (the `ico` task packs the app icon PNGs from the AppIcon set into `dist/assets/icon/icon.ico`) — no need to create one by hand.
>
> The simplest alternative is to run the same command on an actual **Windows machine** — Wine is then not needed. A CI service (e.g. GitHub Actions with a `windows-latest` runner) also works well.

The packaged app will be written to:
```
build/Nextcloud Bookmark Manager-win32-x64/
```

### A note about unsigned builds

None of these builds are code-signed:

- **macOS** — on first launch, right-click the app and choose **Open** (Gatekeeper warning).
- **Windows** — SmartScreen may show a warning when launching an unsigned `.exe`.
- **Linux** — no signing is required.

### Clean the packaged app
```shell
rm -rf build/
```

## i18n
Translations for this app are by:

| language | translator |
| --- | --- |
| EN | [dgmid](https://github.com/dgmid) |
| IT | [dgmid](https://github.com/dgmid) |
| ES | [@aknari](https://github.com/aknari) |

## Credits

- **[@dgmid](https://github.com/dgmid)** — original author of the Nextcloud Bookmark Manager: app, design, code, EN/IT translations. This fork exists thanks to his work.
- The original project lives at [dgmid/nextcloud-bookmark-manager](https://github.com/dgmid/nextcloud-bookmark-manager).
