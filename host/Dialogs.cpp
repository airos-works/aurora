/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "Dialogs.h"

#include <Alert.h>
#include <Application.h>
#include <Button.h>
#include <CheckBox.h>
#include <Directory.h>
#include <Entry.h>
#include <FilePanel.h>
#include <LayoutBuilder.h>
#include <Path.h>
#include <StringView.h>
#include <TextView.h>
#include <Window.h>
#include <algorithm>
#include <cstring>
#include <set>
// struct stat_beos, which BRefFilter::Filter() receives.
#include <compat/sys/stat.h>

namespace aurora {

namespace {

enum : uint32 {
    kOpenResult = 'dopn',
    kSaveResult = 'dsav',
    kAlertResult = 'dalr',
    kMessageBoxButton = 'dmbb',
    kMessageBoxResult = 'dmbr'
};

class ExtensionFilter final : public BRefFilter {
public:
    explicit ExtensionFilter(std::set<std::string> extensions)
        : fExtensions(std::move(extensions)) { }

    bool Filter(const entry_ref* ref, BNode*, struct stat_beos* stat, const char*) override
    {
        if (!stat || S_ISDIR(stat->st_mode) || S_ISLNK(stat->st_mode))
            return true;
        std::string name = ref->name;
        size_t dot = name.rfind('.');
        if (dot == std::string::npos)
            return false;
        std::string extension = name.substr(dot + 1);
        std::transform(extension.begin(), extension.end(), extension.begin(), ::tolower);
        return fExtensions.count(extension) > 0;
    }

private:
    const std::set<std::string> fExtensions;
};

// Electron filters are [{ name, extensions: ["sql", "*"] }]. Tracker panels
// have no filter menu, so every listed extension is shown at once.
BRefFilter* FilterFor(const json& options)
{
    auto filters = options.find("filters");
    if (filters == options.end() || !filters->is_array())
        return nullptr;
    std::set<std::string> extensions;
    for (auto& filter : *filters) {
        auto list = filter.find("extensions");
        if (list == filter.end() || !list->is_array())
            continue;
        for (auto& extension : *list) {
            if (!extension.is_string())
                continue;
            std::string value = extension.get<std::string>();
            if (value == "*" || value.empty())
                return nullptr;
            std::transform(value.begin(), value.end(), value.begin(), ::tolower);
            extensions.insert(value);
        }
    }
    return extensions.empty() ? nullptr : new ExtensionFilter(std::move(extensions));
}

bool HasProperty(const json& options, const char* property)
{
    auto properties = options.find("properties");
    if (properties == options.end() || !properties->is_array())
        return false;
    return std::any_of(properties->begin(), properties->end(),
        [property](const json& value) { return value.is_string() && value.get<std::string>() == property; });
}

void ApplyCommonOptions(BFilePanel* panel, const json& options, bool save, const std::string& application)
{
    std::string title = StringOf(options, "title", application + (save ? ": Save" : ": Open"));
    if (!title.empty() && panel->Window()->Lock()) {
        panel->Window()->SetTitle(title.c_str());
        panel->Window()->Unlock();
    }
    std::string label = StringOf(options, "buttonLabel");
    if (!label.empty())
        panel->SetButtonLabel(B_DEFAULT_BUTTON, label.c_str());
    std::string defaultPath = StringOf(options, "defaultPath");
    if (defaultPath.empty())
        return;
    BEntry entry(defaultPath.c_str(), true);
    if (entry.IsDirectory()) {
        panel->SetPanelDirectory(defaultPath.c_str());
        return;
    }
    BPath path(defaultPath.c_str());
    BPath parent;
    if (path.InitCheck() == B_OK && path.GetParent(&parent) == B_OK && BEntry(parent.Path()).IsDirectory())
        panel->SetPanelDirectory(parent.Path());
    if (save && path.Leaf())
        panel->SetSaveText(path.Leaf());
}

alert_type AlertTypeFor(const std::string& type)
{
    if (type == "error")
        return B_STOP_ALERT;
    if (type == "warning")
        return B_WARNING_ALERT;
    if (type == "question")
        return B_IDEA_ALERT;
    if (type == "info")
        return B_INFO_ALERT;
    return B_EMPTY_ALERT;
}

// Message boxes BAlert cannot show: more than three buttons, or a checkbox.
class MessageBoxWindow final : public BWindow {
public:
    MessageBoxWindow(uint64 request, const json& options, const std::vector<std::string>& buttons, BMessenger target)
        : BWindow(BRect(0, 0, 400, 150), StringOf(options, "title", "").c_str(), B_TITLED_WINDOW_LOOK,
            B_MODAL_APP_WINDOW_FEEL, B_NOT_RESIZABLE | B_NOT_ZOOMABLE | B_NOT_MINIMIZABLE
                | B_AUTO_UPDATE_SIZE_LIMITS | B_ASYNCHRONOUS_CONTROLS | B_CLOSE_ON_ESCAPE)
        , fRequest(request)
        , fTarget(target)
        , fCancelIdentifier(static_cast<int32>(NumberOf(options, "cancelId", -1)))
    {
        auto* message = new BTextView("message");
        message->SetText(StringOf(options, "message").c_str());
        message->MakeEditable(false);
        message->SetViewUIColor(B_PANEL_BACKGROUND_COLOR);
        BFont bold(be_bold_font);
        message->SetFontAndColor(&bold);
        message->SetExplicitMinSize(BSize(360, B_SIZE_UNSET));
        auto builder = BLayoutBuilder::Group<>(this, B_VERTICAL, B_USE_DEFAULT_SPACING);
        builder.SetInsets(B_USE_WINDOW_INSETS).Add(message);
        std::string detailText = StringOf(options, "detail");
        if (!detailText.empty()) {
            auto* detail = new BTextView("detail");
            detail->SetText(detailText.c_str());
            detail->MakeEditable(false);
            detail->SetViewUIColor(B_PANEL_BACKGROUND_COLOR);
            builder.Add(detail);
        }
        std::string checkboxLabel = StringOf(options, "checkboxLabel");
        if (!checkboxLabel.empty()) {
            fCheckBox = new BCheckBox("checkbox", checkboxLabel.c_str(), nullptr);
            fCheckBox->SetValue(BoolOf(options, "checkboxChecked", false) ? B_CONTROL_ON : B_CONTROL_OFF);
            builder.Add(fCheckBox);
        }
        auto row = builder.AddGroup(B_HORIZONTAL);
        row.AddGlue();
        int32 defaultIdentifier = static_cast<int32>(NumberOf(options, "defaultId", buttons.size() - 1));
        for (size_t index = 0; index < buttons.size(); index++) {
            auto* invoke = new BMessage(kMessageBoxButton);
            invoke->AddInt32("index", index);
            auto* button = new BButton(buttons[index].c_str(), invoke);
            row.Add(button);
            if (static_cast<int32>(index) == defaultIdentifier)
                SetDefaultButton(button);
        }
        row.End();
        CenterOnScreen();
    }

    void MessageReceived(BMessage* message) override
    {
        if (message->what == kMessageBoxButton) {
            Answer(message->GetInt32("index", 0));
            Quit();
            return;
        }
        BWindow::MessageReceived(message);
    }

    bool QuitRequested() override
    {
        Answer(fCancelIdentifier >= 0 ? fCancelIdentifier : 0);
        return true;
    }

private:
    void Answer(int32 index)
    {
        if (fAnswered)
            return;
        fAnswered = true;
        BMessage result(kMessageBoxResult);
        result.AddUInt64("request", fRequest);
        result.AddInt32("which", index);
        result.AddBool("checked", fCheckBox && fCheckBox->Value() == B_CONTROL_ON);
        fTarget.SendMessage(&result);
    }

    const uint64 fRequest;
    const BMessenger fTarget;
    const int32 fCancelIdentifier;
    BCheckBox* fCheckBox = nullptr;
    bool fAnswered = false;
};

} // namespace

DialogLooper::DialogLooper()
    : BLooper("aurora dialogs")
{
}

DialogLooper::~DialogLooper()
{
    for (auto& [request, panel] : fPanels) {
        delete panel.panel;
        delete panel.filter;
    }
}

void DialogLooper::SetApplicationName(const std::string& name)
{
    if (Lock()) {
        fApplicationName = name;
        Unlock();
    }
}

void DialogLooper::Answer(uint64 request, const json& result)
{
    SendResponse(request, result);
    if (fQuitAfterAnswer)
        be_app->PostMessage(B_QUIT_REQUESTED);
}

void DialogLooper::ShowOpenPanel(uint64 request, const json& options)
{
    if (!Lock())
        return;
    bool directories = HasProperty(options, "openDirectory");
    bool files = HasProperty(options, "openFile") || !directories;
    uint32 flavors = (files ? B_FILE_NODE : 0) | (directories ? B_DIRECTORY_NODE : 0);
    auto* message = new BMessage(kOpenResult);
    message->AddUInt64("request", request);
    BMessenger target(this);
    Panel entry;
    entry.filter = FilterFor(options);
    entry.panel = new BFilePanel(B_OPEN_PANEL, &target, nullptr, flavors, HasProperty(options, "multiSelections"),
        message, entry.filter, true, true);
    delete message;
    ApplyCommonOptions(entry.panel, options, false, fApplicationName);
    fPanels[request] = entry;
    entry.panel->Show();
    Unlock();
}

void DialogLooper::ShowSavePanel(uint64 request, const json& options)
{
    if (!Lock())
        return;
    auto* message = new BMessage(kSaveResult);
    message->AddUInt64("request", request);
    BMessenger target(this);
    Panel entry;
    entry.filter = FilterFor(options);
    entry.panel = new BFilePanel(B_SAVE_PANEL, &target, nullptr, B_FILE_NODE, false, message, entry.filter, true, true);
    delete message;
    ApplyCommonOptions(entry.panel, options, true, fApplicationName);
    fPanels[request] = entry;
    entry.panel->Show();
    Unlock();
}

void DialogLooper::ShowMessageBox(uint64 request, const json& options)
{
    std::vector<std::string> buttons;
    auto list = options.find("buttons");
    if (list != options.end() && list->is_array()) {
        for (auto& button : *list) {
            if (button.is_string())
                buttons.push_back(button.get<std::string>());
        }
    }
    if (buttons.empty())
        buttons.push_back("OK");
    if (buttons.size() > 3 || !StringOf(options, "checkboxLabel").empty()) {
        (new MessageBoxWindow(request, options, buttons, BMessenger(this)))->Show();
        return;
    }
    std::string text = StringOf(options, "message");
    std::string detail = StringOf(options, "detail");
    if (!detail.empty())
        text += "\n\n" + detail;
    auto* alert = new BAlert(StringOf(options, "title", "").c_str(), text.c_str(), buttons[0].c_str(),
        buttons.size() > 1 ? buttons[1].c_str() : nullptr, buttons.size() > 2 ? buttons[2].c_str() : nullptr,
        B_WIDTH_AS_USUAL, B_OFFSET_SPACING, AlertTypeFor(StringOf(options, "type", "none")));
    int32 cancel = static_cast<int32>(NumberOf(options, "cancelId", -1));
    if (cancel >= 0 && cancel < static_cast<int32>(buttons.size()))
        alert->SetShortcut(cancel, B_ESCAPE);
    int32 defaultButton = static_cast<int32>(NumberOf(options, "defaultId", 0));
    if (defaultButton >= 0 && defaultButton < static_cast<int32>(buttons.size()))
        alert->SetDefaultButton(alert->ButtonAt(defaultButton));
    auto* message = new BMessage(kAlertResult);
    message->AddUInt64("request", request);
    alert->Go(new BInvoker(message, BMessenger(this)));
}

void DialogLooper::ShowErrorBox(const json& options)
{
    auto* alert = new BAlert(StringOf(options, "title", "Error").c_str(), StringOf(options, "content").c_str(), "OK",
        nullptr, nullptr, B_WIDTH_AS_USUAL, B_STOP_ALERT);
    alert->SetShortcut(0, B_ESCAPE);
    alert->Go(nullptr);
}

void DialogLooper::FinishPanel(uint64 request)
{
    auto found = fPanels.find(request);
    if (found == fPanels.end())
        return;
    // Deleting the panel from its own notification is safe: this is our looper.
    delete found->second.panel;
    delete found->second.filter;
    fPanels.erase(found);
}

void DialogLooper::MessageReceived(BMessage* message)
{
    switch (message->what) {
    case kOpenResult: {
        uint64 request = message->GetUInt64("request", 0);
        json paths = json::array();
        entry_ref ref;
        for (int32 index = 0; message->FindRef("refs", index, &ref) == B_OK; index++) {
            BPath path(&ref);
            if (path.InitCheck() == B_OK)
                paths.push_back(path.Path());
        }
        auto found = fPanels.find(request);
        if (found != fPanels.end() && !found->second.answered) {
            found->second.answered = true;
            Answer(request, { { "canceled", paths.empty() }, { "filePaths", paths } });
        }
        break;
    }
    case kSaveResult: {
        uint64 request = message->GetUInt64("request", 0);
        entry_ref directory;
        const char* name;
        std::string result;
        if (message->FindRef("directory", &directory) == B_OK && message->FindString("name", &name) == B_OK) {
            BPath path(&directory);
            if (path.InitCheck() == B_OK && path.Append(name) == B_OK)
                result = path.Path();
        }
        auto found = fPanels.find(request);
        if (found != fPanels.end() && !found->second.answered) {
            found->second.answered = true;
            Answer(request, { { "canceled", result.empty() }, { "filePath", result } });
        }
        break;
    }
    case B_CANCEL: {
        // Sent whenever a panel hides, answered or not.
        void* source = nullptr;
        message->FindPointer("source", &source);
        for (auto& [request, panel] : fPanels) {
            if (panel.panel != source)
                continue;
            uint64 finished = request;
            if (!panel.answered) {
                bool save = panel.panel->PanelMode() == B_SAVE_PANEL;
                Answer(finished, save ? json { { "canceled", true }, { "filePath", "" } }
                                      : json { { "canceled", true }, { "filePaths", json::array() } });
            }
            FinishPanel(finished);
            break;
        }
        break;
    }
    case kAlertResult:
        Answer(message->GetUInt64("request", 0), { { "response", message->GetInt32("which", 0) }, { "checkboxChecked", false } });
        break;
    case kMessageBoxResult:
        Answer(message->GetUInt64("request", 0), { { "response", message->GetInt32("which", 0) },
            { "checkboxChecked", message->GetBool("checked", false) } });
        break;
    default:
        BLooper::MessageReceived(message);
    }
}

} // namespace aurora
