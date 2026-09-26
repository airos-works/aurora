# Packaging an Electron app for Haiku

An Electron app packaged for Haiku is a folder:

```
MyApp/
  My App          copy of aurora-host with the app's name, icon and signature
  aurora.json     {"app": "app"} and optional settings, below
  app/            the Electron app: package.json, main script, node_modules
                  (or app.asar)
```

Tracker and Deskbar start `My App`. Because `aurora.json` sits beside it, it
runs as a *launcher* (`host/Launcher.cpp`):

1. It starts Node.js with the Aurora runtime and the app, as its child.
2. It becomes that app's window host. The two talk over pipes on descriptors
   3 and 4.

So the app has one Deskbar entry, the launcher's. The launcher sets
`AURORA_HOST` to itself, so windows opened later go to the same process.

## aurora.json

```json
{
  "app": "app",
  "node": "/boot/system/bin/node",
  "runtime": "/boot/system/data/aurora/runtime/lib/main.js",
  "webkit": "/path/to/engine/bundle",
  "env": { "SOME_VARIABLE": "value" }
}
```

Only `app` is required. Relative paths are relative to the folder.

## Resources

The launcher's resources come from an `.rdef`; see
`ports/pgadmin4/files/pgAdmin4.rdef`.

- **`app_signature`:** give each app its own, such as
  `application/x-vnd.vendor-app`.
- **`app_flags`:** set `B_MULTIPLE_LAUNCH`. Electron apps enforce a single
  instance themselves, through `app.requestSingleInstanceLock()`.
- **Icon:** import it as `resource(101, "BEOS:ICON") #'VICN' import "App.hvif";`.
  `tools/png2hvif.py icon.png App.hvif` traces an app's PNG icon into a Haiku
  vector icon.

```sh
cp aurora-host "MyApp/My App"
rc -o app.rsrc App.rdef && xres -o "MyApp/My App" app.rsrc && mimeset -f "MyApp/My App"
```

## The engine

`aurora-host` links Summit's WebKit (`libWebKit.so.1`). It looks for the
engine in `$ORIGIN/webkit/lib`, then in the shared engine install locations
compiled into its RPATH (see `ENGINE_RPATH` in the Makefile). It sets
`WEBKIT_EXEC_PATH` itself, to the bundle it loaded, so that WebKit finds
WebProcess and NetworkProcess. If a private Mesa exists (`AURORA_MESA_LIB`,
the engine's `mesa/lib`, or Summit's `/boot/home/summit-mesa/prefix/lib`), the
host puts it first in `LIBRARY_PATH` for the engine's processes, which inherit
it. The host does not restart itself to pick the Mesa up: an app launched by
Tracker or Deskbar would lose the message port the roster made for it and
spin.

That Mesa's glvnd `libEGL` finds the Mesa driver only through a vendor file
(`egl_vendor.d/*.json`) in directories fixed when it was built. Without one,
the web process gets no EGL display and aborts. So the host sets
`__EGL_VENDOR_LIBRARY_DIRS` to the vendor directory that came with the Mesa,
or writes a vendor file to `~/config/cache/Aurora/egl_vendor.d`. The engine
also needs `libepoxy`.

## A Haiku package

`ports/pgadmin4/package-haiku.sh` is a complete example:

- the folder goes to `apps/<Name>`;
- a Deskbar menu link goes in `data/deskbar/menu/Applications`;
- the app's licence goes in `data/licenses`;
- `.PackageInfo` requires `aurora` and `cmd:node`, plus whatever native
  libraries the app's Node or Python modules use.

Native Node modules must be rebuilt for Haiku. Modules built for Linux do not
load.
