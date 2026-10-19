/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

namespace aurora {

// An Electron app packaged for Haiku is a folder with a copy of aurora-host
// named after the app (with its icon and signature), an aurora.json and the
// app itself. Started from Deskbar or Tracker, that copy is the launcher: it
// starts the Node.js runtime as its child, connected by two pipes, and then
// serves as the app's host. So Deskbar shows one entry, the app's.
//
// aurora.json: { "app": "app", "node": "/boot/system/bin/node",
//   "runtime": "/boot/system/data/aurora/runtime/lib/main.js",
//   "webkit": "<engine bundle>", "env": { ... } }; paths are relative to the
// folder, and every member but "app" is optional.
//
// Returns true when the runtime was started and the protocol now uses the
// pipes; false when there is no aurora.json or this host is the runtime's child.
bool StartRuntimeIfLauncher(int argc, char** argv);

// Whether this host is a packaged app's launcher (StartRuntimeIfLauncher
// started the runtime): only a launcher can be started again for a link.
bool IsLauncher();

} // namespace aurora
