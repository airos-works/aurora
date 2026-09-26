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

// AURORA_LEGACY_ENGINE=1 builds against an engine from before September 21
// (no new-page requests, context menus, link hover or display scale), to try
// the host with an older Summit bundle.
#ifndef AURORA_LEGACY_ENGINE
#define AURORA_LEGACY_ENGINE 0
#endif
