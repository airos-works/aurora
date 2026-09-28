/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "TrayIcons.h"

#include "tray/TrayProtocol.h"

#include <Application.h>
#include <Bitmap.h>
#include <ControlLook.h>
#include <DataIO.h>
#include <Deskbar.h>
#include <FindDirectory.h>
#include <Mime.h>
#include <MimeType.h>
#include <Path.h>
#include <Roster.h>
#include <String.h>
#include <TranslationUtils.h>
#include <View.h>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

namespace aurora {

namespace {

// The icon (a PNG in base64; empty for none) and tool tip of a tray command,
// as an item's fields.
void AddFields(BMessage& into, const json& command)
{
    auto icon = command.find("icon");
    if (icon != command.end() && icon->is_string()) {
        std::vector<uint8_t> data = Base64Decode(icon->get<std::string>());
        BMemoryIO input(data.data(), data.size());
        std::unique_ptr<BBitmap> bitmap(data.empty() ? nullptr : BTranslationUtils::GetBitmap(&input));
        BMessage archive;
        if (bitmap && bitmap->IsValid())
            bitmap->Archive(&archive);
        into.AddMessage(kTrayIconField, &archive);
    }
    auto toolTip = command.find("toolTip");
    if (toolTip != command.end() && toolTip->is_string())
        into.AddString(kTrayToolTipField, toolTip->get<std::string>().c_str());
}

// What BDeskbar::AddItem archives: an AuroraTrayItem, which only the add-on
// can make.
class ItemArchive final : public BView {
public:
    ItemArchive(BRect frame, const char* name, const BMessage& fields)
        : BView(frame, name, B_FOLLOW_NONE, B_WILL_DRAW)
        , fFields(fields)
    {
    }

    status_t Archive(BMessage* into, bool deep) const override
    {
        status_t status = BView::Archive(into, deep);
        if (status != B_OK)
            return status;
        into->RemoveName("class");
        into->AddString("class", kTrayClassName);
        into->AddString("add_on", kTraySignature);
        BMessenger owner;
        if (fFields.FindMessenger(kTrayOwnerField, &owner) == B_OK)
            into->AddMessenger(kTrayOwnerField, owner);
        into->AddInt32(kTrayIdField, fFields.GetInt32(kTrayIdField, 0));
        BMessage icon;
        if (fFields.FindMessage(kTrayIconField, &icon) == B_OK)
            into->AddMessage(kTrayIconField, &icon);
        const char* toolTip;
        if (fFields.FindString(kTrayToolTipField, &toolTip) == B_OK)
            into->AddString(kTrayToolTipField, toolTip);
        return B_OK;
    }

private:
    BMessage fFields;
};

// BDeskbar's request to add a view (Deskbar's kMsgAddView).
constexpr uint32 kDeskbarAddView = 'icon';
constexpr const char* kDeskbarApp = "application/x-vnd.Be-TSKB";

std::string DataPath(directory_which which)
{
    BPath path;
    return find_directory(which, &path) == B_OK ? std::string(path.Path()) + "/aurora/aurora-tray" : std::string();
}

} // namespace

TrayIcons::TrayIcons(BMessenger owner)
    : fOwner(owner)
{
}

TrayIcons::~TrayIcons()
{
    RemoveAll();
}

// The add-on beside the host (a build tree), or the aurora package's. Deskbar
// looks it up by signature, so its MIME type points at the one we use.
status_t TrayIcons::FindAddOn(entry_ref* ref)
{
    if (!fAddOnFound) {
        std::vector<std::string> candidates;
        if (const char* path = getenv("AURORA_TRAY_ADDON"))
            candidates.push_back(path);
        app_info info;
        BPath executable, directory;
        if (be_app->GetAppInfo(&info) == B_OK && executable.SetTo(&info.ref) == B_OK
            && executable.GetParent(&directory) == B_OK)
            candidates.push_back(std::string(directory.Path()) + "/aurora-tray");
        candidates.push_back(DataPath(B_SYSTEM_DATA_DIRECTORY));
        candidates.push_back(DataPath(B_USER_NONPACKAGED_DATA_DIRECTORY));
        for (const std::string& path : candidates) {
            BEntry entry(path.c_str(), true);
            if (!path.empty() && entry.IsFile() && entry.GetRef(&fAddOn) == B_OK) {
                fAddOnFound = true;
                break;
            }
        }
        if (!fAddOnFound)
            return B_ENTRY_NOT_FOUND;
        // As the roster registers an app: the type prefers itself, and its
        // hint is this file.
        BPath path(&fAddOn);
        create_app_meta_mime(path.Path(), false, true, true);
        BMimeType type(kTraySignature);
        entry_ref hint;
        if (type.GetAppHint(&hint) != B_OK || hint != fAddOn)
            type.SetAppHint(&fAddOn);
        char preferred[B_MIME_TYPE_LENGTH];
        if (type.GetPreferredApp(preferred) != B_OK || strcmp(preferred, kTraySignature) != 0)
            type.SetPreferredApp(kTraySignature);
    }
    *ref = fAddOn;
    return B_OK;
}

status_t TrayIcons::Create(int32 tray, const json& command)
{
    if (fItems.count(tray))
        return Update(tray, command);
    entry_ref addOn;
    status_t status = FindAddOn(&addOn);
    if (status != B_OK)
        return status;
    BMessage fields;
    fields.AddMessenger(kTrayOwnerField, fOwner);
    fields.AddInt32(kTrayIdField, tray);
    AddFields(fields, command);
    BString name;
    name.SetToFormat("Aurora tray %" B_PRId32 "-%" B_PRId32, fOwner.Team(), tray);
    ItemArchive view(BRect(BPoint(0, 0), be_control_look->ComposeIconSize(B_MINI_ICON)), name.String(), fields);
    // BDeskbar::AddItem() loses Deskbar's error when it wants the id.
    BMessage archive;
    status = view.Archive(&archive, true);
    if (status != B_OK)
        return status;
    BMessage request(kDeskbarAddView), reply;
    request.AddMessage("view", &archive);
    status = BMessenger(kDeskbarApp).SendMessage(&request, &reply);
    if (status != B_OK)
        return status;
    int32 identifier;
    if (reply.FindInt32("id", &identifier) != B_OK)
        return reply.GetInt32("error", B_ERROR);
    fItems[tray].deskbarId = identifier;
    return B_OK;
}

status_t TrayIcons::Update(int32 tray, const json& command)
{
    auto found = fItems.find(tray);
    if (found == fItems.end())
        return B_BAD_INDEX;
    BMessage update(kTrayUpdateMessage);
    AddFields(update, command);
    if (found->second.view.IsValid())
        found->second.view.SendMessage(&update);
    else
        found->second.pending.push_back(update);
    return B_OK;
}

bool TrayIcons::Handle(const std::string& name, const json& command, uint64 request)
{
    if (name.rfind("tray.", 0) != 0)
        return false;
    int32 tray = static_cast<int32>(NumberOf(command, "id", 0));
    status_t status = B_OK;
    if (name == "tray.create") {
        status = Create(tray, command);
    } else if (name == "tray.set") {
        status = Update(tray, command);
    } else if (name == "tray.destroy") {
        auto found = fItems.find(tray);
        if (found != fItems.end()) {
            BDeskbar().RemoveItem(found->second.deskbarId);
            fItems.erase(found);
        }
    } else {
        SendError(request, "Unknown command " + name);
        return true;
    }
    if (status == B_OK)
        SendResponse(request, nullptr);
    else
        SendError(request, std::string("Deskbar cannot show the tray icon: ") + strerror(status));
    return true;
}

bool TrayIcons::IsTrayMessage(uint32 what)
{
    return what == kTrayAttachedMessage || what == kTrayClickedMessage;
}

void TrayIcons::Received(BMessage* message)
{
    auto found = fItems.find(message->GetInt32(kTrayIdField, -1));
    if (found == fItems.end())
        return;
    Item& item = found->second;
    if (message->what == kTrayAttachedMessage) {
        message->FindMessenger("item", &item.view);
        for (BMessage& update : item.pending)
            item.view.SendMessage(&update);
        item.pending.clear();
        return;
    }
    int32 buttons = message->GetInt32("buttons", B_PRIMARY_MOUSE_BUTTON);
    BPoint where = message->GetPoint("where", BPoint());
    BRect frame = message->GetRect("frame", BRect());
    SendEvent({ { "ev", "tray.click" }, { "id", found->first },
        { "button", (buttons & B_SECONDARY_MOUSE_BUTTON) ? "right" : (buttons & B_TERTIARY_MOUSE_BUTTON) ? "middle" : "left" },
        { "clicks", message->GetInt32("clicks", 1) }, { "x", where.x }, { "y", where.y },
        { "bounds", { { "x", frame.left }, { "y", frame.top }, { "width", frame.Width() + 1 }, { "height", frame.Height() + 1 } } } });
}

void TrayIcons::RemoveAll()
{
    if (fItems.empty())
        return;
    BDeskbar deskbar;
    for (auto& [tray, item] : fItems)
        deskbar.RemoveItem(item.deskbarId);
    fItems.clear();
}

} // namespace aurora
