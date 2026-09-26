/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

#include "Protocol.h"

#include <Messenger.h>
#include <map>
#include <memory>
#include <string>

class BWebKitContext;
class BWebKitView;
class BWindow;

namespace aurora {

// A session's cookies and website data (Electron's session.cookies and
// clearStorageData), through the engine's website data interfaces. The
// engine reaches a context's data through a view, and a session can exist
// without windows, so each partition gets a hidden 1x1 view of its own.
class WebsiteData {
public:
    explicit WebsiteData(BMessenger replies);
    ~WebsiteData();

    // Whether this engine has the interfaces (the ready event says so).
    static bool Available();

    // Starts session.cookies.get/set/remove or session.clearData for a
    // request; the engine answers `replies` with a message that Answer()
    // turns into the response. False when the command is not one of these.
    bool Handle(const std::string& name, const json& command, uint64 request,
        const std::shared_ptr<BWebKitContext>& context);

    static bool IsAnswer(uint32 what);
    static void Answer(BMessage* message);

private:
    BWebKitView* ViewFor(const std::string& partition, const std::shared_ptr<BWebKitContext>& context);

    BMessenger fReplies;
    std::map<std::string, BWindow*> fWindows;
    std::map<std::string, BWebKitView*> fViews;
};

} // namespace aurora
