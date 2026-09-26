/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

namespace aurora {

// Started from Deskbar (a packaged app's launcher), the host has no wrapper
// script to set up the engine's environment, so it does so itself:
// - a private Mesa (AURORA_MESA_LIB, the engine bundle's mesa/lib, or Summit's
//   /boot/home/summit-mesa) must come before the system's in the engine's
//   processes: LIBRARY_PATH and glvnd's vendor file are set for them to
//   inherit.
// - WebKit finds WebProcess and NetworkProcess through WEBKIT_EXEC_PATH,
//   which is set to the bundle libWebKit was loaded from.
void UsePrivateLibraries();
void SetEngineExecutablePath();

} // namespace aurora
