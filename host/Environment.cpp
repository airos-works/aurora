/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "Environment.h"

#include <FindDirectory.h>
#include <OS.h>
#include <image.h>
#include <cstdio>
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

// glvnd's libEGL finds Mesa through a vendor file (egl_vendor.d/*.json) in
// directories fixed when it was built; a private Mesa is in none of them,
// and without it the web process has no EGL display and aborts. Point
// glvnd at the vendor file that came with this Mesa, or write one.
static void UseEglVendor(const std::string& mesa)
{
    if (getenv("__EGL_VENDOR_LIBRARY_FILENAMES") || getenv("__EGL_VENDOR_LIBRARY_DIRS"))
        return;
    std::string prefix = mesa.substr(0, mesa.rfind('/'));
    for (const char* directory : { "/data/glvnd/egl_vendor.d", "/share/glvnd/egl_vendor.d", "/egl_vendor.d" }) {
        if (IsDirectory(prefix + directory)) {
            setenv("__EGL_VENDOR_LIBRARY_DIRS", (prefix + directory).c_str(), 1);
            return;
        }
    }
    std::string library = mesa + "/libEGL_mesa.so.0";
    char cache[B_PATH_NAME_LENGTH];
    if (access(library.c_str(), R_OK) != 0
        || find_directory(B_USER_CACHE_DIRECTORY, -1, true, cache, sizeof(cache)) != B_OK)
        return;
    std::string directory = std::string(cache) + "/Aurora/egl_vendor.d";
    mkdir((std::string(cache) + "/Aurora").c_str(), 0755);
    mkdir(directory.c_str(), 0755);
    std::string file = directory + "/50_mesa.json";
    if (FILE* json = fopen(file.c_str(), "w")) {
        fprintf(json, "{\"file_format_version\": \"1.0.0\", \"ICD\": {\"library_path\": \"%s\"}}\n", library.c_str());
        fclose(json);
        setenv("__EGL_VENDOR_LIBRARY_FILENAMES", file.c_str(), 1);
    }
}

void UsePrivateLibraries()
{
    // The engine's own libraries stay where the runtime path finds them.
    std::string engine = ImagePath("libWebKit.so", B_LIBRARY_IMAGE);
    std::string mesa = getenv("AURORA_MESA_LIB") ? getenv("AURORA_MESA_LIB") : "";
    if (mesa.empty() && !engine.empty()) {
        // A bundle carries its Mesa: <bundle>/mesa/lib beside <bundle>/lib.
        std::string real = engine;
        if (char* resolved = realpath(engine.c_str(), nullptr)) {
            real = resolved;
            free(resolved);
        }
        std::string directory = real.substr(0, real.rfind('/'));
        std::string parent = directory.substr(0, directory.rfind('/'));
        for (const std::string& candidate : { directory + "/mesa/lib", parent + "/mesa/lib" }) {
            if (IsDirectory(candidate)) {
                mesa = candidate;
                break;
            }
        }
    }
    if (mesa.empty() && IsDirectory("/boot/home/summit-mesa/prefix/lib"))
        mesa = "/boot/home/summit-mesa/prefix/lib";
    if (mesa.empty() || !IsDirectory(mesa))
        return;
    UseEglVendor(mesa);
    std::string current = getenv("LIBRARY_PATH") ? getenv("LIBRARY_PATH") : "";
    if (current.rfind(mesa, 0) == 0)
        return;
    // For the engine's processes, which inherit it. Not for this one: it
    // would have to restart itself, and a restarted app loses the port the
    // roster made for it when Tracker or Deskbar launched it.
    std::string paths = mesa;
    if (!engine.empty())
        paths += ":" + engine.substr(0, engine.rfind('/'));
    paths += ":" + (current.empty() ? std::string("/boot/system/lib") : current);
    setenv("LIBRARY_PATH", paths.c_str(), 1);
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
