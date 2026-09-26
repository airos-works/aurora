/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

// The engine's embedding interfaces (user scripts, script messages, script
// evaluation, URL schemes) arrived with WebKitEmbedding.h. Without them the
// host still shows windows, menus and dialogs, but pages cannot reach the
// main process: preload scripts and ipcRenderer do not work.
#if __has_include(<WebKit/WebKitEmbedding.h>)
#include <WebKit/WebKitEmbedding.h>
#define AURORA_HAVE_EMBEDDING 1
#else
#define AURORA_HAVE_EMBEDDING 0
#endif
