/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "Displays.h"

#include <Message.h>
#include <Screen.h>
#include <dlfcn.h>

namespace aurora {

namespace {

typedef status_t (*GetDisplayLayout)(BMessage&);

GetDisplayLayout DisplayLayoutFunction()
{
    static GetDisplayLayout function = (GetDisplayLayout)dlsym(RTLD_DEFAULT,
        "_ZN8BPrivate18get_display_layoutER8BMessage");
    return function;
}

} // namespace

std::vector<Display> Displays()
{
    std::vector<Display> displays;
    BMessage layout;
    GetDisplayLayout getLayout = DisplayLayoutFunction();
    if (getLayout != nullptr && getLayout(layout) == B_OK) {
        BMessage entry;
        for (int32 i = 0; layout.FindMessage("display", i, &entry) == B_OK; i++) {
            BRect frame;
            // a mirror shows another display's part of the screen
            if (!entry.GetBool("enabled", true) || entry.GetInt32("mirror", -1) >= 0
                || entry.FindRect("frame", &frame) != B_OK || !frame.IsValid())
                continue;
            Display display = { entry.GetInt32("id", i), frame };
            if (entry.GetBool("primary", false))
                displays.insert(displays.begin(), display);
            else
                displays.push_back(display);
        }
    }
    if (displays.empty())
        displays.push_back({ 0, BScreen(B_MAIN_SCREEN_ID).Frame() });
    return displays;
}

BRect PrimaryDisplayFrame()
{
    return Displays().front().frame;
}

} // namespace aurora
