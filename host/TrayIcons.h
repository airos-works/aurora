/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

#include "Protocol.h"

#include <Entry.h>
#include <Message.h>
#include <Messenger.h>
#include <map>
#include <string>
#include <vector>

namespace aurora {

// Electron's Tray: each tray is an icon in Deskbar's tray, drawn there by the
// aurora-tray add-on (tray/AuroraTray.cpp). Clicks come back as tray.click
// events; the runtime shows the tray's menu.
class TrayIcons {
public:
    // Items send their messages to owner (the application).
    explicit TrayIcons(BMessenger owner);
    ~TrayIcons();

    // tray.create, tray.set and tray.destroy; false for any other command.
    bool Handle(const std::string& name, const json& command, uint64 request);
    static bool IsTrayMessage(uint32 what);
    void Received(BMessage* message);
    void RemoveAll();

private:
    struct Item {
        int32 deskbarId = -1;
        BMessenger view;
        // Updates from before the item was in Deskbar.
        std::vector<BMessage> pending;
    };

    status_t Create(int32 tray, const json& command);
    status_t Update(int32 tray, const json& command);
    status_t FindAddOn(entry_ref* ref);

    BMessenger fOwner;
    std::map<int32, Item> fItems;
    entry_ref fAddOn;
    bool fAddOnFound = false;
};

} // namespace aurora
