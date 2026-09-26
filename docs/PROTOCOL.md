# aurora-host protocol

The Node.js runtime (`runtime/lib/host.js`) and the native host (`host/`)
exchange JSON objects, one per line, each line starting with an ASCII record
separator (`0x1e`). Lines without it are not protocol: the runtime copies them
to stderr, so a library printing to stdout cannot corrupt the stream.

- Normally the runtime starts `aurora-host` and uses its stdin (commands) and
  stdout (events). The host keeps its own duplicate of stdout for the protocol
  and points file descriptor 1 at stderr.
- A packaged app starts the other way round (`host/Launcher.cpp`): the host
  runs the runtime as its child and they use pipes on descriptors 3 (events
  to the runtime) and 4 (commands to the host), announced to the runtime in
  `AURORA_HOST_FDS=3,4`. Hosts the runtime starts get `AURORA_HOST_CHILD=1`.

## Commands (runtime → host)

`{"cmd": "<name>", ...}`. A command with a positive `"req"` is answered by
`{"ev": "response", "req": n, "result": ...}` or `{"ev": "response", "req": n,
"error": "..."}`; one without `req` gets no answer.

| Command | Fields | Answer |
|---|---|---|
| `init` | `userDataPath`, `name`, `downloadsPath` | null |
| `window.create` | `id`, `options` (below), `newPageRequest` | `{id}` |
| `window.show` / `hide` / `focus` / `blur` | `id`, `activate` | window bounds |
| `window.minimize` / `restore` / `maximize` / `unmaximize` | `id` | window bounds |
| `window.setFullScreen` / `setResizable` / `setAlwaysOnTop` | `id`, `flag` | window bounds |
| `window.setTitle` | `id`, `title` | |
| `window.setBounds` | `id`, `x`, `y`, `width`, `height` | |
| `window.center`, `window.setSizeLimits` | `id`, `minWidth`... | |
| `window.setMenu` | `id`, `menu` (items, `[]` for none) | |
| `window.setMenuBarVisibility` | `id`, `visible` | |
| `window.close` | `id`: runs beforeunload, then closes | |
| `window.destroy` | `id`: closes at once | |
| `window.debugViews` | `id` | the view tree with frames |
| `wc.loadURL` | `id`, `url`, `userAgent`, `force` (ignore beforeunload) | |
| `wc.reload` | `id`, `force` | |
| `wc.stop` / `goBack` / `goForward` / `focus` | `id` | |
| `wc.exec` | `id`, `code`, `async`, `req` | a `js.result` event, not a response |
| `wc.edit` | `id`, `command`: undo, redo, cut, copy, paste, selectAll | |
| `wc.zoom` | `id`, `direction`: 1, -1 or 0 (reset) | |
| `wc.setZoomFactor` | `id`, `factor` | |
| `wc.find` / `wc.stopFind` | `id`, `text`, `forward`, `matchCase` | |
| `wc.download` | `id`, `url` | |
| `wc.setUserAgent` | `id`, `userAgent` | |
| `ipc.reply` | `token`, `reply` (string) or `error` | |
| `scheme.respond` | `identifier`, `status`, `mimeType`, `headers` `[[name, value]]`, `data` (base64) | |
| `scheme.fail` | `identifier`, `description` | |
| `newpage.decline` | `identifier` | |
| `menu.setApplicationMenu` | `menu` (items or null) | |
| `menu.popup` | `window`, `menu`, `x`, `y` (screen; default: pointer) | null, then `menu.click`/`menu.closed` |
| `dialog.open` / `dialog.save` / `dialog.message` | `options` (Electron's) | Electron's result object |
| `dialog.error` | `title`, `content` | |
| `clipboard.write` | `text`, `html` | |
| `clipboard.clear`, `clipboard.read` | | `{text, html}` |
| `notification.show` | `title`, `body`, `tag` | |
| `screen.get` | | displays |
| `download.cancel` | `identifier` | |
| `session.cookies.get` | `partition`, `url` (empty: every cookie) | `[{name, value, domain, path, secure, httpOnly, session, sameSite, expires}]` |
| `session.cookies.set` | `partition`, `cookie` (those fields; no `expires`: a session cookie) | null |
| `session.cookies.remove` | `partition`, `url`, `name` (empty: all of the URL's) | null |
| `session.clearData` | `partition`, `types` (engine B_WEBKIT_DATA_* bits: 1 cookies, 2 cache, 4 local storage, 8 IndexedDB, 16 service workers) | null |
| `app.beep`, `app.quit` | | |

Window `options`: `title`, `x`, `y`, `width`, `height`, `min/maxWidth/Height`,
`resizable`, `minimizable`, `maximizable`, `closable`, `focusable`,
`alwaysOnTop`, `frame`, `modal`, `backgroundColor`, `autoHideMenuBar`, `show`,
`showWhenReady`, `menu`, `partition`, `userAgent`, `zoomFactor`,
`userScripts` (`[{source, when: "start"|"end", allFrames}]`), `schemes`
(`[{scheme, secure, corsEnabled, bypassCSP}]`) and `inheritScriptsFrom` (a
page opened by `window.open()` shares its opener's scripts and handlers).

`session.*` commands need an engine with the website data interfaces (the
ready event's `websiteData`). `expires` is in milliseconds since the epoch;
a domain cookie's `domain` starts with a dot. The host reaches a partition's
data through a hidden view of its own, so a session needs no window.

Menu items: `{id, label, type: normal|separator|submenu|checkbox|radio,
enabled, visible, checked, role, command, key, modifiers, acceleratorLabel,
submenu}`. `command` and `key` make a Haiku shortcut (Command + key);
otherwise `acceleratorLabel` is shown after the label.

## Events (host → runtime)

| Event | Fields |
|---|---|
| `ready` | `engine`, `engineError`, `embedding`, `websiteData`, `screens`, `darkMode`, `clipboard`, `paths` |
| `window.event` | `id`, `type` (focus, blur, move, resize, minimize, restore, maximize, unmaximize, enter-full-screen, leave-full-screen, show, hide, ready-to-show), `bounds` |
| `window.close-requested` | `id`, `byPage` (the page called `window.close()`) |
| `window.close-cancelled` | `id`: a beforeunload handler kept the page |
| `window.closed` | `id` |
| `wc.state` | `id`, `url`, `title`, `loading`, `progress`, `canGoBack`, `canGoForward`, `zoom`, `loadGeneration`, `loadOutcome` (loading, succeeded, failed, cancelled, idle), `loadError` |
| `wc.crashed` | `id`, `error` |
| `wc.new-page` | `id` (opener), `identifier`, `url`, `popup`, `userGesture`, `width`... |
| `wc.link-open` / `wc.link-hover` / `wc.favicon` | `id`, `url` / `iconURL` |
| `wc.context-menu` | `id`, `x`, `y`, `screenX`, `screenY`, `isEditable`, `selected_text`, `link_url`... |
| `wc.find-result` | `id`, `query`, `found` |
| `wc.will-prevent-unload` | `id` |
| `ipc.message` | `id`, `token`, `name`, `body`, `bodyType`, `mainFrame`, `frameUrl`, `origin` |
| `js.result` | `id`, `req`, and `result` + `resultType`, or `error` |
| `scheme.request` | `id`, `identifier`, `scheme`, `url`, `method`, `headers`, `body` (base64) |
| `scheme.stopped` | `identifier` |
| `menu.click` | `window` or `popup`, `item`, `checked`, `role` |
| `menu.closed` | `popup` |
| `clipboard.changed` | `clipboard` |
| `theme.changed` | `darkMode` |
| `download` | `type` (started, progress, finished), `identifier`, `url`, `path`, `received`, `total`, `state` |
| `app.quit-requested`, `app.open-file` | `path` |

## Pages

Every window gets one user script at document start (`runtime/lib/renderer/bridge.js`):
Electron's renderer modules and the window's preload scripts, bundled with the
files they require. It talks to the main process through the engine's script
message handler `aurora` (`window.webkit.messageHandlers.aurora`), posting JSON
text `{t, ch, a, k, top}`: `t` is send, invoke, dom-ready, zoom or
preload-error, `a` the arguments encoded by `runtime/lib/serialize.js`, `k`
the window's token. `ipcRenderer.sendSync` is a synchronous request to
`aurora-ipc://sync/`, a URL scheme every window registers. The main process
calls into pages with `wc.exec`: `webContents.send` runs
`window[Symbol.for('aurora.dispatch')](channel, args)`.
