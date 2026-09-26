/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "Environment.h"

#include <OS.h>
#include <image.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace aurora {

static bool IsDirectory(const std::string& path)
{
    struct stat info;
    return !path.empty() && stat(path.c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}

static std::string ImagePath(const char* leaf, image_type type)
{
    image_info info;
    int32 cookie = 0;
    while (get_next_image_info(B_CURRENT_TEAM, &cookie, &info) == B_OK) {
        if (type == B_APP_IMAGE ? info.type == B_APP_IMAGE : strstr(info.name, leaf) != nullptr)
            return info.name;
    }
    return std::string();
}

void ReexecForPrivateLibraries(char** argv)
{
    if (getenv("AURORA_HOST_REEXEC"))
        return;
    std::string mesa = getenv("AURORA_MESA_LIB") ? getenv("AURORA_MESA_LIB") : "";
    if (mesa.empty() && IsDirectory("/boot/home/summit-mesa/prefix/lib"))
        mesa = "/boot/home/summit-mesa/prefix/lib";
    if (mesa.empty() || !IsDirectory(mesa))
        return;
    std::string current = getenv("LIBRARY_PATH") ? getenv("LIBRARY_PATH") : "";
    if (current.rfind(mesa, 0) == 0)
        return;
    // The engine's own libraries stay where the runtime path finds them.
    std::string engine = ImagePath("libWebKit.so", B_LIBRARY_IMAGE);
    std::string paths = mesa;
    if (!engine.empty())
        paths += ":" + engine.substr(0, engine.rfind('/'));
    paths += ":" + (current.empty() ? std::string("/boot/system/lib") : current);
    setenv("LIBRARY_PATH", paths.c_str(), 1);
    setenv("AURORA_HOST_REEXEC", "1", 1);
    std::string self = ImagePath(nullptr, B_APP_IMAGE);
    if (!self.empty())
        execv(self.c_str(), argv);
}

void SetEngineExecutablePath()
{
    if (getenv("WEBKIT_EXEC_PATH"))
        return;
    std::string library = ImagePath("libWebKit.so", B_LIBRARY_IMAGE);
    if (library.empty())
        return;
    // Through any symbolic link to the engine (a bundle's lib linked as
    // ~/config/non-packaged/lib/summit-webkit), to where it really is.
    if (char* resolved = realpath(library.c_str(), nullptr)) {
        library = resolved;
        free(resolved);
    }
    // The shared engine install keeps WebProcess beside libWebKit; a Summit
    // bundle keeps it one level up (<bundle>/lib/libWebKit.so.1).
    std::string directory = library.substr(0, library.rfind('/'));
    std::string parent = directory.substr(0, directory.rfind('/'));
    for (const std::string& candidate : { directory, parent }) {
        if (access((candidate + "/WebProcess").c_str(), X_OK) == 0) {
            setenv("WEBKIT_EXEC_PATH", candidate.c_str(), 1);
            return;
        }
    }
}

} // namespace aurora
