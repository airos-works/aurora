/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */
#pragma once

// keystore.* commands: passwords in Haiku's key store, for the runtime's
// keytar stand-in (runtime/lib/shims/keytar.js). keystore_server answers
// only applications the roster knows, so the host asks, not Node.js; and it
// may ask the user first, so every command runs on a thread of its own.

#include "Protocol.h"

namespace aurora {

void HandleKeyStoreCommand(const json& command, uint64 request);

} // namespace aurora
