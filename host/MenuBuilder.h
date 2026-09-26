/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

#include "Protocol.h"

class BMenu;
class BMenuBar;
class BMessage;

namespace aurora {

// Menu templates come from runtime/lib/electron/menu.js, already expanded:
// roles have labels, submenus and parsed accelerators. An item is
// { id, label, type: normal|separator|submenu|checkbox|radio, enabled, visible,
//   checked, role, key, modifiers: ["shift", "option", "control"], submenu }.
// Items send kMenuItemMessage with "item" (the id) and "role" (if any).

// Fills menu with items; replaces nothing that is already there.
void AddMenuItems(BMenu* menu, const json& items, int32 windowIdentifier);
BMenuBar* BuildMenuBar(const json& items, int32 windowIdentifier, float width);
// Marks a radio item and clears the others of its contiguous group.
void MarkRadioItem(BMenu* menu, const char* itemIdentifier);

} // namespace aurora
