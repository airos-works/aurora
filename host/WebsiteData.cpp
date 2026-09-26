/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "WebsiteData.h"

#include "Embedding.h"

#include <Window.h>
#include <WebKit/WebKitContext.h>
#include <WebKit/WebKitView.h>

namespace aurora {

namespace {

// WebKitEmbedding.h's names, for engines from before they existed.
enum : uint32 {
    kCookies = 'wcok',
    kCookiesChanged = 'wcoc',
    kWebsiteDataRemoved = 'wdrm'
};

// The engine methods, where it has them.
template<typename View>
bool GetCookies(View* view, const char* url, BMessenger reply, uint64 identifier)
{
    if constexpr (requires { view->GetCookies(url, reply, identifier); }) {
        view->GetCookies(url, reply, identifier);
        return true;
    }
    return false;
}

template<typename View>
bool SetCookie(View* view, const BMessage& cookie, BMessenger reply, uint64 identifier)
{
    if constexpr (requires { view->SetCookie(cookie, reply, identifier); }) {
        view->SetCookie(cookie, reply, identifier);
        return true;
    }
    return false;
}

template<typename View>
bool DeleteCookies(View* view, const char* url, const char* name, BMessenger reply, uint64 identifier)
{
    if constexpr (requires { view->DeleteCookies(url, name, reply, identifier); }) {
        view->DeleteCookies(url, name, reply, identifier);
        return true;
    }
    return false;
}

template<typename View>
bool RemoveWebsiteData(View* view, uint32 types, BMessenger reply, uint64 identifier)
{
    if constexpr (requires { view->RemoveWebsiteData(types, reply, identifier); }) {
        view->RemoveWebsiteData(types, reply, identifier);
        return true;
    }
    return false;
}

template<typename View>
constexpr bool kHasWebsiteData = requires(View* view) { view->RemoveWebsiteData(uint32(), BMessenger(), uint64()); };

} // namespace

WebsiteData::WebsiteData(BMessenger replies)
    : fReplies(replies)
{
}

WebsiteData::~WebsiteData()
{
    for (auto& [partition, window] : fWindows) {
        if (window->Lock())
            window->Quit();
    }
}

bool WebsiteData::Available()
{
    return kHasWebsiteData<BWebKitView>;
}

BWebKitView* WebsiteData::ViewFor(const std::string& partition, const std::shared_ptr<BWebKitContext>& context)
{
    auto found = fViews.find(partition);
    if (found != fViews.end())
        return found->second;
    if (!context)
        return nullptr;
    // Never shown: Hide() before Show() runs the window's looper hidden.
    auto* window = new BWindow(BRect(-10, -10, -9, -9), "website data", B_NO_BORDER_WINDOW_LOOK,
        B_NORMAL_WINDOW_FEEL, B_AVOID_FOCUS | B_NOT_MOVABLE | B_NOT_RESIZABLE);
    auto* view = new BWebKitView(BRect(0, 0, 1, 1), "website data", fReplies, B_FOLLOW_NONE, context);
    window->AddChild(view);
    window->Hide();
    window->Show();
    fWindows[partition] = window;
    fViews[partition] = view;
    return view;
}

bool WebsiteData::Handle(const std::string& name, const json& command, uint64 request,
    const std::shared_ptr<BWebKitContext>& context)
{
    if (name.rfind("session.", 0) != 0)
        return false;
    if (!Available()) {
        SendError(request, "This WebKit build cannot reach a session's website data");
        return true;
    }
    BWebKitView* view = ViewFor(StringOf(command, "partition"), context);
    if (!view) {
        SendError(request, "The session has no website data store");
        return true;
    }
    bool started = false;
    if (name == "session.cookies.get") {
        started = GetCookies(view, StringOf(command, "url").c_str(), fReplies, request);
    } else if (name == "session.cookies.set") {
        const json empty = json::object();
        auto found = command.find("cookie");
        const json& fields = found != command.end() && found->is_object() ? *found : empty;
        BMessage cookie;
        for (const char* field : { "name", "value", "domain", "path", "sameSite" })
            cookie.AddString(field, StringOf(fields, field).c_str());
        for (const char* field : { "secure", "httpOnly" })
            cookie.AddBool(field, BoolOf(fields, field));
        // Milliseconds since the epoch; none makes a session cookie.
        if (HasNumber(fields, "expires"))
            cookie.AddDouble("expires", NumberOf(fields, "expires"));
        else
            cookie.AddBool("session", true);
        started = SetCookie(view, cookie, fReplies, request);
    } else if (name == "session.cookies.remove") {
        started = DeleteCookies(view, StringOf(command, "url").c_str(), StringOf(command, "name").c_str(), fReplies, request);
    } else if (name == "session.clearData") {
        started = RemoveWebsiteData(view, static_cast<uint32>(NumberOf(command, "types", 0xffffffff)), fReplies, request);
    } else {
        SendError(request, "Unknown command " + name);
        return true;
    }
    if (!started)
        SendError(request, "This WebKit build cannot reach a session's website data");
    return true;
}

bool WebsiteData::IsAnswer(uint32 what)
{
    return what == kCookies || what == kCookiesChanged || what == kWebsiteDataRemoved;
}

void WebsiteData::Answer(BMessage* message)
{
    uint64 request = message->GetUInt64("identifier", 0);
    const char* error;
    if (message->FindString("error", &error) == B_OK) {
        SendError(request, error);
        return;
    }
    if (message->what != kCookies) {
        SendResponse(request, nullptr);
        return;
    }
    json cookies = json::array();
    BMessage entry;
    for (int32 index = 0; message->FindMessage("cookie", index, &entry) == B_OK; index++) {
        json cookie = {
            { "name", entry.GetString("name", "") }, { "value", entry.GetString("value", "") },
            { "domain", entry.GetString("domain", "") }, { "path", entry.GetString("path", "/") },
            { "secure", entry.GetBool("secure", false) }, { "httpOnly", entry.GetBool("httpOnly", false) },
            { "session", entry.GetBool("session", true) }, { "sameSite", entry.GetString("sameSite", "none") }
        };
        double expires;
        if (entry.FindDouble("expires", &expires) == B_OK)
            cookie["expires"] = expires;
        cookies.push_back(std::move(cookie));
    }
    SendResponse(request, cookies);
}

} // namespace aurora
