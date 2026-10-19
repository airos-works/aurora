/* Copyright (C) 2026 KunanyiOS contributors. SPDX-License-Identifier: MIT */
#include "Keychain.h"

#include <Key.h>
#include <KeyStore.h>
#include <OS.h>
#include <String.h>

#include <cstring>
#include <new>

namespace aurora {

namespace {

struct Request {
    json command;
    uint64 request;
};

std::string Describe(status_t status)
{
    return std::string("The key store failed: ") + strerror(status);
}

// The key with this service and account in the master keyring.
status_t FindKey(BKeyStore& store, const std::string& service, const std::string& account, BPasswordKey& key)
{
    return store.GetKey(B_KEY_TYPE_PASSWORD, service.c_str(), account.c_str(), key);
}

void Run(const json& command, uint64 request)
{
    std::string name = StringOf(command, "cmd");
    std::string service = StringOf(command, "service");
    std::string account = StringOf(command, "account");
    BKeyStore store;
    BPasswordKey key;
    if (name == "keystore.get") {
        status_t status = FindKey(store, service, account, key);
        if (status == B_OK)
            SendResponse(request, std::string(key.Password()));
        else if (status == B_ENTRY_NOT_FOUND)
            SendResponse(request, nullptr);
        else
            SendError(request, Describe(status));
    } else if (name == "keystore.set") {
        if (FindKey(store, service, account, key) == B_OK)
            store.RemoveKey(key);
        BPasswordKey password(StringOf(command, "password").c_str(), B_KEY_PURPOSE_GENERIC, service.c_str(),
            account.c_str());
        status_t status = store.AddKey(password);
        if (status == B_OK)
            SendResponse(request, nullptr);
        else
            SendError(request, Describe(status));
    } else if (name == "keystore.delete") {
        status_t status = FindKey(store, service, account, key);
        if (status == B_OK)
            status = store.RemoveKey(key);
        if (status == B_OK)
            SendResponse(request, true);
        else if (status == B_ENTRY_NOT_FOUND)
            SendResponse(request, false);
        else
            SendError(request, Describe(status));
    } else if (name == "keystore.find") {
        json credentials = json::array();
        uint32 cookie = 0;
        while (store.GetNextKey(B_KEY_TYPE_PASSWORD, B_KEY_PURPOSE_ANY, cookie, key) == B_OK) {
            if (service == key.Identifier())
                credentials.push_back({ { "account", key.SecondaryIdentifier() }, { "password", key.Password() } });
        }
        SendResponse(request, credentials);
    } else {
        SendError(request, "Unknown key store command " + name);
    }
}

int32 RunThread(void* data)
{
    Request* work = static_cast<Request*>(data);
    Run(work->command, work->request);
    delete work;
    return 0;
}

} // namespace

void HandleKeyStoreCommand(const json& command, uint64 request)
{
    Request* work = new(std::nothrow) Request { command, request };
    if (work == nullptr) {
        SendError(request, "Out of memory");
        return;
    }
    thread_id thread = spawn_thread(RunThread, "aurora key store", B_NORMAL_PRIORITY, work);
    if (thread < 0 || resume_thread(thread) != B_OK) {
        delete work;
        SendError(request, "Could not start the key store thread");
    }
}

} // namespace aurora
