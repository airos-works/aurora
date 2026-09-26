/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

// aurora-host: the native half of the Aurora runtime. The Node.js main
// process (runtime/lib/host.js) starts it and drives it over stdin/stdout.

#include "Dialogs.h"
#include "Environment.h"
#include "HostApp.h"
#include "Launcher.h"
#include "Protocol.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace {

// aurora-host --dialog open|save|message <options>: one dialog, for Electron's
// synchronous dialog functions (runtime/lib/electron/dialog.js). Prints one
// protocol response with the answer and exits.
class DialogApplication final : public BApplication {
public:
    DialogApplication(std::string kind, std::string options)
        : BApplication("application/x-vnd.aurora-dialog"), fKind(std::move(kind)), fOptions(std::move(options)) { }

    void ReadyToRun() override
    {
        auto* dialogs = new aurora::DialogLooper();
        dialogs->SetQuitAfterAnswer(true);
        dialogs->Run();
        json options = json::parse(fOptions, nullptr, false);
        if (!options.is_object())
            options = json::object();
        if (fKind == "open")
            dialogs->ShowOpenPanel(1, options);
        else if (fKind == "save")
            dialogs->ShowSavePanel(1, options);
        else if (fKind == "message")
            dialogs->ShowMessageBox(1, options);
        else {
            aurora::SendError(1, "Unknown dialog " + fKind);
            Quit();
        }
    }

    bool QuitRequested() override { return true; }

private:
    const std::string fKind;
    const std::string fOptions;
};

} // namespace

int main(int argc, char** argv)
{
    if (argc == 4 && !strcmp(argv[1], "--dialog")) {
        aurora::InitProtocolOutput();
        DialogApplication application(argv[2], argv[3]);
        application.Run();
        std::fflush(nullptr);
        std::_Exit(0);
    }
    std::string signature = "application/x-vnd.aurora-app";
    for (int index = 1; index + 1 < argc; index++) {
        if (!strcmp(argv[index], "--signature"))
            signature = argv[index + 1];
    }
    aurora::ReexecForPrivateLibraries(argv);
    aurora::SetEngineExecutablePath();
    // Started from Deskbar as a packaged app: run the app's runtime as our child.
    if (!aurora::StartRuntimeIfLauncher(argc, argv))
        aurora::InitProtocolOutput();
    aurora::HostApp application(signature.c_str());
    if (application.InitCheck() != B_OK) {
        fprintf(stderr, "aurora-host: cannot start the application %s: %s\n", signature.c_str(), strerror(application.InitCheck()));
        return 1;
    }
    application.Run();
    // WebKit's worker threads may still be running their thread-local
    // destructors, which touch libbe's handler tokens; returning from main
    // would destroy those under them. Summit leaves the same way.
    std::fflush(nullptr);
    std::_Exit(0);
}
