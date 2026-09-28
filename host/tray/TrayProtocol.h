/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

// Between aurora-host and aurora-tray, the Deskbar add-on that shows an app's
// Tray icons. The host adds an item to Deskbar as an archive of the add-on's
// AuroraTrayItem; Deskbar loads the add-on by its signature (the archive's
// "add_on"), and the item then talks to the host with these messages.

#include <SupportDefs.h>

namespace aurora {

inline constexpr const char* kTraySignature = "application/x-vnd.aurora-tray";
inline constexpr const char* kTrayClassName = "AuroraTrayItem";

// Archive fields: the host that owns the item, its tray id, and what it shows.
inline constexpr const char* kTrayOwnerField = "aurora:owner";     // BMessenger
inline constexpr const char* kTrayIdField = "aurora:tray";         // int32
inline constexpr const char* kTrayIconField = "aurora:icon";       // BMessage, an archived BBitmap
inline constexpr const char* kTrayToolTipField = "aurora:tooltip"; // string

enum : uint32 {
    // Item -> host, once it is in Deskbar: "aurora:tray", "item" (BMessenger).
    kTrayAttachedMessage = 'atat',
    // Item -> host: "aurora:tray", "buttons", "clicks", "where" (a screen
    // point), "frame" (the item's screen frame).
    kTrayClickedMessage = 'atck',
    // Host -> item: a new icon and/or tool tip, in the archive's fields.
    kTrayUpdateMessage = 'atup'
};

} // namespace aurora
