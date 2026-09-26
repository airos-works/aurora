/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */

#include "Protocol.h"

#include <Application.h>
#include <Message.h>
#include <OS.h>
#include <cerrno>
#include <cstdio>
#include <mutex>
#include <unistd.h>

namespace aurora {

static std::mutex sWriteLock;
static int sOutput = -1;
static int sInput = STDIN_FILENO;

static void WriteAll(int fd, const char* data, size_t size)
{
    while (size > 0) {
        ssize_t written = write(fd, data, size);
        if (written < 0) {
            if (errno == EINTR)
                continue;
            return;
        }
        data += written;
        size -= written;
    }
}

void SendEvent(const json& event)
{
    std::string line = "\x1e";
    // Replace invalid UTF-8 rather than throw: page titles and paths can hold anything.
    line += event.dump(-1, ' ', false, json::error_handler_t::replace);
    line += '\n';
    std::lock_guard guard(sWriteLock);
    WriteAll(sOutput >= 0 ? sOutput : STDOUT_FILENO, line.data(), line.size());
}

void SetProtocolDescriptors(int input, int output)
{
    std::lock_guard guard(sWriteLock);
    sInput = input;
    sOutput = output;
}

void InitProtocolOutput()
{
    std::lock_guard guard(sWriteLock);
    if (sOutput >= 0)
        return;
    fflush(stdout);
    sOutput = dup(STDOUT_FILENO);
    dup2(STDERR_FILENO, STDOUT_FILENO);
}

void SendResponse(uint64 request, const json& result)
{
    // Commands sent without a request number want no answer.
    if (!request)
        return;
    SendEvent({ { "ev", "response" }, { "req", request }, { "result", result } });
}

void SendError(uint64 request, const std::string& error)
{
    if (!request)
        return;
    SendEvent({ { "ev", "response" }, { "req", request }, { "error", error } });
}

static int32 ReadCommands(void*)
{
    std::string buffer;
    char chunk[65536];
    for (;;) {
        ssize_t count = read(sInput, chunk, sizeof(chunk));
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0)
            break;
        buffer.append(chunk, count);
        size_t start = 0;
        for (size_t end; (end = buffer.find('\n', start)) != std::string::npos; start = end + 1) {
            size_t begin = buffer.find('\x1e', start);
            if (begin == std::string::npos || begin >= end)
                continue;
            BMessage message(kCommandMessage);
            message.AddString("json", buffer.substr(begin + 1, end - begin - 1).c_str());
            be_app->PostMessage(&message);
        }
        buffer.erase(0, start);
    }
    be_app->PostMessage(kInputClosedMessage);
    return 0;
}

status_t StartCommandReader()
{
    thread_id thread = spawn_thread(ReadCommands, "aurora command reader", B_NORMAL_PRIORITY, nullptr);
    if (thread < 0)
        return thread;
    return resume_thread(thread);
}

static const char kBase64Alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string Base64Encode(const void* data, size_t size)
{
    const uint8_t* bytes = static_cast<const uint8_t*>(data);
    std::string result;
    result.reserve((size + 2) / 3 * 4);
    for (size_t index = 0; index < size; index += 3) {
        uint32 value = bytes[index] << 16;
        if (index + 1 < size)
            value |= bytes[index + 1] << 8;
        if (index + 2 < size)
            value |= bytes[index + 2];
        result += kBase64Alphabet[(value >> 18) & 63];
        result += kBase64Alphabet[(value >> 12) & 63];
        result += index + 1 < size ? kBase64Alphabet[(value >> 6) & 63] : '=';
        result += index + 2 < size ? kBase64Alphabet[value & 63] : '=';
    }
    return result;
}

std::vector<uint8_t> Base64Decode(const std::string& text)
{
    static int8 table[256];
    static std::once_flag once;
    std::call_once(once, [] {
        for (int index = 0; index < 256; index++)
            table[index] = -1;
        for (int index = 0; index < 64; index++)
            table[static_cast<uint8_t>(kBase64Alphabet[index])] = index;
        table[static_cast<uint8_t>('-')] = 62;
        table[static_cast<uint8_t>('_')] = 63;
    });
    std::vector<uint8_t> result;
    result.reserve(text.size() / 4 * 3);
    uint32 value = 0;
    int bits = 0;
    for (unsigned char character : text) {
        int8 digit = table[character];
        if (digit < 0)
            continue;
        value = (value << 6) | digit;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            result.push_back((value >> bits) & 0xff);
        }
    }
    return result;
}

std::string StringOf(const json& object, const char* key, const std::string& fallback)
{
    auto found = object.find(key);
    return found != object.end() && found->is_string() ? found->get<std::string>() : fallback;
}

double NumberOf(const json& object, const char* key, double fallback)
{
    auto found = object.find(key);
    return found != object.end() && found->is_number() ? found->get<double>() : fallback;
}

bool BoolOf(const json& object, const char* key, bool fallback)
{
    auto found = object.find(key);
    return found != object.end() && found->is_boolean() ? found->get<bool>() : fallback;
}

bool HasNumber(const json& object, const char* key)
{
    auto found = object.find(key);
    return found != object.end() && found->is_number();
}

} // namespace aurora
