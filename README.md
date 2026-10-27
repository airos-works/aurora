# Aurora

Aurora runs Electron apps on Haiku and KunanyiOS. The name comes from the
aurora australis, which is made by electrons.

Electron itself is Chromium plus Node.js, and Chromium does not run on Haiku.
Aurora keeps the part apps are written against, the `electron` module, and
supplies the rest natively:

- **Main process:** Node.js runs the app's main script unchanged. `require('electron')`
  and `import { app, BrowserWindow } from 'electron'` load Aurora's
  implementation (`runtime/lib/electron`).
- **Windows:** every `BrowserWindow` is a native Haiku window in `aurora-host`
  (`host/`), a small BApplication. Its page is drawn by Summit's WebKit
  engine, which will also be the system browser's engine.
- **Pages:** the renderer modules (`ipcRenderer`, `contextBridge`, `webFrame`)
  and the app's preload scripts are injected at document start, and talk to
  the main process through the engine's script message handler (see
  `engine-api/`). Pages run in WebKit, a Safari-class engine, not Chromium.
- **Native parts:** menus, dialogs, the clipboard, notifications and file
  panels are Haiku's own.

```
 Node.js  ──  electron module ──  JSON lines  ──  aurora-host (BApplication)
 (app main)   runtime/lib                          │  BWindow + BMenuBar
                                                   │  BWebKitView (Summit WebKit)
                                                   └─ page: preload, ipcRenderer
```

<!-- airos-ci:latest-builds:start -->
## Latest builds

Built automatically by air/OS CI from commit `6fbe772` on 2026-10-27 ([all files](https://github.com/jmgasper/aurora/releases/tag/latest)).

| Architecture | Package |
|---|---|
| arm64 | [aurora-0.3.0-5-arm64.hpkg](https://github.com/jmgasper/aurora/releases/download/latest/aurora-0.3.0-5-arm64.hpkg) |
| x86_64 | [aurora-0.3.0-5-x86_64.hpkg](https://github.com/jmgasper/aurora/releases/download/latest/aurora-0.3.0-5-x86_64.hpkg) |

Install with `pkgman install <file>`, or copy the file into `/boot/system/packages`. Haiku SDK: x86_64 hrev60207-2036-g3d3d333c06, arm64 hrev60207-2036-g3d3d333c06.
<!-- airos-ci:latest-builds:end -->

## Running an app

```sh
aurora path/to/app            # a folder with package.json
aurora path/to/app.asar       # unpacked once into ~/config/cache/Aurora
aurora --dev path/to/app      # app.isPackaged is false
```

`electron` is the same command, so `npm start` scripts that run `electron .`
work. The engine comes from `AURORA_WEBKIT_BUNDLE`, from
`~/config/settings/Aurora/settings.json` (`{"webkitBundle": ...}`), or from the
shared engine install: `/boot/system/lib/summit-webkit` (a future package) or
`~/config/non-packaged/lib/summit-webkit`.

pgAdmin 4 runs on Summit's modern engine in its desktop mode. You get its
native menus and file panels, a second window for its runtime settings, the
Query Tool against PostgreSQL, and its quit confirmation. Older engines (see
Building) show windows, menus and dialogs, but pages cannot reach the main
process there.

Code - OSS (VS Code) runs as an air/OS app: its fork
([jmgasper/vscode](https://github.com/jmgasper/vscode), branch `haiku`,
`build/haiku`) builds a package with the workbench, extension host, terminal
and file watching of the Linux build, on utility processes and message ports.

GitHub Desktop runs as a Haiku app: its fork
([jmgasper/desktop](https://github.com/jmgasper/desktop), branch `haiku`)
builds a package that uses Haiku's own Git. Its pages have Node.js
(`nodeIntegration`), its credentials go to Haiku's key store, and the
browser hands it back the sign-in link.

Discord's own desktop client also runs, unmodified, up to its login screen
(`docs/DISCORD.md`). Its installer, `ports/discord`, downloads the client from
Discord's servers onto the user's machine. Voice and video need Discord's
closed-source Linux libraries, so they do not work.

An app packaged for Haiku is a folder containing a copy of `aurora-host`
named after the app, with the app's icon and signature, plus `aurora.json`
and the app itself. Deskbar starts that copy, which runs the runtime as its
child (`host/Launcher.h`). `ports/pgadmin4` is the example: pgAdmin 4 with
its Python server.

## What works

- **Supported:**
  - **Windows:** `app` lifecycle and quit rules, paths, the single-instance
    lock and relaunch; `BrowserWindow` with options, events and state;
    frameless windows that move by their `-webkit-app-region: drag` areas;
    `webContents` loading, navigation, events, `executeJavaScript`, `send`,
    zoom, find and edit commands, and `setWindowOpenHandler` with scriptable
    `window.open` children.
  - **IPC and pages:** `ipcMain`/`ipcRenderer` (send, invoke, sendSync, on),
    `contextBridge`; Electron's silent `beforeunload` with
    `will-prevent-unload`.
  - **Native UI:** `Menu` and `MenuItem` with roles and accelerators, context
    menus and pop-ups; `dialog` (Tracker file panels and alerts, including the
    *Sync variants); `<input type=file>` panels.
  - **System services:** `clipboard`, `shell`, `screen`, `nativeTheme`,
    `Notification`, `Tray` (an icon in Deskbar's tray with its context
    menu), `protocol.handle` and custom schemes, downloads, `safeStorage`,
    `net.fetch`.
  - **Processes and ports:** `utilityProcess.fork` runs a Node.js child that
    looks like Electron's utility process (`process.parentPort`, `type`
    `utility`, the app's platform and native stand-ins). `MessageChannelMain`
    ports travel between the main process, pages (`webContents.postMessage`,
    `ipcRenderer.postMessage`, where they arrive as DOM `MessagePort`s) and
    utility processes, in either direction; the main process relays their
    messages, and a port closes when the page or child holding its peer goes.
  - **Node.js in pages:** a window with `sandbox: false` or
    `nodeIntegration` gets the Node.js modules its preload requires; with
    `nodeIntegration` and no `contextIsolation`, the page's own scripts get
    `require`, `module`, `process`, `Buffer`, `global`, `setImmediate` and
    `__dirname`, as webpack's `electron-renderer` bundles expect. Pure
    JavaScript modules (Buffer, streams, events, util, path, url, assert)
    are the page's own (`runtime/lib/renderer/node-polyfills.js`); fs,
    child_process, net, crypto and the rest are the main process's, with
    child processes, sockets and servers as emitters and streams of the page.
    A `file:` page starts its workers from its own files, and a native
    module loads in the main process (`process.dlopen`).
  - **Native module stand-ins:** keytar keeps passwords in Haiku's key store
    (`runtime/lib/shims/keytar.js`, through the host, which keystore_server
    knows as the app); `AURORA_NATIVE_SHIMS` adds an app's own.
  - **Links:** `app.setAsDefaultProtocolClient` makes a packaged app the
    preferred application for its scheme's links, which browsers offer; the
    link starts the app again, and the first instance gets it through
    `second-instance`.
  - **Sessions:** partitions, `session.cookies` (get, set and remove,
    HttpOnly included) and `clearStorageData`/`clearCache`/`clearData`. An
    origin limits clearing to that origin's cookies.
- **Present but inert:** `webRequest` hooks, `globalShortcut`, `powerMonitor`, `autoUpdater` (packages update through
  pkgman), `crashReporter`, DevTools.
- **Not available:** `BrowserView`/`WebContentsView`, `desktopCapturer`,
  printing, native Node modules built for Linux (rebuild them for Haiku), and
  Chromium-only web features.

## Building

The host builds natively on Haiku against a Summit engine bundle:

```sh
make WEBKIT_BUNDLE=/path/to/summit/bundle
make WEBKIT_BUNDLE=/path/to/older/bundle LEGACY_ENGINE=1   # engines before 2026-09-21
tools/package-haiku.sh                                     # aurora-*.hpkg
```

air/OS CI ([jmgasper/airos-ci](https://github.com/jmgasper/airos-ci),
`build_aurora`) cross-builds the same package on every push to `main`
(`.github/workflows/airos.yml`), and the x86_64 air/OS images include it with
HaikuPorts' Node.js 22. Raise `REVISION` in `tools/package-haiku.sh` for a new
package of the same version.

The runtime is plain JavaScript (Node.js 20.6 or later). Its tests run on any
machine, against a mock host that speaks the host's protocol (`npm test` in
`runtime` also runs the page side of Node.js integration in a vm context):

```sh
cd runtime
AURORA_HOST=$PWD/tests/mock-host.js node lib/main.js tests/apps/basic
```

On Linux, `tools/cross-check.sh` compile-checks the host with the Haiku cross
compiler. `docs/PROTOCOL.md` describes the runtime–host protocol.
`AURORA_TRACE=1` logs it, `AURORA_TRACE_REMOTE=1` the pages' Node.js
requests, `AURORA_PAGE_CONSOLE=1` copies pages' console messages and
uncaught errors to stderr, and `AURORA_REPL=<socket>` with
`runtime/tools/aurora-repl.js` evaluates expressions in a running app.
`runtime/tools/node-polyfills/build.sh` regenerates the pages' Node.js
modules from pinned npm packages.

## Licence

MIT. `host/vendor/nlohmann` is nlohmann/json (MIT). The engine additions in
`engine-api/` are BSD-2-Clause, like the Haiku WebKit port they patch.
