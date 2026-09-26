/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

// The host talks to the Node.js main process over its standard input and
// output: one JSON object per line, each line starting with an ASCII record
// separator (0x1e) so that anything a library prints to stdout is not taken
// for a message. The runtime side is runtime/lib/host.js; the messages are
// listed in docs/PROTOCOL.md.

#include <SupportDefs.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace aurora {

// BMessage codes the host uses internally.
enum : uint32 {
    kCommandMessage = 'acmd',       // "json": one command from the runtime
    kInputClosedMessage = 'aeof',   // the runtime went away
    kMenuItemMessage = 'amnu',      // "window" (int32 id), "item" (string id)
    kPopUpResultMessage = 'apop',
    kDialogResultMessage = 'adlg',
    kWindowDestroyedMessage = 'awdd'
};

// Call first thing in main(): keeps the protocol on its own copy of stdout and
// sends everything else printed to stdout to stderr.
void InitProtocolOutput();
// Launcher mode: the runtime is our child and talks over these pipes instead.
void SetProtocolDescriptors(int input, int output);

// Thread safe; writes one line.
void SendEvent(const json& event);
void SendResponse(uint64 request, const json& result);
void SendError(uint64 request, const std::string& error);

// Starts the thread that reads commands and posts them to be_app.
status_t StartCommandReader();

std::string Base64Encode(const void* data, size_t size);
std::vector<uint8_t> Base64Decode(const std::string& text);

// Small accessors that tolerate missing and mistyped members.
std::string StringOf(const json& object, const char* key, const std::string& fallback = std::string());
double NumberOf(const json& object, const char* key, double fallback = 0);
bool BoolOf(const json& object, const char* key, bool fallback = false);
bool HasNumber(const json& object, const char* key);

} // namespace aurora
