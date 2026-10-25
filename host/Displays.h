/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

#include <Rect.h>

#include <vector>

namespace aurora {

// The monitors the screen is made of, the primary one first. air/OS lays
// several out side by side in one screen (BScreen's frame spans them all);
// its libbe describes each (BPrivate::get_display_layout(), looked up at run
// time). Elsewhere, or when that fails, the screen is the one display.
struct Display {
    int32 id;
    BRect frame;
};
std::vector<Display> Displays();

// The frame of the primary monitor, where a window nobody placed goes.
BRect PrimaryDisplayFrame();

} // namespace aurora
