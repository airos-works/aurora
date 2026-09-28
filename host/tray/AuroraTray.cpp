/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

// aurora-tray: the Deskbar half of Electron's Tray. Deskbar loads this add-on
// by its signature and makes an AuroraTrayItem from the archive aurora-host
// sends it (TrayProtocol.h). The item draws the app's icon and sends clicks to
// the app, which shows the tray's menu itself; it leaves Deskbar when the app
// quits, however it quits.

#include "TrayProtocol.h"

#include <Bitmap.h>
#include <Deskbar.h>
#include <Roster.h>
#include <View.h>
#include <Window.h>
#include <new>

using namespace aurora;

class AuroraTrayItem : public BView {
public:
    explicit AuroraTrayItem(BMessage* archive)
        : BView(archive)
    {
        archive->FindMessenger(kTrayOwnerField, &fOwner);
        fTray = archive->GetInt32(kTrayIdField, 0);
        Update(archive);
    }

    ~AuroraTrayItem() override
    {
        delete fIcon;
    }

    // Deskbar looks this up by name, so it is defined out of line: an inline
    // one nothing calls would not be in the add-on at all.
    static BArchivable* Instantiate(BMessage* archive);

    status_t Archive(BMessage* into, bool deep) const override
    {
        status_t status = BView::Archive(into, deep);
        if (status != B_OK)
            return status;
        into->ReplaceString("class", kTrayClassName);
        into->AddString("add_on", kTraySignature);
        into->AddMessenger(kTrayOwnerField, fOwner);
        into->AddInt32(kTrayIdField, fTray);
        return B_OK;
    }

    void AttachedToWindow() override
    {
        BView::AttachedToWindow();
        AdoptParentColors();
        SetDrawingMode(B_OP_ALPHA);
        SetBlendingMode(B_PIXEL_ALPHA, B_ALPHA_OVERLAY);
        if (!fOwner.IsValid()) {
            Leave();
            return;
        }
        be_roster->StartWatching(BMessenger(this), B_REQUEST_QUIT);
        BMessage attached(kTrayAttachedMessage);
        attached.AddInt32(kTrayIdField, fTray);
        attached.AddMessenger("item", BMessenger(this));
        fOwner.SendMessage(&attached);
    }

    void DetachedFromWindow() override
    {
        be_roster->StopWatching(BMessenger(this));
        BView::DetachedFromWindow();
    }

    void Draw(BRect) override
    {
        if (fIcon)
            DrawBitmap(fIcon, fIcon->Bounds(), Bounds(), B_FILTER_BITMAP_BILINEAR);
    }

    void MouseDown(BPoint where) override
    {
        BMessage* current = Window() ? Window()->CurrentMessage() : nullptr;
        BMessage clicked(kTrayClickedMessage);
        clicked.AddInt32(kTrayIdField, fTray);
        clicked.AddInt32("buttons", current ? current->GetInt32("buttons", B_PRIMARY_MOUSE_BUTTON) : B_PRIMARY_MOUSE_BUTTON);
        clicked.AddInt32("clicks", current ? current->GetInt32("clicks", 1) : 1);
        clicked.AddPoint("where", ConvertToScreen(where));
        clicked.AddRect("frame", ConvertToScreen(Bounds()));
        if (fOwner.SendMessage(&clicked) != B_OK)
            Leave();
    }

    void MessageReceived(BMessage* message) override
    {
        switch (message->what) {
        case kTrayUpdateMessage:
            Update(message);
            Invalidate();
            break;
        case B_SOME_APP_QUIT:
            if (message->GetInt32("be:team", -1) == fOwner.Team())
                Leave();
            break;
        default:
            BView::MessageReceived(message);
        }
    }

private:
    void Update(const BMessage* message)
    {
        BMessage archive;
        if (message->FindMessage(kTrayIconField, &archive) == B_OK) {
            // An empty archive: no icon.
            delete fIcon;
            fIcon = archive.IsEmpty() ? nullptr : new (std::nothrow) BBitmap(&archive);
            if (fIcon && !fIcon->IsValid()) {
                delete fIcon;
                fIcon = nullptr;
            }
        }
        const char* toolTip;
        if (message->FindString(kTrayToolTipField, &toolTip) == B_OK)
            SetToolTip(toolTip[0] ? toolTip : nullptr);
    }

    // Deskbar does not answer a removal, so asking from its own window is safe.
    void Leave()
    {
        if (fLeaving)
            return;
        fLeaving = true;
        BDeskbar().RemoveItem(Name());
    }

    BMessenger fOwner;
    int32 fTray = 0;
    BBitmap* fIcon = nullptr;
    bool fLeaving = false;
};

BArchivable* AuroraTrayItem::Instantiate(BMessage* archive)
{
    if (!validate_instantiation(archive, kTrayClassName))
        return nullptr;
    return new (std::nothrow) AuroraTrayItem(archive);
}
