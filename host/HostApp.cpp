/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "HostApp.h"

#include "AppWindow.h"
#include "Dialogs.h"
#include "Embedding.h"
#include "MenuBuilder.h"
#include "WebsiteData.h"

#include <Beep.h>
#include <Clipboard.h>
#include <Deskbar.h>
#include <Directory.h>
#include <FindDirectory.h>
#include <Menu.h>
#include <MenuItem.h>
#include <Notification.h>
#include <Path.h>
#include <PopUpMenu.h>
#include <Roster.h>
#include <Screen.h>
#include <WebKit/WebKitContext.h>
#include <WebKit/WebKitView.h>
#include <cstring>
#include <filesystem>

namespace aurora {

namespace {

enum : uint32 {
    kExitPulseMessage = 'aext'
};

// A pop-up menu that says when it closes, chosen item or not.
class PopUpMenu final : public BPopUpMenu {
public:
    explicit PopUpMenu(uint64 request)
        : BPopUpMenu("context menu", false, false)
        , fRequest(request)
    {
        SetAsyncAutoDestruct(true);
    }

    void Hide() override
    {
        BPopUpMenu::Hide();
        if (fReported)
            return;
        fReported = true;
        BMessage closed(kPopUpResultMessage);
        closed.AddUInt64("request", fRequest);
        be_app->PostMessage(&closed);
    }

private:
    const uint64 fRequest;
    bool fReported = false;
};

void TargetItems(BMenu* menu, BMessenger target, uint64 request)
{
    for (int32 index = 0; index < menu->CountItems(); index++) {
        BMenuItem* item = menu->ItemAt(index);
        if (BMenu* submenu = item->Submenu()) {
            TargetItems(submenu, target, request);
            continue;
        }
        if (BMessage* message = item->Message())
            message->AddUInt64("popup", request);
        item->SetTarget(target);
    }
}

float DisplayScale()
{
#if AURORA_LEGACY_ENGINE
    return 1;
#else
    return BWebKitDisplayScale();
#endif
}

std::string DirectoryPath(directory_which which)
{
    BPath path;
    return find_directory(which, &path) == B_OK ? path.Path() : "";
}

} // namespace

HostApp::HostApp(const char* signature)
    : BApplication(signature)
{
}

HostApp::~HostApp()
{
    if (fDialogs && fDialogs->Lock())
        fDialogs->Quit();
}

json HostApp::Screens()
{
    BScreen screen(B_MAIN_SCREEN_ID);
    BRect frame = screen.Frame();
    json bounds = { { "x", frame.left }, { "y", frame.top }, { "width", frame.Width() + 1 }, { "height", frame.Height() + 1 } };
    json workArea = bounds;
    BDeskbar deskbar;
    BRect bar = deskbar.Frame();
    if (bar.IsValid()) {
        // Keep windows clear of a Deskbar that spans the top or bottom edge.
        if (bar.Width() >= frame.Width() / 2 && bar.top <= frame.top + 1) {
            workArea["y"] = bar.bottom + 1;
            workArea["height"] = frame.bottom - bar.bottom;
        } else if (bar.Width() >= frame.Width() / 2 && bar.bottom >= frame.bottom - 1) {
            workArea["height"] = bar.top - frame.top;
        }
    }
    return json::array({ { { "id", 0 }, { "bounds", bounds }, { "workArea", workArea },
        { "scaleFactor", DisplayScale() }, { "rotation", 0 }, { "internal", false } } });
}

bool HostApp::DarkMode()
{
    rgb_color color = ui_color(B_PANEL_BACKGROUND_COLOR);
    return color.red * 0.299 + color.green * 0.587 + color.blue * 0.114 < 128;
}

void HostApp::ReadyToRun()
{
    fDialogs = new DialogLooper();
    fDialogs->Run();
    status_t status = BWebKitInitialize();
    fEngineReady = status == B_OK;
    fWebsiteData = std::make_unique<WebsiteData>(BMessenger(this));
    be_clipboard->StartWatching(BMessenger(this));
    fDownloadsPath = DirectoryPath(B_USER_DIRECTORY) + "/Downloads";
    SendEvent({ { "ev", "ready" }, { "engine", fEngineReady },
        { "engineError", fEngineReady ? "" : strerror(status) },
        { "embedding", AURORA_HAVE_EMBEDDING != 0 }, { "websiteData", WebsiteData::Available() },
        { "screens", Screens() }, { "darkMode", DarkMode() },
        { "clipboard", ReadClipboard() },
        { "paths", { { "home", DirectoryPath(B_USER_DIRECTORY) }, { "settings", DirectoryPath(B_USER_SETTINGS_DIRECTORY) },
            { "cache", DirectoryPath(B_USER_CACHE_DIRECTORY) }, { "desktop", DirectoryPath(B_DESKTOP_DIRECTORY) },
            { "downloads", fDownloadsPath }, { "temp", DirectoryPath(B_SYSTEM_TEMP_DIRECTORY) } } } });
    StartCommandReader();
}

std::shared_ptr<BWebKitContext> HostApp::ContextFor(const std::string& partition)
{
    auto found = fContexts.find(partition);
    if (found != fContexts.end())
        return found->second;
    bool persistent = partition.empty() || partition.rfind("persist:", 0) == 0;
    std::string path;
    if (persistent && !fUserDataPath.empty()) {
        path = fUserDataPath + (partition.empty() ? "/WebKit" : "/Partitions/" + partition.substr(8));
        std::error_code error;
        std::filesystem::create_directories(path, error);
    }
    auto context = std::make_shared<BWebKitContext>(path.empty() ? nullptr : path.c_str(), !persistent);
    if (context->InitCheck() != B_OK)
        return nullptr;
    context->SetDownloadListener(BMessenger(this));
    std::error_code error;
    std::filesystem::create_directories(fDownloadsPath, error);
    context->SetDownloadDirectory(fDownloadsPath.c_str());
    fContexts[partition] = context;
    return context;
}

void HostApp::CreateWindow(const json& command)
{
    uint64 request = static_cast<uint64>(NumberOf(command, "req", 0));
    int32 identifier = static_cast<int32>(NumberOf(command, "id", 0));
    json options = command.value("options", json::object());
    if (!fEngineReady || fWindows.count(identifier)) {
        SendError(request, fEngineReady ? "A window with this identifier exists" : "WebKit could not be initialized");
        return;
    }
    auto context = ContextFor(StringOf(options, "partition"));
    if (!context) {
        SendError(request, "Could not open the web profile for this window");
        return;
    }
    auto newPageRequest = static_cast<uint64>(NumberOf(command, "newPageRequest", 0));
    auto* window = new AppWindow(identifier, options, context, fHasApplicationMenu ? &fApplicationMenu : nullptr, newPageRequest);
    fWindows[identifier] = window;
    if (BoolOf(options, "show", true))
        window->Show();
    else
        window->StartHidden();
    SendResponse(request, { { "id", identifier } });
}

void HostApp::ShowPopUpMenu(const json& command)
{
    uint64 request = static_cast<uint64>(NumberOf(command, "req", 0));
    int32 identifier = static_cast<int32>(NumberOf(command, "window", -1));
    auto* menu = new PopUpMenu(request);
    AddMenuItems(menu, command.value("menu", json::array()), identifier);
    auto window = fWindows.find(identifier);
    TargetItems(menu, window != fWindows.end() ? BMessenger(window->second) : BMessenger(this), request);
    BPoint where(NumberOf(command, "x", 0), NumberOf(command, "y", 0));
    if (!HasNumber(command, "x")) {
        uint32 buttons;
        BPoint pointer;
        if (get_mouse(&pointer, &buttons) == B_OK)
            where = pointer;
    }
    menu->Go(where, true, false, true);
    SendResponse(request, nullptr);
}

json HostApp::ReadClipboard()
{
    json result = { { "text", "" }, { "html", "" } };
    if (!be_clipboard->Lock())
        return result;
    if (BMessage* data = be_clipboard->Data()) {
        const char* text;
        ssize_t size;
        if (data->FindData("text/plain", B_MIME_TYPE, reinterpret_cast<const void**>(&text), &size) == B_OK)
            result["text"] = std::string(text, strnlen(text, size));
        if (data->FindData("text/html", B_MIME_TYPE, reinterpret_cast<const void**>(&text), &size) == B_OK)
            result["html"] = std::string(text, strnlen(text, size));
    }
    be_clipboard->Unlock();
    return result;
}

void HostApp::WriteClipboard(const json& command)
{
    if (!be_clipboard->Lock())
        return;
    be_clipboard->Clear();
    BMessage* data = be_clipboard->Data();
    std::string text = StringOf(command, "text");
    std::string html = StringOf(command, "html");
    if (!text.empty() || html.empty())
        data->AddData("text/plain", B_MIME_TYPE, text.data(), text.size());
    if (!html.empty())
        data->AddData("text/html", B_MIME_TYPE, html.data(), html.size());
    be_clipboard->Commit();
    be_clipboard->Unlock();
}

void HostApp::ShowNotification(const json& command)
{
    BNotification notification(B_INFORMATION_NOTIFICATION);
    notification.SetGroup(fApplicationName.empty() ? "Aurora" : fApplicationName.c_str());
    notification.SetTitle(StringOf(command, "title").c_str());
    notification.SetContent(StringOf(command, "body").c_str());
    std::string tag = StringOf(command, "tag");
    if (!tag.empty())
        notification.SetMessageID(tag.c_str());
    notification.Send();
}

void HostApp::ForwardDownload(BMessage* message)
{
    const char* type = message->what == B_WEBKIT_DOWNLOAD_STARTED ? "started"
        : message->what == B_WEBKIT_DOWNLOAD_PROGRESS ? "progress" : "finished";
    json event = { { "ev", "download" }, { "type", type },
        { "identifier", message->GetUInt64("identifier", 0) }, { "url", message->GetString("url", "") },
        { "path", message->GetString("path", "") }, { "filename", message->GetString("filename", "") },
        { "received", message->GetUInt64("current_size", 0) }, { "total", message->GetInt64("expected_size", -1) } };
    if (message->what == B_WEBKIT_DOWNLOAD_FINISHED) {
        uint32 result = message->GetUInt32("result", B_WEBKIT_DOWNLOAD_FAILED);
        event["state"] = result == B_WEBKIT_DOWNLOAD_SUCCEEDED ? "completed" : result == B_WEBKIT_DOWNLOAD_CANCELLED ? "cancelled" : "interrupted";
        event["error"] = message->GetString("error_description", "");
    }
    BMessenger view;
    if (message->FindMessenger("view", &view) == B_OK) {
        for (auto& [identifier, window] : fWindows) {
            if (view.Target(nullptr) && BMessenger(window).Team() == view.Team() && window->FindView("web contents")
                && BMessenger(window->FindView("web contents")) == view)
                event["window"] = identifier;
        }
    }
    SendEvent(event);
}

void HostApp::HandleCommand(json& command)
{
    std::string name = StringOf(command, "cmd");
    uint64 request = static_cast<uint64>(NumberOf(command, "req", 0));
    if (name == "window.create") {
        CreateWindow(command);
    } else if ((name.rfind("window.", 0) == 0 || name.rfind("wc.", 0) == 0) && HasNumber(command, "id")) {
        auto found = fWindows.find(static_cast<int32>(NumberOf(command, "id")));
        if (found == fWindows.end()) {
            if (request)
                SendError(request, "No such window");
            return;
        }
        BMessage message(kCommandMessage);
        auto* copy = new json(std::move(command));
        message.AddPointer("command", copy);
        if (found->second->PostMessage(&message) != B_OK) {
            delete copy;
            if (request)
                SendError(request, "The window is closing");
        }
    } else if (name == "init") {
        fUserDataPath = StringOf(command, "userDataPath");
        fApplicationName = StringOf(command, "name");
        if (!fApplicationName.empty())
            fDialogs->SetApplicationName(fApplicationName);
        std::string downloads = StringOf(command, "downloadsPath");
        if (!downloads.empty())
            fDownloadsPath = downloads;
        SendResponse(request, nullptr);
    } else if (name == "menu.setApplicationMenu") {
        auto menu = command.find("menu");
        fHasApplicationMenu = menu != command.end() && menu->is_array();
        fApplicationMenu = fHasApplicationMenu ? *menu : json();
        for (auto& [identifier, window] : fWindows)
            AppWindow::PostApplicationMenu(window, fApplicationMenu);
        SendResponse(request, nullptr);
    } else if (name == "menu.popup") {
        ShowPopUpMenu(command);
    } else if (name == "dialog.open") {
        fDialogs->ShowOpenPanel(request, command.value("options", json::object()));
    } else if (name == "dialog.save") {
        fDialogs->ShowSavePanel(request, command.value("options", json::object()));
    } else if (name == "dialog.message") {
        fDialogs->ShowMessageBox(request, command.value("options", json::object()));
    } else if (name == "dialog.error") {
        fDialogs->ShowErrorBox(command);
        SendResponse(request, nullptr);
    } else if (name == "clipboard.write") {
        WriteClipboard(command);
        SendResponse(request, nullptr);
    } else if (name == "clipboard.clear") {
        if (be_clipboard->Lock()) {
            be_clipboard->Clear();
            be_clipboard->Commit();
            be_clipboard->Unlock();
        }
        SendResponse(request, nullptr);
    } else if (name == "clipboard.read") {
        SendResponse(request, ReadClipboard());
    } else if (name == "notification.show") {
        ShowNotification(command);
        SendResponse(request, nullptr);
    } else if (name == "screen.get") {
        SendResponse(request, Screens());
    } else if (name == "app.beep") {
        beep();
    } else if (name == "app.quit") {
        Exit();
#if AURORA_HAVE_EMBEDDING
    } else if (name == "ipc.reply") {
        auto error = command.find("error");
        BWebKitView::ReplyToScriptMessage(static_cast<uint64>(NumberOf(command, "token")), StringOf(command, "reply").c_str(),
            error != command.end() && error->is_string() ? error->get<std::string>().c_str() : nullptr);
    } else if (name == "scheme.respond") {
        BMessage headers;
        auto list = command.find("headers");
        if (list != command.end() && list->is_array()) {
            for (auto& header : *list) {
                if (header.is_array() && header.size() == 2 && header[0].is_string() && header[1].is_string()) {
                    headers.AddString("name", header[0].get<std::string>().c_str());
                    headers.AddString("value", header[1].get<std::string>().c_str());
                }
            }
        }
        auto data = Base64Decode(StringOf(command, "data"));
        std::string mimeType = StringOf(command, "mimeType");
        BWebKitView::RespondToURLSchemeRequest(static_cast<uint64>(NumberOf(command, "identifier")),
            static_cast<int32>(NumberOf(command, "status", 200)), mimeType.empty() ? nullptr : mimeType.c_str(),
            &headers, data.data(), data.size());
    } else if (name == "scheme.fail") {
        BWebKitView::FailURLSchemeRequest(static_cast<uint64>(NumberOf(command, "identifier")), StringOf(command, "description").c_str());
#endif
#if !AURORA_LEGACY_ENGINE
    } else if (name == "newpage.decline") {
        BWebKitView::DeclineNewPage(static_cast<uint64>(NumberOf(command, "identifier")));
#endif
    } else if (name.rfind("session.", 0) == 0) {
        fWebsiteData->Handle(name, command, request, ContextFor(StringOf(command, "partition")));
    } else if (name == "download.cancel") {
        for (auto& [partition, context] : fContexts)
            context->CancelDownload(static_cast<uint64>(NumberOf(command, "identifier")));
    } else if (request) {
        SendError(request, "Unknown command " + name);
    }
}

void HostApp::Exit()
{
    if (!fQuitting) {
        fQuitting = true;
        for (auto& [identifier, window] : fWindows) {
            BMessage message(kCommandMessage);
            message.AddPointer("command", new json({ { "cmd", "window.destroy" }, { "id", identifier } }));
            if (window->PostMessage(&message) != B_OK) {
                void* pointer;
                if (message.FindPointer("command", &pointer) == B_OK)
                    delete static_cast<json*>(pointer);
            }
        }
        for (auto& [partition, context] : fContexts)
            context->CancelAllDownloads();
        SetPulseRate(100000);
    }
    static bigtime_t started = system_time();
    bool pending = !fWindows.empty() || BWebKitHasPendingNativeUI();
    for (auto& [partition, context] : fContexts)
        pending |= context->HasPendingDownloads();
    // Give windows, dialogs and downloads three seconds to wind down.
    if (pending && system_time() - started < 3000000)
        return;
    SetPulseRate(0);
    fContexts.clear();
    Quit();
}

bool HostApp::QuitRequested()
{
    if (fQuitting)
        return true;
    // Deskbar's Quit and Command-Q: the runtime decides, as Electron's app does.
    SendEvent({ { "ev", "app.quit-requested" } });
    return false;
}

void HostApp::RefsReceived(BMessage* message)
{
    entry_ref ref;
    for (int32 index = 0; message->FindRef("refs", index, &ref) == B_OK; index++) {
        BPath path(&ref);
        if (path.InitCheck() == B_OK)
            SendEvent({ { "ev", "app.open-file" }, { "path", path.Path() } });
    }
}

void HostApp::ArgvReceived(int32, char**)
{
    // The runtime passes its own arguments; a second launch is its own team.
}

void HostApp::MessageReceived(BMessage* message)
{
    if (WebsiteData::IsAnswer(message->what)) {
        WebsiteData::Answer(message);
        return;
    }
    switch (message->what) {
    case kCommandMessage: {
        const char* text;
        if (message->FindString("json", &text) != B_OK)
            return;
        json command = json::parse(text, nullptr, false);
        if (command.is_object())
            HandleCommand(command);
        return;
    }
    case kInputClosedMessage:
        Exit();
        return;
    case B_PULSE:
        if (fQuitting)
            Exit();
        return;
    case kWindowDestroyedMessage: {
        int32 identifier = message->GetInt32("window", -1);
        fWindows.erase(identifier);
        SendEvent({ { "ev", "window.closed" }, { "id", identifier } });
        if (fQuitting)
            Exit();
        return;
    }
#if AURORA_HAVE_EMBEDDING
    case B_WEBKIT_SCRIPT_MESSAGE: {
        // Routed here by a window whose handler another window's page used.
        BMessenger sender;
        if (message->FindMessenger("view", &sender) != B_OK)
            return;
        for (auto& [identifier, window] : fWindows) {
            if (window->ViewMessenger() == sender) {
                window->PostMessage(message);
                return;
            }
        }
        BWebKitView::ReplyToScriptMessage(message->GetUInt64("reply_token", 0), nullptr, "The page's window is gone");
        return;
    }
#endif
    case kMenuItemMessage:
        SendEvent({ { "ev", "menu.click" }, { "item", message->GetString("item", "") },
            { "popup", message->GetUInt64("popup", 0) } });
        return;
    case kPopUpResultMessage:
        SendEvent({ { "ev", "menu.closed" }, { "popup", message->GetUInt64("request", 0) } });
        return;
    case B_CLIPBOARD_CHANGED:
        SendEvent({ { "ev", "clipboard.changed" }, { "clipboard", ReadClipboard() } });
        return;
    case B_COLORS_UPDATED:
        SendEvent({ { "ev", "theme.changed" }, { "darkMode", DarkMode() } });
        return;
    case B_WEBKIT_DOWNLOAD_STARTED:
    case B_WEBKIT_DOWNLOAD_PROGRESS:
    case B_WEBKIT_DOWNLOAD_FINISHED:
        ForwardDownload(message);
        return;
    default:
        BApplication::MessageReceived(message);
    }
}

} // namespace aurora
