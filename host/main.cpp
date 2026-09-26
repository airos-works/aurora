/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

// aurora-host: the native half of the Aurora runtime. The Node.js main
// process (runtime/lib/host.js) starts it and drives it over stdin/stdout.

#include "HostApp.h"
#include "Protocol.h"

#include <cstdio>
#include <cstring>
#include <string>

int main(int argc, char** argv)
{
    std::string signature = "application/x-vnd.aurora-app";
    for (int index = 1; index + 1 < argc; index++) {
        if (!strcmp(argv[index], "--signature"))
            signature = argv[index + 1];
    }
    aurora::InitProtocolOutput();
    aurora::HostApp application(signature.c_str());
    if (application.InitCheck() != B_OK) {
        fprintf(stderr, "aurora-host: cannot start the application %s: %s\n", signature.c_str(), strerror(application.InitCheck()));
        return 1;
    }
    application.Run();
    return 0;
}
