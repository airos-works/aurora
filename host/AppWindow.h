/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

#include "Protocol.h"

#include <Window.h>
#include <memory>

class BMenuBar;
class BWebKitContext;
class BWebKitView;

namespace aurora {

// One Electron BrowserWindow: a native window, an optional menu bar and a
// web view. Commands for it arrive as kCommandMessage with a "command"
// pointer to a parsed json, which the window deletes.
class AppWindow final : public BWindow {
public:
    AppWindow(int32 identifier, const json& options, std::shared_ptr<BWebKitContext> context,
        const json* applicationMenu, uint64 newPageRequest);
    ~AppWindow() override;

    int32 Identifier() const { return fIdentifier; }
    // The web view, for telling apart which window's page posted a message.
    BMessenger ViewMessenger() const;
    // The window was created without being shown; start its looper anyway.
    void StartHidden();

    bool QuitRequested() override;
    void MessageReceived(BMessage*) override;
    void FrameMoved(BPoint) override;
    void FrameResized(float, float) override;
    void WindowActivated(bool) override;
    void Minimize(bool) override;
    void Zoom(BPoint, float, float) override;
    using BWindow::Zoom;

    // From the application thread: the application menu changed.
    static void PostApplicationMenu(BWindow*, const json& items);

private:
    void HandleCommand(const json& command);
    void HandleWebContentsCommand(const std::string& name, const json& command);
    void ConfigureView(const json& options);
    void SetMenu(const json* items);
    void LayoutViews();
    void MenuItemInvoked(BMessage*);
    void PerformRole(const std::string& role);
    void WebKitState(BMessage*);
    void WebKitCloseResult(BMessage*);
    void WebKitCloseCommitted(BMessage*);
    void BeginClose();
    void Destroy();
    void SendWindowEvent(const char* type);
    json WindowBounds() const;
    void SetFullScreen(bool);

    const int32 fIdentifier;
    std::shared_ptr<BWebKitContext> fContext;
    BWebKitView* fView = nullptr;
    BMenuBar* fMenuBar = nullptr;
    json fApplicationMenu;
    json fOwnMenu;
    bool fHasOwnMenu = false;
    bool fMenuBarVisible = true;
    bool fDestroying = false;
    bool fClosing = false;
    bool fCloseApproved = false;
    bool fCommitPending = false;
    uint64 fCommitIdentifier = 0;
    bool fFullScreen = false;
    BRect fFrameBeforeFullScreen;
    bool fMaximized = false;
    BRect fFrameBeforeMaximize;
    bool fMinimized = false;
    bool fReadyToShowSent = false;
    bool fShowWhenReady = false;
    bool fActive = false;
    bool fNewPage = false;
    // Set while one navigation may ignore beforeunload (see wc.reload "force").
    bool fProceedOnce = false;
    uint64 fProceedGeneration = 0;
    uint64 fLoadGeneration = 0;
};

} // namespace aurora
