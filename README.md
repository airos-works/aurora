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

An app packaged for Haiku is a folder containing a copy of `aurora-host`
named after the app, with the app's icon and signature, plus `aurora.json`
and the app itself. Deskbar starts that copy, which runs the runtime as its
child (`host/Launcher.h`). `ports/pgadmin4` is the example: pgAdmin 4 with
its Python server.

## What works

- **Supported:**
  - **Windows:** `app` lifecycle and quit rules, paths, the single-instance
    lock and relaunch; `BrowserWindow` with options, events and state;
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
    `Notification`, `protocol.handle` and custom schemes, downloads,
    `safeStorage`, `net.fetch`, `utilityProcess`.
  - **Sessions:** partitions, `session.cookies` (get, set and remove,
    HttpOnly included) and `clearStorageData`/`clearCache`/`clearData`. An
    origin limits clearing to that origin's cookies.
- **Present but inert:** `webRequest` hooks, `Tray`,
  `globalShortcut`, `powerMonitor`, `autoUpdater` (packages update through
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

The runtime is plain JavaScript (Node.js 20.6 or later). Its tests run on any
machine, against a mock host that speaks the host's protocol:

```sh
cd runtime
AURORA_HOST=$PWD/tests/mock-host.js node lib/main.js tests/apps/basic
```

On Linux, `tools/cross-check.sh` compile-checks the host with the Haiku cross
compiler. `docs/PROTOCOL.md` describes the runtime–host protocol.
`AURORA_TRACE=1` logs it, and `AURORA_REPL=<socket>` with
`runtime/tools/aurora-repl.js` evaluates expressions in a running app.

## Licence

MIT. `host/vendor/nlohmann` is nlohmann/json (MIT). The engine additions in
`engine-api/` are BSD-2-Clause, like the Haiku WebKit port they patch.
