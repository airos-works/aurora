/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

#include "Protocol.h"

#include <Application.h>
#include <map>
#include <memory>
#include <string>

class BWebKitContext;

namespace aurora {

class AppWindow;
class DialogLooper;
class TrayIcons;
class WebsiteData;

class HostApp final : public BApplication {
public:
    explicit HostApp(const char* signature);
    ~HostApp() override;

    void ReadyToRun() override;
    void MessageReceived(BMessage*) override;
    bool QuitRequested() override;
    void RefsReceived(BMessage*) override;
    void ArgvReceived(int32, char**) override;

private:
    void HandleCommand(json& command);
    void CreateWindow(const json& command);
    std::shared_ptr<BWebKitContext> ContextFor(const std::string& partition);
    void ShowPopUpMenu(const json& command);
    void WriteClipboard(const json& command);
    json ReadClipboard();
    void ShowNotification(const json& command);
    void ForwardDownload(BMessage*);
    void Exit();
    static json Screens();
    static bool DarkMode();

    std::map<int32, AppWindow*> fWindows;
    std::map<std::string, std::shared_ptr<BWebKitContext>> fContexts;
    std::string fUserDataPath;
    std::string fDownloadsPath;
    std::string fApplicationName;
    json fApplicationMenu;
    bool fHasApplicationMenu = false;
    bool fQuitting = false;
    bool fEngineReady = false;
    DialogLooper* fDialogs = nullptr;
    std::unique_ptr<WebsiteData> fWebsiteData;
    std::unique_ptr<TrayIcons> fTrayIcons;
};

} // namespace aurora
