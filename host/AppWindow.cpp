/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "AppWindow.h"

#include "Embedding.h"
#include "MenuBuilder.h"

#include <Application.h>
#include <Menu.h>
#include <MenuBar.h>
#include <MenuItem.h>
#include <Screen.h>
#include <WebKit/WebKitContext.h>
#include <WebKit/WebKitView.h>
#include <cmath>
#include <cstring>
#include <vector>

namespace aurora {

namespace {

enum : uint32 {
    kApplicationMenuMessage = 'aapm'
};

window_look LookFor(const json& options)
{
    if (!BoolOf(options, "frame", true))
        return B_NO_BORDER_WINDOW_LOOK;
    if (BoolOf(options, "modal", false))
        return B_MODAL_WINDOW_LOOK;
    return B_TITLED_WINDOW_LOOK;
}

window_feel FeelFor(const json& options)
{
    if (BoolOf(options, "modal", false))
        return B_MODAL_APP_WINDOW_FEEL;
    if (BoolOf(options, "alwaysOnTop", false))
        return B_FLOATING_ALL_WINDOW_FEEL;
    return B_NORMAL_WINDOW_FEEL;
}

uint32 FlagsFor(const json& options)
{
    uint32 flags = B_ASYNCHRONOUS_CONTROLS;
    if (!BoolOf(options, "resizable", true))
        flags |= B_NOT_RESIZABLE | B_NOT_ZOOMABLE;
    if (!BoolOf(options, "maximizable", true))
        flags |= B_NOT_ZOOMABLE;
    if (!BoolOf(options, "minimizable", true))
        flags |= B_NOT_MINIMIZABLE;
    if (!BoolOf(options, "closable", true))
        flags |= B_NOT_CLOSABLE;
    if (!BoolOf(options, "focusable", true))
        flags |= B_AVOID_FOCUS;
    return flags;
}

BRect InitialFrame(const json& options)
{
    float width = std::max(1.0, NumberOf(options, "width", 800));
    float height = std::max(1.0, NumberOf(options, "height", 600));
    BRect screen = BScreen().Frame();
    float x = HasNumber(options, "x") ? NumberOf(options, "x") : screen.left + (screen.Width() - width) / 2;
    float y = HasNumber(options, "y") ? NumberOf(options, "y") : screen.top + (screen.Height() - height) / 2;
    return BRect(std::floor(x), std::floor(y), std::floor(x) + width - 1, std::floor(y) + height - 1);
}

rgb_color ParseColor(const std::string& text, rgb_color fallback)
{
    // #RGB, #RRGGBB or #AARRGGBB, as Electron accepts.
    if (text.size() < 4 || text[0] != '#')
        return fallback;
    std::string digits = text.substr(1);
    if (digits.size() == 3)
        digits = { digits[0], digits[0], digits[1], digits[1], digits[2], digits[2] };
    if (digits.size() == 8)
        digits = digits.substr(2);
    if (digits.size() != 6)
        return fallback;
    unsigned long value = strtoul(digits.c_str(), nullptr, 16);
    return { uint8((value >> 16) & 0xff), uint8((value >> 8) & 0xff), uint8(value & 0xff), 255 };
}

// Engine interfaces newer than the first embedding round are used when the
// headers declare them, so the host builds against either engine.
enum : uint32 {
    kBeforeUnloadPrompt = 0,
    kBeforeUnloadCancel = 1,
    kBeforeUnloadProceed = 2,
    kBeforeUnloadPrevented = 'wbup'
};

template<typename View>
bool SetBeforeUnloadBehavior(View* view, uint32 behavior, BMessenger target)
{
    if constexpr (requires { view->SetBeforeUnloadBehavior(behavior, target); }) {
        view->SetBeforeUnloadBehavior(behavior, target);
        return true;
    }
    return false;
}

template<typename View>
bool SetZoomFactor(View* view, double factor)
{
    if constexpr (requires { view->SetZoomFactor(factor); }) {
        view->SetZoomFactor(factor);
        return true;
    }
    return false;
}

uint32 EditCommand(const std::string& name)
{
    if (name == "undo")
        return B_UNDO;
    if (name == "redo")
        return B_REDO;
    if (name == "cut")
        return B_CUT;
    if (name == "copy")
        return B_COPY;
    if (name == "paste" || name == "pasteAndMatchStyle")
        return B_PASTE;
    if (name == "selectAll")
        return B_SELECT_ALL;
    return 0;
}

} // namespace

AppWindow::AppWindow(int32 identifier, const json& options, std::shared_ptr<BWebKitContext> context,
    const json* applicationMenu, uint64 newPageRequest)
    : BWindow(InitialFrame(options), StringOf(options, "title", "").c_str(), LookFor(options), FeelFor(options), FlagsFor(options))
    , fIdentifier(identifier)
    , fContext(std::move(context))
{
    if (applicationMenu)
        fApplicationMenu = *applicationMenu;
    auto menu = options.find("menu");
    if (menu != options.end()) {
        fHasOwnMenu = true;
        fOwnMenu = *menu;
    }
    fMenuBarVisible = !BoolOf(options, "autoHideMenuBar", false);

    float minWidth = NumberOf(options, "minWidth", 0), minHeight = NumberOf(options, "minHeight", 0);
    float maxWidth = NumberOf(options, "maxWidth", 0), maxHeight = NumberOf(options, "maxHeight", 0);
    if (minWidth || minHeight || maxWidth || maxHeight)
        SetSizeLimits(std::max(0.0f, minWidth - 1), maxWidth > 0 ? maxWidth - 1 : 32768,
            std::max(0.0f, minHeight - 1), maxHeight > 0 ? maxHeight - 1 : 32768);

    auto* background = new BView(Bounds(), "background", B_FOLLOW_ALL, B_WILL_DRAW);
    background->SetViewColor(ParseColor(StringOf(options, "backgroundColor"), ui_color(B_PANEL_BACKGROUND_COLOR)));
    AddChild(background);

    SetMenu(fHasOwnMenu ? &fOwnMenu : &fApplicationMenu);
    BRect viewFrame = Bounds();
    if (fMenuBar && !fMenuBar->IsHidden())
        viewFrame.top = fMenuBar->Frame().bottom + 1;
    if (newPageRequest)
        fView = new BWebKitView(viewFrame, "web contents", BMessenger(this), newPageRequest, B_FOLLOW_ALL, fContext);
    else
        fView = new BWebKitView(viewFrame, "web contents", BMessenger(this), B_FOLLOW_ALL, fContext);
    ConfigureView(options);
    background->AddChild(fView);
    fView->MakeFocus(true);
    fShowWhenReady = BoolOf(options, "showWhenReady", false);
    fNewPage = newPageRequest != 0;
}

BMessenger AppWindow::ViewMessenger() const
{
    return fView ? BMessenger(fView) : BMessenger();
}

AppWindow::~AppWindow()
{
}

void AppWindow::StartHidden()
{
    Hide();
    Show();
}

void AppWindow::ConfigureView(const json& options)
{
    if (fView->InitCheck() != B_OK)
        return;
#if AURORA_HAVE_EMBEDDING
    // Electron: a beforeunload that asks to stay keeps the page, silently.
    SetBeforeUnloadBehavior(fView, kBeforeUnloadCancel, BMessenger(this));
    if (HasNumber(options, "zoomFactor"))
        SetZoomFactor(fView, NumberOf(options, "zoomFactor", 1));
    auto scripts = options.find("userScripts");
    // A page opened by window.open() shares its opener's scripts and message
    // handlers; adding them again would run them twice in both.
    bool inherits = HasNumber(options, "inheritScriptsFrom");
    if (!inherits && scripts != options.end() && scripts->is_array()) {
        for (auto& script : *scripts) {
            std::string source = StringOf(script, "source");
            if (!source.empty())
                fView->AddUserScript(source.c_str(), StringOf(script, "when", "start") == "start", BoolOf(script, "allFrames", true));
        }
    }
    if (!inherits)
        fView->AddScriptMessageHandler("aurora", BMessenger(this));
    auto schemes = options.find("schemes");
    if (schemes != options.end() && schemes->is_array()) {
        for (auto& scheme : *schemes) {
            uint32 flags = 0;
            if (BoolOf(scheme, "secure", false))
                flags |= B_WEBKIT_SCHEME_SECURE;
            if (BoolOf(scheme, "corsEnabled", false))
                flags |= B_WEBKIT_SCHEME_CORS_ENABLED;
            if (BoolOf(scheme, "bypassCSP", false))
                flags |= B_WEBKIT_SCHEME_BYPASS_CSP;
            std::string name = StringOf(scheme, "scheme");
            if (!name.empty())
                fView->SetURLSchemeHandler(name.c_str(), BMessenger(this), flags);
        }
    }
    std::string userAgent = StringOf(options, "userAgent");
    if (!userAgent.empty())
        fView->SetCustomUserAgent(userAgent.c_str());
#else
    (void)options;
#endif
}

void AppWindow::SetMenu(const json* items)
{
    if (fMenuBar) {
        fMenuBar->RemoveSelf();
        delete fMenuBar;
        fMenuBar = nullptr;
    }
    if (items && items->is_array() && !items->empty()) {
        fMenuBar = BuildMenuBar(*items, fIdentifier);
        fMenuBar->SetResizingMode(B_FOLLOW_LEFT_RIGHT | B_FOLLOW_TOP);
        AddChild(fMenuBar);
        if (!fMenuBarVisible)
            fMenuBar->Hide();
    }
    LayoutViews();
}

void AppWindow::LayoutViews()
{
    BView* background = FindView("background");
    if (!background)
        return;
    BRect frame = Bounds();
    if (fMenuBar && !fMenuBar->IsHidden() && !fFullScreen) {
        fMenuBar->ResizeToPreferred();
        fMenuBar->ResizeTo(Bounds().Width(), fMenuBar->Frame().Height());
        frame.top = fMenuBar->Frame().bottom + 1;
    }
    background->MoveTo(frame.LeftTop());
    background->ResizeTo(frame.Width(), frame.Height());
    if (fView) {
        fView->MoveTo(0, 0);
        fView->ResizeTo(frame.Width(), frame.Height());
    }
}

void AppWindow::PostApplicationMenu(BWindow* window, const json& items)
{
    BMessage message(kApplicationMenuMessage);
    message.AddPointer("menu", new json(items));
    if (window->PostMessage(&message) != B_OK) {
        void* pointer;
        if (message.FindPointer("menu", &pointer) == B_OK)
            delete static_cast<json*>(pointer);
    }
}

json AppWindow::WindowBounds() const
{
    BRect frame = Frame();
    return { { "x", frame.left }, { "y", frame.top }, { "width", frame.Width() + 1 }, { "height", frame.Height() + 1 } };
}

void AppWindow::SendWindowEvent(const char* type)
{
    SendEvent({ { "ev", "window.event" }, { "id", fIdentifier }, { "type", type }, { "bounds", WindowBounds() } });
}

bool AppWindow::QuitRequested()
{
    if (fDestroying)
        return true;
    SendEvent({ { "ev", "window.close-requested" }, { "id", fIdentifier } });
    return false;
}

void AppWindow::FrameMoved(BPoint where)
{
    BWindow::FrameMoved(where);
    SendWindowEvent("move");
}

void AppWindow::FrameResized(float width, float height)
{
    BWindow::FrameResized(width, height);
    SendWindowEvent("resize");
}

void AppWindow::WindowActivated(bool active)
{
    BWindow::WindowActivated(active);
    if (active == fActive)
        return;
    fActive = active;
    SendWindowEvent(active ? "focus" : "blur");
}

void AppWindow::Minimize(bool minimize)
{
    BWindow::Minimize(minimize);
    if (minimize == fMinimized)
        return;
    fMinimized = minimize;
    SendWindowEvent(minimize ? "minimize" : "restore");
}

void AppWindow::Zoom(BPoint origin, float width, float height)
{
    if (fMaximized) {
        fMaximized = false;
        MoveTo(fFrameBeforeMaximize.LeftTop());
        ResizeTo(fFrameBeforeMaximize.Width(), fFrameBeforeMaximize.Height());
        SendWindowEvent("unmaximize");
        return;
    }
    fFrameBeforeMaximize = Frame();
    BWindow::Zoom(origin, width, height);
    fMaximized = true;
    SendWindowEvent("maximize");
}

void AppWindow::SetFullScreen(bool fullScreen)
{
    if (fullScreen == fFullScreen)
        return;
    fFullScreen = fullScreen;
    if (fullScreen) {
        fFrameBeforeFullScreen = Frame();
        SetLook(B_NO_BORDER_WINDOW_LOOK);
        BRect screen = BScreen(this).Frame();
        MoveTo(screen.LeftTop());
        ResizeTo(screen.Width(), screen.Height());
    } else {
        SetLook(B_TITLED_WINDOW_LOOK);
        MoveTo(fFrameBeforeFullScreen.LeftTop());
        ResizeTo(fFrameBeforeFullScreen.Width(), fFrameBeforeFullScreen.Height());
    }
    if (fMenuBar && fullScreen && !fMenuBar->IsHidden())
        fMenuBar->Hide();
    else if (fMenuBar && !fullScreen && fMenuBarVisible && fMenuBar->IsHidden())
        fMenuBar->Show();
    LayoutViews();
    SendWindowEvent(fullScreen ? "enter-full-screen" : "leave-full-screen");
}

void AppWindow::BeginClose()
{
    if (fDestroying || fCommitPending)
        return;
    if (!fView || fView->InitCheck() != B_OK) {
        Destroy();
        return;
    }
    if (fCloseApproved) {
        fCommitPending = true;
        BWebKitView::CommitClose({ fView }, BMessenger(this), ++fCommitIdentifier);
        return;
    }
    if (fClosing)
        return;
    fClosing = true;
    fView->RequestClose();
}

void AppWindow::Destroy()
{
    if (fDestroying)
        return;
    fDestroying = true;
    if (fView) {
        fView->RemoveSelf();
        delete fView;
        fView = nullptr;
    }
    BMessage gone(kWindowDestroyedMessage);
    gone.AddInt32("window", fIdentifier);
    be_app->PostMessage(&gone);
    Quit();
}

void AppWindow::WebKitCloseResult(BMessage* message)
{
    if (message->what == B_WEBKIT_CLOSE_CANCELLED) {
        fClosing = false;
        fCloseApproved = false;
        SendEvent({ { "ev", "window.close-cancelled" }, { "id", fIdentifier } });
        return;
    }
    fCloseApproved = true;
    if (fClosing) {
        fClosing = false;
        fCommitPending = true;
        BWebKitView::CommitClose({ fView }, BMessenger(this), ++fCommitIdentifier);
        return;
    }
    // The page called window.close(): ask the runtime, as a close button would.
    SendEvent({ { "ev", "window.close-requested" }, { "id", fIdentifier }, { "byPage", true } });
}

void AppWindow::WebKitCloseCommitted(BMessage* message)
{
    uint64 identifier;
    bool closed;
    if (!fCommitPending || message->FindUInt64("identifier", &identifier) != B_OK
        || identifier != fCommitIdentifier || message->FindBool("closed", &closed) != B_OK)
        return;
    fCommitPending = false;
    if (closed) {
        Destroy();
        return;
    }
    fCloseApproved = false;
    fView->ResetCloseRequest();
    SendEvent({ { "ev", "window.close-cancelled" }, { "id", fIdentifier } });
}

void AppWindow::WebKitState(BMessage* message)
{
    if (message->what == B_WEBKIT_PROCESS_EXITED) {
        SendEvent({ { "ev", "wc.crashed" }, { "id", fIdentifier }, { "error", message->GetInt32("error", B_OK) } });
        return;
    }
    json state = {
        { "ev", "wc.state" }, { "id", fIdentifier },
        { "url", message->GetString("url", "") }, { "title", message->GetString("title", "") },
        { "loading", message->GetBool("loading", false) }, { "progress", message->GetDouble("progress", 0) },
        { "canGoBack", message->GetBool("canGoBack", false) }, { "canGoForward", message->GetBool("canGoForward", false) },
        { "zoom", message->GetDouble("pageZoom", 1) }
    };
    uint64 generation;
    if (message->FindUInt64("loadGeneration", &generation) == B_OK) {
        fLoadGeneration = generation;
        if (fProceedOnce && generation != fProceedGeneration) {
            fProceedOnce = false;
            SetBeforeUnloadBehavior(fView, kBeforeUnloadCancel, BMessenger(this));
        }
        state["loadGeneration"] = generation;
        state["loadOutcome"] = message->GetString("loadOutcome", "");
        if (message->GetBool("loadError", false)) {
            state["loadError"] = {
                { "code", message->GetInt32("loadErrorCode", 0) },
                { "description", message->GetString("loadErrorDescription", "") },
                { "domain", message->GetString("loadErrorDomain", "") },
                { "url", message->GetString("loadErrorURL", "") },
                { "provisional", message->GetBool("loadErrorProvisional", false) }
            };
        }
    }
    SendEvent(state);
    std::string outcome = message->GetString("loadOutcome", "");
    if (!fReadyToShowSent && (outcome == "succeeded" || outcome == "failed")) {
        fReadyToShowSent = true;
        if (fShowWhenReady && IsHidden())
            Show();
        SendEvent({ { "ev", "window.event" }, { "id", fIdentifier }, { "type", "ready-to-show" }, { "bounds", WindowBounds() } });
    }
}

void AppWindow::PerformRole(const std::string& role)
{
    if (uint32 command = EditCommand(role)) {
        if (fView)
            fView->ExecuteEditCommand(command);
    } else if (role == "reload" || role == "forceReload") {
        if (fView)
            fView->Reload();
    } else if (role == "zoomIn" || role == "zoomOut" || role == "resetZoom") {
        if (fView)
            role == "zoomIn" ? fView->IncreaseZoomFactor() : role == "zoomOut" ? fView->DecreaseZoomFactor() : fView->ResetZoomFactor();
    } else if (role == "togglefullscreen") {
        SetFullScreen(!fFullScreen);
    } else if (role == "minimize") {
        Minimize(true);
    } else if (role == "zoom") {
        Zoom();
    } else if (role == "close") {
        PostMessage(B_QUIT_REQUESTED);
    } else if (role == "quit") {
        be_app->PostMessage(B_QUIT_REQUESTED);
    }
}

void AppWindow::MenuItemInvoked(BMessage* message)
{
    const char* item = message->GetString("item", "");
    const char* role = message->GetString("role", "");
    const char* type = message->GetString("type", "normal");
    bool checked = false;
    BMenuItem* source = nullptr;
    if (message->FindPointer("source", reinterpret_cast<void**>(&source)) == B_OK && source) {
        if (!strcmp(type, "checkbox")) {
            source->SetMarked(!source->IsMarked());
            checked = source->IsMarked();
        } else if (!strcmp(type, "radio")) {
            MarkRadioItem(source->Menu(), item);
            checked = true;
        }
    }
    json event = { { "ev", "menu.click" }, { "window", fIdentifier }, { "item", item }, { "checked", checked } };
    if (*role)
        event["role"] = role;
    SendEvent(event);
    // Roles act at once; the runtime runs any click handler as well.
    if (*role)
        PerformRole(role);
}

void AppWindow::HandleCommand(const json& command)
{
    std::string name = StringOf(command, "cmd");
    uint64 request = static_cast<uint64>(NumberOf(command, "req", 0));
    if (name.rfind("wc.", 0) == 0) {
        HandleWebContentsCommand(name, command);
        return;
    }
    if (name == "window.show") {
        if (IsHidden())
            Show();
        if (BoolOf(command, "activate", true))
            Activate(true);
        SendWindowEvent("show");
    } else if (name == "window.hide") {
        if (!IsHidden())
            Hide();
        SendWindowEvent("hide");
    } else if (name == "window.focus") {
        if (IsMinimized())
            Minimize(false);
        Activate(true);
    } else if (name == "window.blur") {
        Activate(false);
    } else if (name == "window.minimize") {
        Minimize(true);
    } else if (name == "window.restore") {
        if (IsMinimized())
            Minimize(false);
        if (fMaximized)
            Zoom();
    } else if (name == "window.maximize") {
        if (!fMaximized)
            Zoom();
    } else if (name == "window.unmaximize") {
        if (fMaximized)
            Zoom();
    } else if (name == "window.setFullScreen") {
        SetFullScreen(BoolOf(command, "flag", false));
    } else if (name == "window.setTitle") {
        SetTitle(StringOf(command, "title").c_str());
    } else if (name == "window.setBounds") {
        BRect frame = Frame();
        float x = NumberOf(command, "x", frame.left), y = NumberOf(command, "y", frame.top);
        float width = NumberOf(command, "width", frame.Width() + 1), height = NumberOf(command, "height", frame.Height() + 1);
        MoveTo(std::floor(x), std::floor(y));
        ResizeTo(std::max(1.0f, width) - 1, std::max(1.0f, height) - 1);
    } else if (name == "window.center") {
        CenterOnScreen();
    } else if (name == "window.setSizeLimits") {
        SetSizeLimits(std::max(0.0, NumberOf(command, "minWidth", 1) - 1), std::max(0.0, NumberOf(command, "maxWidth", 32769) - 1),
            std::max(0.0, NumberOf(command, "minHeight", 1) - 1), std::max(0.0, NumberOf(command, "maxHeight", 32769) - 1));
    } else if (name == "window.setResizable") {
        uint32 flags = Flags() & ~(B_NOT_RESIZABLE | B_NOT_ZOOMABLE);
        SetFlags(BoolOf(command, "flag", true) ? flags : flags | B_NOT_RESIZABLE | B_NOT_ZOOMABLE);
    } else if (name == "window.setAlwaysOnTop") {
        SetFeel(BoolOf(command, "flag", false) ? B_FLOATING_ALL_WINDOW_FEEL : B_NORMAL_WINDOW_FEEL);
    } else if (name == "window.setMenu") {
        fHasOwnMenu = true;
        auto menu = command.find("menu");
        fOwnMenu = menu != command.end() ? *menu : json();
        SetMenu(&fOwnMenu);
    } else if (name == "window.setMenuBarVisibility") {
        fMenuBarVisible = BoolOf(command, "visible", true);
        if (fMenuBar && fMenuBarVisible == fMenuBar->IsHidden()) {
            fMenuBarVisible ? fMenuBar->Show() : fMenuBar->Hide();
            LayoutViews();
        }
    } else if (name == "window.close") {
        BeginClose();
    } else if (name == "window.destroy") {
        Destroy();
        return;
    } else if (name == "window.getBounds") {
        // Answered below.
    } else if (request) {
        SendError(request, "Unknown window command " + name);
        return;
    }
    if (request)
        SendResponse(request, WindowBounds());
}

void AppWindow::HandleWebContentsCommand(const std::string& name, const json& command)
{
    uint64 request = static_cast<uint64>(NumberOf(command, "req", 0));
    if (!fView || fView->InitCheck() != B_OK) {
        if (request)
            SendError(request, "The window has no web contents");
        return;
    }
    if (name == "wc.loadURL") {
#if AURORA_HAVE_EMBEDDING
        std::string userAgent = StringOf(command, "userAgent");
        if (!userAgent.empty())
            fView->SetCustomUserAgent(userAgent.c_str());
#endif
        fView->LoadURL(StringOf(command, "url", "about:blank").c_str());
    } else if (name == "wc.reload") {
        if (BoolOf(command, "force", false) && SetBeforeUnloadBehavior(fView, kBeforeUnloadProceed, BMessenger(this))) {
            fProceedOnce = true;
            fProceedGeneration = fLoadGeneration;
        }
        fView->Reload();
    } else if (name == "wc.setZoomFactor") {
        if (!SetZoomFactor(fView, NumberOf(command, "factor", 1)) && request) {
            SendError(request, "This WebKit build cannot set a zoom factor");
            return;
        }
    } else if (name == "wc.stop") {
        fView->Stop();
    } else if (name == "wc.goBack") {
        fView->GoBack();
    } else if (name == "wc.goForward") {
        fView->GoForward();
    } else if (name == "wc.edit") {
        if (uint32 edit = EditCommand(StringOf(command, "command")))
            fView->ExecuteEditCommand(edit);
    } else if (name == "wc.zoom") {
        int direction = static_cast<int>(NumberOf(command, "direction", 0));
        direction > 0 ? fView->IncreaseZoomFactor() : direction < 0 ? fView->DecreaseZoomFactor() : fView->ResetZoomFactor();
    } else if (name == "wc.find") {
        fView->FindString(StringOf(command, "text").c_str(), BoolOf(command, "forward", true),
            BoolOf(command, "matchCase", false), true);
    } else if (name == "wc.stopFind") {
        fView->HideFindUI();
    } else if (name == "wc.download") {
        fView->DownloadURL(StringOf(command, "url").c_str());
    } else if (name == "wc.focus") {
        fView->MakeFocus(true);
    } else if (name == "wc.exec") {
#if AURORA_HAVE_EMBEDDING
        fView->EvaluateJavaScript(StringOf(command, "code").c_str(), BMessenger(this), request, BoolOf(command, "async", false));
#else
        SendError(request, "This WebKit build cannot run scripts for the runtime");
#endif
        return;
    } else if (name == "wc.setUserAgent") {
#if AURORA_HAVE_EMBEDDING
        fView->SetCustomUserAgent(StringOf(command, "userAgent").c_str());
#endif
    } else if (request) {
        SendError(request, "Unknown web contents command " + name);
        return;
    }
    if (request)
        SendResponse(request, nullptr);
}

void AppWindow::MessageReceived(BMessage* message)
{
    switch (message->what) {
    case kCommandMessage: {
        json* command = nullptr;
        if (message->FindPointer("command", reinterpret_cast<void**>(&command)) == B_OK && command) {
            HandleCommand(*command);
            delete command;
        }
        return;
    }
    case kApplicationMenuMessage: {
        json* menu = nullptr;
        if (message->FindPointer("menu", reinterpret_cast<void**>(&menu)) == B_OK && menu) {
            fApplicationMenu = *menu;
            delete menu;
            if (!fHasOwnMenu)
                SetMenu(&fApplicationMenu);
        }
        return;
    }
    case kMenuItemMessage:
        MenuItemInvoked(message);
        return;
    case B_WEBKIT_STATE_CHANGED:
    case B_WEBKIT_PROCESS_EXITED:
        WebKitState(message);
        return;
    case B_WEBKIT_CLOSE_REQUESTED:
    case B_WEBKIT_CLOSE_CANCELLED:
        WebKitCloseResult(message);
        return;
    case B_WEBKIT_CLOSE_PROMPT:
        // A beforeunload question is about to be shown for this window.
        if (IsHidden())
            Show();
        Activate(true);
        return;
    case B_WEBKIT_CLOSE_COMMITTED:
        WebKitCloseCommitted(message);
        return;
    case B_WEBKIT_NEW_PAGE_REQUESTED: {
        json event = {
            { "ev", "wc.new-page" }, { "id", fIdentifier },
            { "identifier", message->GetUInt64("identifier", 0) },
            { "url", message->GetString("url", "about:blank") },
            { "popup", message->GetBool("popup", false) },
            { "userGesture", message->GetBool("user_gesture", false) },
            { "modifiers", message->GetInt32("modifiers", 0) }
        };
        float value;
        for (const char* field : { "width", "height", "x", "y" }) {
            if (message->FindFloat(field, &value) == B_OK)
                event[field] = value;
        }
        SendEvent(event);
        return;
    }
    case B_WEBKIT_LINK_OPEN_REQUESTED:
        SendEvent({ { "ev", "wc.link-open" }, { "id", fIdentifier }, { "url", message->GetString("url", "") },
            { "modifiers", message->GetInt32("modifiers", 0) }, { "button", message->GetInt32("button", 0) } });
        return;
    case B_WEBKIT_LINK_HOVERED:
        SendEvent({ { "ev", "wc.link-hover" }, { "id", fIdentifier }, { "url", message->GetString("url", "") } });
        return;
    case B_WEBKIT_ICON_LOADED:
        SendEvent({ { "ev", "wc.favicon" }, { "id", fIdentifier }, { "iconURL", message->GetString("iconURL", "") } });
        return;
    case B_WEBKIT_FIND_RESULT:
        SendEvent({ { "ev", "wc.find-result" }, { "id", fIdentifier }, { "query", message->GetString("query", "") },
            { "found", message->GetBool("found", false) } });
        return;
    case B_WEBKIT_CONTEXT_MENU: {
        BPoint where;
        message->FindPoint("where", &where);
        BPoint screen = fView ? fView->ConvertToScreen(where) : where;
        json params = { { "ev", "wc.context-menu" }, { "id", fIdentifier },
            { "x", where.x }, { "y", where.y }, { "screenX", screen.x }, { "screenY", screen.y },
            { "isEditable", message->GetBool("editable", false) } };
        for (const char* field : { "frame_url", "selected_text", "link_url", "link_label", "image_url", "media_url" })
            params[field] = message->GetString(field, "");
        SendEvent(params);
        return;
    }
#if AURORA_HAVE_EMBEDDING
    case B_WEBKIT_SCRIPT_MESSAGE: {
        // Pages opened by window.open() share this window's handler: messages
        // from their views belong to their own windows.
        BMessenger sender;
        if (message->FindMessenger("view", &sender) == B_OK && fView && sender != BMessenger(fView)
            && !message->GetBool("aurora:routed", false)) {
            message->AddBool("aurora:routed", true);
            be_app->PostMessage(message);
            return;
        }
        SendEvent({ { "ev", "ipc.message" }, { "id", fIdentifier },
            { "token", message->GetUInt64("reply_token", 0) },
            { "name", message->GetString("name", "") },
            { "body", message->GetString("body", "") },
            { "bodyType", message->GetString("body_type", "string") },
            { "mainFrame", message->GetBool("main_frame", true) },
            { "frameUrl", message->GetString("frame_url", "") },
            { "origin", message->GetString("origin", "") } });
        return;
    }
    case B_WEBKIT_JAVASCRIPT_RESULT: {
        json event = { { "ev", "js.result" }, { "id", fIdentifier }, { "req", message->GetUInt64("identifier", 0) } };
        const char* error;
        if (message->FindString("error", &error) == B_OK)
            event["error"] = error;
        else {
            event["result"] = message->GetString("result", "");
            event["resultType"] = message->GetString("result_type", "undefined");
        }
        SendEvent(event);
        return;
    }
    case B_WEBKIT_URL_SCHEME_REQUEST: {
        json headers = json::array();
        const char* headerName;
        const char* headerValue;
        for (int32 index = 0; message->FindString("header_name", index, &headerName) == B_OK
            && message->FindString("header_value", index, &headerValue) == B_OK; index++)
            headers.push_back({ headerName, headerValue });
        json event = { { "ev", "scheme.request" }, { "id", fIdentifier },
            { "identifier", message->GetUInt64("identifier", 0) },
            { "scheme", message->GetString("scheme", "") }, { "url", message->GetString("url", "") },
            { "method", message->GetString("method", "GET") }, { "headers", headers },
            { "mainFrame", message->GetBool("main_frame", false) } };
        const void* body;
        ssize_t size;
        if (message->FindData("body", B_RAW_TYPE, &body, &size) == B_OK && size > 0)
            event["body"] = Base64Encode(body, size);
        SendEvent(event);
        return;
    }
    case kBeforeUnloadPrevented:
        // During a close, B_WEBKIT_CLOSE_CANCELLED follows and says the same.
        if (!fClosing)
            SendEvent({ { "ev", "wc.will-prevent-unload" }, { "id", fIdentifier } });
        return;
    case B_WEBKIT_URL_SCHEME_REQUEST_STOPPED:
        SendEvent({ { "ev", "scheme.stopped" }, { "identifier", message->GetUInt64("identifier", 0) } });
        return;
#endif
    default:
        BWindow::MessageReceived(message);
    }
}

} // namespace aurora
