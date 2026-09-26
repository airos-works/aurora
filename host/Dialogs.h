/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#pragma once

#include "Protocol.h"

#include <Looper.h>
#include <map>
#include <string>

class BFilePanel;
class BRefFilter;

namespace aurora {

// Electron's dialog module: file panels and message boxes. Every dialog is
// asynchronous; its answer is a response to the command's request number.
class DialogLooper final : public BLooper {
public:
    DialogLooper();
    ~DialogLooper() override;

    // Call from any thread; the looper runs them on its own.
    void ShowOpenPanel(uint64 request, const json& options);
    void ShowSavePanel(uint64 request, const json& options);
    void ShowMessageBox(uint64 request, const json& options);
    void ShowErrorBox(const json& options);
    // Named in panel titles ("pgAdmin 4: Open").
    void SetApplicationName(const std::string& name);

    void MessageReceived(BMessage*) override;

private:
    struct Panel {
        BFilePanel* panel = nullptr;
        BRefFilter* filter = nullptr;
        bool answered = false;
    };
    void Answer(uint64 request, const json& result);
    void FinishPanel(uint64 request);
    std::map<uint64, Panel> fPanels;
    std::string fApplicationName = "Aurora";
};

} // namespace aurora
