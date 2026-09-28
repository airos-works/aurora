/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "MenuBuilder.h"

#include <InterfaceDefs.h>
#include <Menu.h>
#include <MenuBar.h>
#include <MenuItem.h>
#include <Message.h>
#include <cstring>

namespace aurora {

// Haiku menu shortcuts are one character with the Command key implied.
static char ShortcutCharacter(const std::string& key)
{
    if (key.size() == 1) {
        char character = key[0];
        return character >= 'A' && character <= 'Z' ? character - 'A' + 'a' : character;
    }
    if (key == "Plus")
        return '+';
    if (key == "Space")
        return ' ';
    if (key == "Up")
        return B_UP_ARROW;
    if (key == "Down")
        return B_DOWN_ARROW;
    if (key == "Left")
        return B_LEFT_ARROW;
    if (key == "Right")
        return B_RIGHT_ARROW;
    if (key == "Home")
        return B_HOME;
    if (key == "End")
        return B_END;
    if (key == "PageUp")
        return B_PAGE_UP;
    if (key == "PageDown")
        return B_PAGE_DOWN;
    if (key == "Delete")
        return B_DELETE;
    if (key == "Backspace")
        return B_BACKSPACE;
    if (key == "Tab")
        return B_TAB;
    if (key == "Enter" || key == "Return")
        return B_ENTER;
    if (key == "Escape" || key == "Esc")
        return B_ESCAPE;
    return 0;
}

static BMenuItem* BuildItem(const json& item, int32 windowIdentifier)
{
    std::string type = StringOf(item, "type", "normal");
    if (type == "separator")
        return new BSeparatorItem();
    std::string label = StringOf(item, "label");
    // Electron marks mnemonics with '&'; Haiku menus have none.
    std::string clean;
    for (size_t index = 0; index < label.size(); index++) {
        if (label[index] == '&' && index + 1 < label.size() && label[index + 1] != '&')
            continue;
        clean += label[index];
    }
    BMenuItem* result;
    auto submenu = item.find("submenu");
    if (submenu != item.end() && submenu->is_array()) {
        auto* menu = new BMenu(clean.c_str());
        AddMenuItems(menu, *submenu, windowIdentifier);
        result = new BMenuItem(menu);
    } else {
        auto* message = new BMessage(kMenuItemMessage);
        message->AddInt32("window", windowIdentifier);
        message->AddString("item", StringOf(item, "id").c_str());
        std::string role = StringOf(item, "role");
        if (!role.empty())
            message->AddString("role", role.c_str());
        message->AddString("type", type.c_str());
        // What a checkbox was when the menu was made: a pop-up's items may be
        // gone by the time their message is handled.
        message->AddBool("was checked", BoolOf(item, "checked", false));
        char shortcut = 0;
        uint32 modifiers = 0;
        std::string key = StringOf(item, "key");
        auto modifierList = item.find("modifiers");
        bool command = BoolOf(item, "command", false);
        if (modifierList != item.end() && modifierList->is_array()) {
            for (auto& modifier : *modifierList) {
                if (!modifier.is_string())
                    continue;
                std::string name = modifier.get<std::string>();
                if (name == "shift")
                    modifiers |= B_SHIFT_KEY;
                else if (name == "option")
                    modifiers |= B_OPTION_KEY;
                else if (name == "control")
                    modifiers |= B_CONTROL_KEY;
            }
        }
        // Only Command shortcuts can be menu shortcuts; others show as text.
        if (command)
            shortcut = ShortcutCharacter(key);
        if (!shortcut && !StringOf(item, "acceleratorLabel").empty())
            clean += "  (" + StringOf(item, "acceleratorLabel") + ")";
        result = new BMenuItem(clean.c_str(), message, shortcut, modifiers);
        if (type == "checkbox" || type == "radio")
            result->SetMarked(BoolOf(item, "checked", false));
    }
    result->SetEnabled(BoolOf(item, "enabled", true));
    return result;
}

void AddMenuItems(BMenu* menu, const json& items, int32 windowIdentifier)
{
    if (!items.is_array())
        return;
    bool lastWasSeparator = true;
    for (auto& item : items) {
        if (!item.is_object() || !BoolOf(item, "visible", true))
            continue;
        bool separator = StringOf(item, "type") == "separator";
        // Electron collapses leading and doubled separators.
        if (separator && lastWasSeparator)
            continue;
        menu->AddItem(BuildItem(item, windowIdentifier));
        lastWasSeparator = separator;
    }
    if (lastWasSeparator && menu->CountItems() > 0) {
        BMenuItem* last = menu->ItemAt(menu->CountItems() - 1);
        if (dynamic_cast<BSeparatorItem*>(last))
            delete menu->RemoveItem(menu->CountItems() - 1);
    }
}

BMenuBar* BuildMenuBar(const json& items, int32 windowIdentifier, float width)
{
    // The frame constructor sizes the bar's height to its font; the layout
    // constructor would leave it empty in a window without a layout.
    auto* bar = new BMenuBar(BRect(0, 0, width, 0), "menu bar");
    AddMenuItems(bar, items, windowIdentifier);
    return bar;
}

static bool IsRadio(BMenuItem* item)
{
    BMessage* message = item ? item->Message() : nullptr;
    const char* type;
    return message && message->FindString("type", &type) == B_OK && !strcmp(type, "radio");
}

static bool MarkIn(BMenu* menu, const char* identifier)
{
    for (int32 index = 0; index < menu->CountItems(); index++) {
        BMenuItem* item = menu->ItemAt(index);
        if (BMenu* submenu = item->Submenu()) {
            if (MarkIn(submenu, identifier))
                return true;
            continue;
        }
        BMessage* message = item->Message();
        const char* found;
        if (!message || message->FindString("item", &found) != B_OK || strcmp(found, identifier))
            continue;
        if (!IsRadio(item))
            return true;
        int32 first = index;
        while (first > 0 && IsRadio(menu->ItemAt(first - 1)))
            first--;
        for (int32 other = first; other < menu->CountItems() && IsRadio(menu->ItemAt(other)); other++)
            menu->ItemAt(other)->SetMarked(other == index);
        return true;
    }
    return false;
}

void MarkRadioItem(BMenu* menu, const char* itemIdentifier)
{
    if (menu && itemIdentifier)
        MarkIn(menu, itemIdentifier);
}

} // namespace aurora
