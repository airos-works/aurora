/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "Launcher.h"

#include "Protocol.h"

#include <OS.h>
#include <image.h>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <unistd.h>
#include <vector>

namespace aurora {

static std::string OwnPath()
{
    image_info info;
    int32 cookie = 0;
    while (get_next_image_info(B_CURRENT_TEAM, &cookie, &info) == B_OK) {
        if (info.type == B_APP_IMAGE)
            return info.name;
    }
    return std::string();
}

static std::string Resolve(const std::string& directory, const std::string& path)
{
    if (path.empty() || path[0] == '/')
        return path;
    return directory + "/" + path;
}

static bool sIsLauncher = false;

bool IsLauncher()
{
    return sIsLauncher;
}

bool StartRuntimeIfLauncher(int argc, char** argv)
{
    if (getenv("AURORA_HOST_CHILD"))
        return false;
    std::string self = OwnPath();
    size_t slash = self.rfind('/');
    if (self.empty() || slash == std::string::npos)
        return false;
    std::string directory = self.substr(0, slash);
    std::ifstream file(directory + "/aurora.json");
    if (!file)
        return false;
    std::stringstream text;
    text << file.rdbuf();
    json config = json::parse(text.str(), nullptr, false);
    if (!config.is_object() || StringOf(config, "app").empty()) {
        fprintf(stderr, "aurora-host: %s/aurora.json names no app\n", directory.c_str());
        return false;
    }
    std::string node = Resolve(directory, StringOf(config, "node", "/boot/system/bin/node"));
    std::string runtime = Resolve(directory, StringOf(config, "runtime", "/boot/system/data/aurora/runtime/lib/main.js"));
    std::string app = Resolve(directory, StringOf(config, "app"));

    int commands[2];
    int events[2];
    if (pipe(commands) != 0 || pipe(events) != 0) {
        fprintf(stderr, "aurora-host: cannot create pipes: %s\n", strerror(errno));
        return false;
    }
    pid_t child = fork();
    if (child < 0) {
        fprintf(stderr, "aurora-host: cannot start the runtime: %s\n", strerror(errno));
        return false;
    }
    if (child == 0) {
        // The runtime reads events on 3 and writes commands to 4.
        dup2(events[0], 3);
        dup2(commands[1], 4);
        for (int descriptor : { commands[0], commands[1], events[0], events[1] }) {
            if (descriptor > 4)
                close(descriptor);
        }
        setenv("AURORA_HOST_FDS", "3,4", 1);
        setenv("AURORA_HOST", self.c_str(), 1);
        std::string webkit = Resolve(directory, StringOf(config, "webkit"));
        if (!webkit.empty())
            setenv("AURORA_WEBKIT_BUNDLE", webkit.c_str(), 1);
        auto environment = config.find("env");
        if (environment != config.end() && environment->is_object()) {
            for (auto& [name, value] : environment->items()) {
                if (value.is_string())
                    setenv(name.c_str(), value.get<std::string>().c_str(), 1);
            }
        }
        std::vector<std::string> arguments = { node, runtime, app };
        for (int index = 1; index < argc; index++)
            arguments.push_back(argv[index]);
        std::vector<char*> pointers;
        for (auto& argument : arguments)
            pointers.push_back(argument.data());
        pointers.push_back(nullptr);
        execv(node.c_str(), pointers.data());
        fprintf(stderr, "aurora-host: cannot run %s: %s\n", node.c_str(), strerror(errno));
        _exit(127);
    }
    close(commands[1]);
    close(events[0]);
    SetProtocolDescriptors(commands[0], events[1]);
    sIsLauncher = true;
    return true;
}

} // namespace aurora
