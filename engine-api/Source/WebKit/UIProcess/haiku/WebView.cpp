/*
 * Copyright (C) 2013 Intel Corporation. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ``AS IS''
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

#include "config.h"
#include "WebViewPrivate.h"

#include "APIData.h"
#include "APIFrameInfo.h"
#include "APIIconLoadingClient.h"
#include "BrowserTabRegistryHaiku.h"
#include "APIError.h"
#include "APINavigationAction.h"
#include "APINavigationClient.h"
#include "APINavigationResponse.h"
#include "DownloadRegistryHaiku.h"
#include "APIPageConfiguration.h"
#include "APINavigation.h"
#include "APIUIClient.h"
#include "DrawingAreaProxyHaiku.h"
#if USE(COORDINATED_GRAPHICS)
#include "AcceleratedBackingStore.h"
#endif
#if USE(COORDINATED_GRAPHICS)
#include "DrawingAreaProxyCoordinatedGraphics.h"
#endif
#include "FrameInfoData.h"
#include "JavaScriptDialogHaiku.h"
#include "NativeWebKeyboardEvent.h"
#include "NativeWebMouseEvent.h"
#include "NativeWebWheelEvent.h"
#include "OpenPanelHaiku.h"
#include "PageLoadState.h"
#include "WKAPICast.h"
#include "WKPage.h"
#include "WebColorPicker.h"
#include "WebContextMenuProxy.h"
#include "WebDataListSuggestionsDropdown.h"
#include "WebDateTimePicker.h"
#include "WebFindOptions.h"
#include "WebKitView.h"
#include "WebPageMessages.h"
#include "WebPopupMenuProxy.h"
#include "WebPopupMenuProxyHaiku.h"
#include "WebPreferences.h"
#include "WebProcessPool.h"
#include "WebProcessProxy.h"
#include "WebViewContextHaiku.h"
#include "WebHitTestResultData.h"
#if ENABLE(WK_WEB_EXTENSIONS)
#include "WebExtension.h"
#include "WebExtensionContext.h"
#include "WebExtensionController.h"
#include "WebExtensionMenuItem.h"
#include "WebExtensionMenuItemContextParameters.h"
#include "WebExtensionPermission.h"
#endif
#include <WebCore/Cursor.h>
#include <WebCore/WindowFeatures.h>
#include <WebCore/DOMPasteAccess.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceRequest.h>
#include <OS.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/CString.h>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <cstring>
#include <unordered_map>
#include <utility>

namespace WebKit {
using namespace WebCore;

WTF_MAKE_TZONE_ALLOCATED_IMPL(WebView);

template<typename Completion> static JavaScriptDialogRequestsHaiku::Completion dialogCompletionOnMainHaiku(Completion&& completion)
{
    auto callback = std::make_shared<std::decay_t<Completion>>(std::forward<Completion>(completion));
    return [callback = std::move(callback)](bool accepted, std::string value) mutable {
        RunLoop::mainSingleton().dispatch([callback = std::move(callback), accepted, value = std::move(value)] {
            (*callback)(accepted, value);
        });
    };
}

static void sendCloseNotificationHaiku(std::weak_ptr<WebViewStateHaiku> weakState, BMessage message,
    uint64_t generation, bool isPrompt, Function<void(bool)>&& completion)
{
    ASSERT(RunLoop::isMain());
    auto state = weakState.lock();
    if (!state || state->closed || state->closeRequestGeneration != generation
        || (isPrompt && (!state->closeRequestPending || state->closeDecisionInFlight))) {
        completion(false);
        return;
    }
    BMessenger view;
    if (message.FindMessenger("view", &view) != B_OK || !view.IsValid()) {
        completion(false);
        return;
    }
    bool matchesView;
    {
        std::lock_guard guard(state->mutex);
        matchesView = state->view == view;
    }
    if (!matchesView) {
        completion(false);
        return;
    }
    auto result = state->target.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
    if (result == B_WOULD_BLOCK || result == B_TIMED_OUT) {
        RunLoop::mainSingleton().dispatchAfter(10_ms,
            [weakState, message = std::move(message), generation, isPrompt, completion = WTF::move(completion)]() mutable {
                sendCloseNotificationHaiku(weakState, std::move(message), generation, isPrompt, WTF::move(completion));
            });
        return;
    }
    completion(result == B_OK);
}

static void navigationChangedHaiku(const std::shared_ptr<WebViewStateHaiku>& state)
{
    ASSERT(RunLoop::isMain());
    if (state->closed)
        return;
    ++state->navigationGeneration;
    if (state->closeRequestApproved || state->closeRequestPending) {
        state->closeApprovalInvalidated = true;
        state->closeRequestApproved = false;
        if (RefPtr client = state->client)
            client->notifyState();
    }
}

static bool closeApprovalMatchesNavigationHaiku(const WebViewStateHaiku& state)
{
    return !state.closeApprovalInvalidated
        && state.closeNavigationGeneration == state.navigationGeneration
        && state.closeDocumentIdentifier == state.documentIdentifier;
}

static void rememberNativeNavigationHaiku(WebViewStateHaiku& state, RefPtr<API::Navigation>&& navigation)
{
    state.nativeNavigationIdentifier = navigation ? std::optional { navigation->navigationID() } : std::nullopt;
}

static void notifyCloseDecisionHaiku(const std::shared_ptr<WebViewStateHaiku>& state, bool approved)
{
    ASSERT(RunLoop::isMain());
    if (state->closed || state->closeRequestApproved || state->closeDecisionInFlight
        || (!approved && !state->closeRequestPending))
        return;
    if (!state->closeRequestPending) {
        ++state->closeRequestGeneration;
        state->closeApprovalInvalidated = false;
        state->closeNavigationGeneration = state->navigationGeneration;
        state->closeDocumentIdentifier = state->documentIdentifier;
    }
    approved = approved && closeApprovalMatchesNavigationHaiku(*state);
    state->closeRequestPending = true;
    state->closeDecisionInFlight = true;
    BMessage message(approved ? B_WEBKIT_CLOSE_REQUESTED : B_WEBKIT_CLOSE_CANCELLED);
    {
        std::lock_guard guard(state->mutex);
        message.AddMessenger("view", state->view);
    }
    std::weak_ptr weakState { state };
    auto generation = state->closeRequestGeneration;
    sendCloseNotificationHaiku(weakState, std::move(message), generation, false,
        [weakState, generation, approved](bool delivered) {
            if (auto state = weakState.lock(); state && state->closeRequestGeneration == generation) {
                state->closeDecisionInFlight = false;
                state->closeRequestPending = false;
                state->closeRequestApproved = delivered && approved && closeApprovalMatchesNavigationHaiku(*state);
            }
        });
}

static void notifyLoadStateHaiku(const std::shared_ptr<WebViewStateHaiku>& state)
{
    if (RefPtr client = state->client)
        client->notifyState();
}

static void clearLoadErrorHaiku(WebViewStateHaiku::LoadState& load)
{
    load.errorDescription = { };
    load.errorDomain = { };
    load.errorURL = { };
    load.errorCode = 0;
    load.errorProvisional = false;
}

static void beginUnidentifiedLoadHaiku(const std::shared_ptr<WebViewStateHaiku>& state)
{
    auto& load = state->load;
    ++load.generation;
    load.identified = false;
    load.pending = true;
    load.stopped = false;
    load.committed = false;
    load.sameDocumentIdentifier = std::nullopt;
    load.sameDocumentURL = { };
    load.outcome = "loading";
    clearLoadErrorHaiku(load);
}

static bool trackLoadHaiku(const std::shared_ptr<WebViewStateHaiku>& state, API::Navigation* navigation)
{
    if (!navigation || state->closed)
        return false;
    auto& load = state->load;
    auto identifier = navigation->navigationID().toUInt64();
    // API::Navigation allocates these IDs in the UI process with the
    // monotonically increasing ObjectIdentifierMainThreadAccessTraits.
    // In particular, a delayed policy/start for A must not supersede a newer
    // explicit API request B, even when both use the same URL.
    if (identifier < load.navigationIdentifier
        || (identifier == load.navigationIdentifier && !load.identified))
        return false;
    if (identifier == load.navigationIdentifier)
        return true;
    beginUnidentifiedLoadHaiku(state);
    load.navigationIdentifier = identifier;
    load.identified = true;
    notifyLoadStateHaiku(state);
    return true;
}

static bool matchesLoadHaiku(const WebViewStateHaiku& state, API::Navigation* navigation)
{
    return !state.closed && state.load.pending && state.load.identified && navigation
        && state.load.navigationIdentifier == navigation->navigationID().toUInt64();
}

static void finishLoadHaiku(const std::shared_ptr<WebViewStateHaiku>& state, WebPageProxy& page)
{
    auto& load = state->load;
    load.pending = false;
    load.outcome = load.stopped ? "cancelled" : "succeeded";
    clearLoadErrorHaiku(load);
    if (!load.stopped) {
        ++load.successSequence;
        load.successURL = page.pageLoadState().url().string();
        load.successTitle = page.pageLoadState().title();
    }
    notifyLoadStateHaiku(state);
}

static void failLoadHaiku(const std::shared_ptr<WebViewStateHaiku>& state,
    const URL& requestURL, const ResourceError& error, bool provisional)
{
    auto& load = state->load;
    load.pending = false;
    // A download/policy handoff uses a general ResourceError, not the
    // Cancellation type. It leaves the previous document alive.
    bool cancelled = load.stopped || error.isCancellation()
        || (error.domain() == API::Error::webKitNetworkErrorDomain()
            && error.errorCode() == API::Error::Network::Cancelled)
        || (error.domain() == API::Error::webKitPolicyErrorDomain()
            && error.errorCode() == API::Error::Policy::FrameLoadInterruptedByPolicyChange);
    load.outcome = cancelled ? "cancelled" : "failed";
    clearLoadErrorHaiku(load);
    if (!cancelled) {
        load.errorDescription = error.localizedDescription();
        if (load.errorDescription.isEmpty())
            load.errorDescription = "The page could not be loaded."_s;
        load.errorDomain = error.domain();
        load.errorCode = error.errorCode();
        load.errorURL = (error.failingURL().isEmpty() ? requestURL : error.failingURL()).string();
        load.errorProvisional = provisional;
    }
    notifyLoadStateHaiku(state);
}

static void stopLoadHaiku(const std::shared_ptr<WebViewStateHaiku>& state)
{
    if (!state->load.pending)
        return;
    state->load.stopped = true;
    state->load.pending = false;
    state->load.outcome = "cancelled";
    notifyLoadStateHaiku(state);
}

static void documentChangedLoadHaiku(const std::shared_ptr<WebViewStateHaiku>& state)
{
    beginUnidentifiedLoadHaiku(state);
    state->load.pending = false;
    state->load.outcome = "idle";
    notifyLoadStateHaiku(state);
}

// Sends a notification about this view to its host, naming the view.
static status_t sendToHostHaiku(const std::shared_ptr<WebViewStateHaiku>& state, BMessage& message)
{
    {
        std::lock_guard guard(state->mutex);
        message.AddMessenger("view", state->view);
    }
    return state->target.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
}

static void addTextHaiku(BMessage& message, const char* name, const String& text)
{
    if (!text.isEmpty())
        message.AddString(name, text.utf8().legacyCStringPointer());
}

// Pages see the Command key as Control (see NativeWebEventsHaiku.cpp); hosts
// get the native modifier bits back.
static int32 nativeModifiersHaiku(OptionSet<WebEventModifier> modifiers)
{
    int32 result = 0;
    if (modifiers.contains(WebEventModifier::ShiftKey))
        result |= B_SHIFT_KEY;
    if (modifiers.contains(WebEventModifier::ControlKey))
        result |= B_COMMAND_KEY;
    if (modifiers.contains(WebEventModifier::AltKey))
        result |= B_CONTROL_KEY;
    if (modifiers.contains(WebEventModifier::MetaKey))
        result |= B_OPTION_KEY;
    return result;
}

static int32 nativeButtonHaiku(WebMouseEventButton button)
{
    switch (button) {
    case WebMouseEventButton::Left: return B_PRIMARY_MOUSE_BUTTON;
    case WebMouseEventButton::Right: return B_SECONDARY_MOUSE_BUTTON;
    case WebMouseEventButton::Middle: return B_TERTIARY_MOUSE_BUTTON;
    default: return 0;
    }
}

// Every tab gets its own web process, and starting one on Haiku means loading
// and relocating the whole engine before the page can be fetched. WebKit's
// automatic prewarming only runs with process swapping on navigation, which
// this port does not use, so a spare process is started here once a page has
// loaded, ready for the next tab. SUMMIT_PREWARM_PROCESS=0 turns it off.
static void prewarmWebProcessHaiku(WebPageProxy& page)
{
    static const bool enabled = [] {
        const char* value = std::getenv("SUMMIT_PREWARM_PROCESS");
        return !value || std::strcmp(value, "0");
    }();
    if (!enabled)
        return;
    RunLoop::mainSingleton().dispatch([pool = Ref { page.configuration().processPool() }] {
        pool->prewarmProcess();
    });
}

class CloseNavigationClientHaiku final : public API::NavigationClient {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(CloseNavigationClientHaiku);
public:
    explicit CloseNavigationClientHaiku(std::weak_ptr<WebViewStateHaiku> state) : m_state(std::move(state)) { }

    void decidePolicyForNavigationAction(WebPageProxy& page, Ref<API::NavigationAction>&& action, Ref<WebFramePolicyListenerProxy>&& listener) override
    {
        if (action->navigationType() == NavigationType::LinkClicked
            && (action->mouseButton() == WebMouseEventButton::Middle || action->modifiers().contains(WebEventModifier::ControlKey))) {
            // A middle click or Command-click on a link opens it in a new tab
            // (the host decides); the page itself stays where it is.
            if (auto state = m_state.lock(); state && !state->closed && action->request().url().isValid()) {
                BMessage message(B_WEBKIT_LINK_OPEN_REQUESTED);
                message.AddString("url", action->request().url().string().utf8().legacyCStringPointer());
                message.AddInt32("modifiers", nativeModifiersHaiku(action->modifiers()));
                message.AddInt32("button", nativeButtonHaiku(action->mouseButton()));
                if (sendToHostHaiku(state, message) == B_OK) {
                    listener->ignore();
                    return;
                }
            }
        }
        if (auto state = m_state.lock(); state && action->targetFrame() && action->targetFrame()->isMainFrame()) {
            // LoadURL/back/forward/reload already advanced the generation when
            // issued. Their delayed policy callback must not cancel a close
            // requested in the meantime. Page-initiated requests still count
            // here; provisional starts and document commits are also tracked.
            RefPtr navigation = action->mainFrameNavigation();
            if (!navigation || state->nativeNavigationIdentifier != navigation->navigationID())
                navigationChangedHaiku(state);
            trackLoadHaiku(state, navigation.get());
#if ENABLE(WK_WEB_EXTENSIONS)
            const auto& requiredBaseURL = page.configuration().requiredWebExtensionBaseURL();
            if (!requiredBaseURL.isEmpty() && !protocolHostAndPortAreEqual(requiredBaseURL, action->request().url())) {
                // Extensions send their pages to web pages (1Password opens its sign-in page
                // this way). Browsers then show that page in the same tab, so ask the host to.
                if (action->request().url().protocolIsInHTTPFamily()) {
                    BMessage message(B_WEBKIT_EXTERNAL_NAVIGATION_REQUESTED);
                    {
                        std::lock_guard guard(state->mutex);
                        message.AddMessenger("view", state->view);
                    }
                    message.AddString("url", action->request().url().string().utf8().legacyCStringPointer());
                    if (state->target.SendMessage(&message, static_cast<BHandler*>(nullptr), 0) == B_OK) {
                        listener->ignore();
                        return;
                    }
                }
                failLoadHaiku(state, action->request().url(), ResourceError("WebExtensionNavigationError"_s,
                    B_NOT_ALLOWED, action->request().url(), "This view can only display pages belonging to its extension."_s), true);
                listener->ignore();
                return;
            }
#endif
        }
        listener->use();
    }

    void decidePolicyForNavigationResponse(WebPageProxy&, Ref<API::NavigationResponse>&& navigation, Ref<WebFramePolicyListenerProxy>&& listener) override
    {
        const auto& response = navigation->response();
        if (response.httpStatusCode() == 204 || response.httpStatusCode() == 205)
            listener->use();
        else if (navigation->request().url().protocolIsInHTTPFamily()
            && (response.isAttachment() || !navigation->canShowMIMEType()))
            listener->download();
        else if (navigation->canShowMIMEType())
            listener->use();
        else
            listener->ignore();
    }

    void navigationActionDidBecomeDownload(WebPageProxy&, API::NavigationAction&, DownloadProxy& download) override { registerDownload(download); }
    void navigationResponseDidBecomeDownload(WebPageProxy&, API::NavigationResponse&, DownloadProxy& download) override { registerDownload(download); }
    void contextMenuDidCreateDownload(WebPageProxy&, DownloadProxy& download) override { registerDownload(download); }

    void didStartProvisionalNavigation(WebPageProxy& page, const ResourceRequest&, API::Navigation* navigation, API::Object*) override
    {
        if (auto state = m_state.lock()) {
            navigationChangedHaiku(state);
            if (navigation)
                trackLoadHaiku(state, navigation);
            else if (!page.pageLoadState().pendingAPIRequest().navigationID) {
                // Some back/forward-cache loads have no Navigation object.
                // Invalidate older IDs; only a matching committed document
                // can identify their terminal callbacks below.
                beginUnidentifiedLoadHaiku(state);
                notifyLoadStateHaiku(state);
            }
        }
    }

    void didCommitNavigation(WebPageProxy&, API::Navigation* navigation, API::Object*) override
    {
        if (auto state = m_state.lock(); state && matchesLoadHaiku(*state, navigation))
            state->load.committed = true;
    }

    void didCommitLoadForFrame(WebPageProxy&, ResourceRequest&&, FrameInfoData&& frame) override
    {
        if (!frame.isMainFrame)
            return;
        if (auto state = m_state.lock()) {
            state->documentIdentifier = frame.documentID ? std::optional { *frame.documentID } : std::nullopt;
            navigationChangedHaiku(state);
            if (!state->load.identified)
                state->load.committed = true;
        }
    }

    void didFailProvisionalNavigationWithError(WebPageProxy&, FrameInfoData&& frame,
        API::Navigation* navigation, const URL& requestURL, const ResourceError& error, API::Object*) override
    {
        if (auto state = m_state.lock(); state && frame.isMainFrame && matchesLoadHaiku(*state, navigation))
            failLoadHaiku(state, requestURL, error, true);
        // An uncommitted failure without a Navigation ID has no document
        // identity. Do not attribute it to a newer same-URL request.
    }

    void didFailNavigationWithError(WebPageProxy& page, const FrameInfoData& frame,
        API::Navigation* navigation, const URL& requestURL, const ResourceError& error, API::Object*) override
    {
        if (auto state = m_state.lock(); state && frame.isMainFrame
            && (matchesLoadHaiku(*state, navigation) || (!navigation && matchesUnidentifiedDocument(*state, page, frame))))
            failLoadHaiku(state, requestURL, error, false);
    }

    void didFinishNavigation(WebPageProxy& page, API::Navigation* navigation, API::Object*) override
    {
        if (auto state = m_state.lock(); state && matchesLoadHaiku(*state, navigation))
            finishLoadHaiku(state, page);
        prewarmWebProcessHaiku(page);
    }

    void didFinishLoadForFrame(WebPageProxy& page, ResourceRequest&&, FrameInfoData&& frame) override
    {
        if (auto state = m_state.lock(); state && matchesUnidentifiedDocument(*state, page, frame))
            finishLoadHaiku(state, page);
    }

    void didSameDocumentNavigation(WebPageProxy& page, API::Navigation* navigation, SameDocumentNavigationType, API::Object*) override
    {
        if (auto state = m_state.lock()) {
            navigationChangedHaiku(state);
            // Anchor callbacks carry the existing DocumentLoader's navigation
            // ID, rather than the new UI API request's ID. Match only an
            // explicitly requested fragment within that unchanged document.
            bool requestedFragment = state->load.pending && state->load.sameDocumentIdentifier
                && state->load.sameDocumentIdentifier == state->documentIdentifier
                && state->load.sameDocumentURL == page.pageLoadState().url().string();
            if (matchesLoadHaiku(*state, navigation) || requestedFragment
                || (!state->load.pending && !page.pageLoadState().pendingAPIRequest().navigationID)) {
                // Fragment/history API navigation succeeds without a main
                // resource load, but still updates the address and history.
                beginUnidentifiedLoadHaiku(state);
                finishLoadHaiku(state, page);
            }
        }
    }

private:
    void registerDownload(DownloadProxy& download)
    {
        if (auto state = m_state.lock(); state && state->context) {
            BMessenger view;
            {
                std::lock_guard guard(state->mutex);
                view = state->view;
            }
            state->context->downloads()->registerDownload(download, view);
        }
    }

    static bool matchesUnidentifiedDocument(const WebViewStateHaiku& state,
        WebPageProxy& page, const FrameInfoData& frame)
    {
        return !state.closed && state.load.pending && !state.load.identified && state.load.committed
            && frame.isMainFrame && frame.documentID && state.documentIdentifier
            && *frame.documentID == *state.documentIdentifier
            && !page.pageLoadState().pendingAPIRequest().navigationID
            && page.pageLoadState().provisionalURL().isEmpty();
    }

    const std::weak_ptr<WebViewStateHaiku> m_state;
};

// Pages opened by window.open() or a link with a target wait here, on the
// main thread, until the host makes a view for them (or declines).
struct PendingNewPageHaiku {
    Ref<API::PageConfiguration> configuration;
    CompletionHandler<void(RefPtr<WebPageProxy>&&)> completion;
};

static std::unordered_map<uint64_t, std::unique_ptr<PendingNewPageHaiku>>& pendingNewPagesHaiku()
{
    static NeverDestroyed<std::unordered_map<uint64_t, std::unique_ptr<PendingNewPageHaiku>>> pages;
    return pages.get();
}

static std::unique_ptr<PendingNewPageHaiku> takeNewPageHaiku(uint64_t identifier)
{
    ASSERT(RunLoop::isMain());
    auto found = pendingNewPagesHaiku().find(identifier);
    if (found == pendingNewPagesHaiku().end())
        return nullptr;
    auto pending = std::move(found->second);
    pendingNewPagesHaiku().erase(found);
    return pending;
}

void declineNewPageHaiku(uint64_t identifier)
{
    if (auto pending = takeNewPageHaiku(identifier))
        pending->completion(nullptr);
}

void openNewPageHaiku(std::shared_ptr<WebViewStateHaiku> state, uint64_t identifier)
{
    ASSERT(RunLoop::isMain());
    auto pending = takeNewPageHaiku(identifier);
    if (state->closed) {
        if (pending)
            pending->completion(nullptr);
        return;
    }
    if (!pending) {
        // The opener went away first: an ordinary empty page.
        state->client = WebView::create(state);
        return;
    }
    Ref view = WebView::createWithConfiguration(state, WTF::move(pending->configuration));
    state->client = view.ptr();
    RefPtr page = view->page();
    pending->completion(WTF::move(page));
}

// Loads one favicon per main-frame document and hands its bytes to the host,
// which decodes, caches and draws it. WebCore offers every <link rel=icon>
// (and /favicon.ico when a page names none); the host only needs the one
// closest to tab size in a format the Translation Kit can read.
class IconLoadingClientHaiku final : public API::IconLoadingClient {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(IconLoadingClientHaiku);
public:
    explicit IconLoadingClientHaiku(std::weak_ptr<WebViewStateHaiku> state) : m_state(std::move(state)) { }

    void getLoadDecisionForIcons(const HashMap<WebKit::CallbackID, WebCore::LinkIcon>& icons, CompletionHandler<void(HashSet<WebKit::CallbackID>&&)>&& completionHandler) override
    {
        std::optional<WebKit::CallbackID> best;
        int bestScore = std::numeric_limits<int>::max();
        for (const auto& [identifier, icon] : icons) {
            if (icon.type != WebCore::LinkIconType::Favicon)
                continue;
            // Haiku has no SVG translator.
            if (icon.mimeType.containsIgnoringASCIICase("svg"_s) || icon.url.path().endsWithIgnoringASCIICase(".svg"_s))
                continue;
            // An .ico without sizes usually holds both 16 and 32 pixel images.
            int score = icon.size ? std::abs(static_cast<int>(*icon.size) - 32) : 8;
            if (icon.size && *icon.size < 16)
                score += 64;
            if (score < bestScore) {
                bestScore = score;
                best = identifier;
            }
        }
        HashSet<WebKit::CallbackID> decisions;
        if (best) {
            decisions.add(*best);
            m_pageURL = { };
            if (auto state = m_state.lock()) {
                if (RefPtr client = state->client; client && client->page())
                    m_pageURL = client->page()->pageLoadState().activeURL();
            }
        }
        completionHandler(WTF::move(decisions));
    }

    void iconLoaded(const WebKit::CallbackID&, const WebCore::LinkIcon& icon, API::Data* data) override
    {
        auto state = m_state.lock();
        if (!state || state->closed || !data || data->span().empty() || data->span().size() > 1024 * 1024)
            return;
        BMessage message(B_WEBKIT_ICON_LOADED);
        message.AddString("url", m_pageURL.string().utf8().legacyCStringPointer());
        message.AddString("iconURL", icon.url.string().utf8().legacyCStringPointer());
        message.AddString("mimeType", icon.mimeType.utf8().legacyCStringPointer());
        message.AddData("data", B_RAW_TYPE, data->span().data(), data->span().size());
        {
            std::lock_guard guard(state->mutex);
            message.AddMessenger("view", state->view);
        }
        state->target.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
    }

private:
    const std::weak_ptr<WebViewStateHaiku> m_state;
    URL m_pageURL;
};

class JavaScriptUIClientHaiku final : public API::UIClient {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(JavaScriptUIClientHaiku);
public:
    // Only browser tabs have a host that can open pages; an extension popup
    // declines window.open() as before.
    JavaScriptUIClientHaiku(std::weak_ptr<WebViewStateHaiku> state, bool hostsNewPages)
        : m_state(std::move(state)), m_hostsNewPages(hostsNewPages) { }

    void createNewPage(WebPageProxy&, Ref<API::PageConfiguration>&& configuration, Ref<API::NavigationAction>&& action, CompletionHandler<void(RefPtr<WebPageProxy>&&)>&& completion) override
    {
        auto state = m_state.lock();
        if (!m_hostsNewPages || !state || state->closed) {
            completion(nullptr);
            return;
        }
        static uint64_t lastIdentifier;
        const uint64_t identifier = ++lastIdentifier;
        BMessage message(B_WEBKIT_NEW_PAGE_REQUESTED);
        message.AddUInt64("identifier", identifier);
        message.AddString("url", action->request().url().string().utf8().legacyCStringPointer());
        const auto& features = configuration->windowFeatures();
        message.AddBool("popup", features && features->wantsPopup());
        message.AddBool("user_gesture", action->isProcessingUserGesture());
        message.AddInt32("modifiers", nativeModifiersHaiku(action->modifiers()));
        message.AddInt32("button", nativeButtonHaiku(action->mouseButton()));
        if (features && features->width && features->height) {
            message.AddFloat("width", *features->width);
            message.AddFloat("height", *features->height);
            if (features->x && features->y) {
                message.AddFloat("x", *features->x);
                message.AddFloat("y", *features->y);
            }
        }
        pendingNewPagesHaiku().emplace(identifier, std::make_unique<PendingNewPageHaiku>(PendingNewPageHaiku { WTF::move(configuration), WTF::move(completion) }));
        if (sendToHostHaiku(state, message) != B_OK)
            declineNewPageHaiku(identifier);
    }

    void mouseDidMoveOverElement(WebPageProxy&, const WebHitTestResultData& data, OptionSet<WebEventModifier>) override
    {
        auto state = m_state.lock();
        if (!state || state->closed || data.absoluteLinkURL == m_hoveredLink)
            return;
        m_hoveredLink = data.absoluteLinkURL;
        BMessage message(B_WEBKIT_LINK_HOVERED);
        message.AddString("url", m_hoveredLink.utf8().legacyCStringPointer());
        addTextHaiku(message, "title", data.linkTitle);
        sendToHostHaiku(state, message);
    }

    void runJavaScriptAlert(WebPageProxy&, const String& message, WebFrameProxy*, FrameInfoData&& frame, Function<void()>&& completion) override
    {
        show(JavaScriptDialogKindHaiku::Alert, message, { }, frame, dialogCompletionOnMainHaiku(
            [completion = WTF::move(completion)](bool, const std::string&) { completion(); }));
    }

    void runJavaScriptConfirm(WebPageProxy&, const String& message, WebFrameProxy*, FrameInfoData&& frame, Function<void(bool)>&& completion) override
    {
        show(JavaScriptDialogKindHaiku::Confirm, message, { }, frame, dialogCompletionOnMainHaiku(
            [completion = WTF::move(completion)](bool accepted, const std::string&) { completion(accepted); }));
    }

    void runJavaScriptPrompt(WebPageProxy&, const String& message, const String& defaultValue, WebFrameProxy*, FrameInfoData&& frame, Function<void(const String&)>&& completion) override
    {
        show(JavaScriptDialogKindHaiku::Prompt, message, defaultValue, frame, dialogCompletionOnMainHaiku(
            [completion = WTF::move(completion)](bool accepted, const std::string& value) {
                completion(accepted ? String::fromUTF8WithLatin1Fallback(std::span<const char> { value.data(), value.size() }) : String());
            }));
    }

    void close(WebPageProxy*) override
    {
        if (auto state = m_state.lock())
            notifyCloseDecisionHaiku(state, true);
    }

    void didCancelClose(WebPageProxy*) override
    {
        if (auto state = m_state.lock())
            notifyCloseDecisionHaiku(state, false);
    }

    void didExplicitOpen(WebPageProxy*) override
    {
        if (auto state = m_state.lock()) {
            navigationChangedHaiku(state);
            documentChangedLoadHaiku(state);
        }
    }

    // <input type=file> gets a native file panel.
    bool runOpenPanel(WebPageProxy&, WebFrameProxy*, FrameInfoData&&, API::OpenPanelParameters* parameters, WebOpenPanelResultListenerProxy* listener) override
    {
        return runOpenPanelHaiku(parameters, listener);
    }

    bool canRunBeforeUnloadConfirmPanel() const override { return true; }

    void runBeforeUnloadConfirmPanel(WebPageProxy&, String&& message, WebFrameProxy*, FrameInfoData&& frame, Function<void(bool)>&& completion) override
    {
        show(JavaScriptDialogKindHaiku::BeforeUnload, message, { }, frame, dialogCompletionOnMainHaiku(
            [completion = WTF::move(completion)](bool accepted, const std::string&) { completion(accepted); }));
    }

private:
    static status_t addText(BMessage& message, const char* name, const String& text)
    {
        auto utf8 = text.utf8();
        // Retain embedded NULs as well as an accepted empty prompt value.
        return message.AddData(name, B_RAW_TYPE, utf8.data() ? reinterpret_cast<const char*>(utf8.data()) : "", utf8.length() + 1);
    }

    void show(JavaScriptDialogKindHaiku kind, const String& text, const String& defaultValue,
        const FrameInfoData& frame, JavaScriptDialogRequestsHaiku::Completion completion)
    {
        auto state = m_state.lock();
        if (!state || state->closed) {
            completion(false, { });
            return;
        }
        uint64 identifier = state->dialogs->add(std::move(completion));
        if (!identifier)
            return;
        BMessage message(javaScriptDialogShowHaiku);
        BMessenger view;
        {
            std::lock_guard guard(state->mutex);
            view = state->view;
        }
        String origin = frame.securityOrigin.isOpaque() ? "Opaque origin"_s : frame.securityOrigin.toString();
        String topOrigin = frame.topOrigin.isOpaque() ? "Opaque origin"_s : frame.topOrigin.toString();
        if (message.AddUInt64("identifier", identifier) != B_OK
            || message.AddInt32("kind", static_cast<int32>(kind)) != B_OK
            || addText(message, "origin", origin) != B_OK
            || addText(message, "topOrigin", origin == topOrigin ? emptyString() : topOrigin) != B_OK
            || addText(message, "message", text) != B_OK
            || addText(message, "defaultValue", defaultValue) != B_OK) {
            state->dialogs->complete(identifier, false);
            return;
        }
        if (kind == JavaScriptDialogKindHaiku::BeforeUnload && state->closeRequestPending) {
            // The browser window and its view share a looper. Announce the real
            // beforeunload request first so a hidden tab can become visible
            // before the queued native dialog is considered for display.
            BMessage prompt(B_WEBKIT_CLOSE_PROMPT);
            if (prompt.AddMessenger("view", view) != B_OK) {
                state->dialogs->complete(identifier, false);
                return;
            }
            std::weak_ptr weakState { state };
            sendCloseNotificationHaiku(weakState, std::move(prompt), state->closeRequestGeneration, true,
                [weakState, view, message = std::move(message), identifier](bool delivered) mutable {
                    if (auto state = weakState.lock()) {
                        if (!delivered || state->closed || !state->dialogs->contains(identifier)
                            || view.SendMessage(&message, static_cast<BHandler*>(nullptr), 0) != B_OK)
                            state->dialogs->complete(identifier, false);
                    }
                });
            return;
        }
        if (view.SendMessage(&message, static_cast<BHandler*>(nullptr), 0) != B_OK)
            state->dialogs->complete(identifier, false);
    }

    const std::weak_ptr<WebViewStateHaiku> m_state;
    const bool m_hostsNewPages;
    String m_hoveredLink;
};

static void sendCloseCommitResultHaiku(BMessenger target, BMessage message)
{
    if (!target.IsValid())
        return;
    auto result = target.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
    if (result == B_WOULD_BLOCK || result == B_TIMED_OUT) {
        RunLoop::mainSingleton().dispatchAfter(10_ms, [target, message = std::move(message)]() mutable {
            sendCloseCommitResultHaiku(target, std::move(message));
        });
    }
}

void commitViewCloseHaiku(std::vector<std::shared_ptr<WebViewStateHaiku>> states, BMessenger target, uint64_t identifier)
{
    ASSERT(RunLoop::isMain());
    bool approved = target.IsValid();
    for (const auto& state : states) {
        if (!state || state->closed || state->closeRequestPending || state->closeDecisionInFlight
            || (state->client && (!state->closeRequestApproved || !closeApprovalMatchesNavigationHaiku(*state)))) {
            approved = false;
            break;
        }
    }
    // No main-loop turn occurs between validating the complete set and closing
    // its engine pages. Later navigation IPC cannot replace a closed proxy.
    if (approved) {
        for (const auto& state : states) {
            state->closed = true;
            state->dialogs->cancelAll(true);
            state->presenter.close();
            if (RefPtr client = state->client)
                client->close();
        }
    }
    BMessage result(B_WEBKIT_CLOSE_COMMITTED);
    result.AddUInt64("identifier", identifier);
    result.AddBool("closed", approved);
    sendCloseCommitResultHaiku(target, std::move(result));
}

WebViewStateHaiku::WebViewStateHaiku(BMessenger target)
    : target(target)
{
}

WebViewStateHaiku::~WebViewStateHaiku()
{
    ASSERT(!client);
}

void dispatchViewMessageHaiku(std::shared_ptr<WebViewStateHaiku> state, BMessage&& message)
{
    RunLoop::mainSingleton().dispatch([state = std::move(state), message = std::move(message)] {
        if (!state->closed) {
            if (RefPtr client = state->client)
                client->handleMessage(message);
        }
    });
}

Ref<WebView> WebView::create(std::shared_ptr<WebViewStateHaiku> state)
{
    auto view = adoptRef(*new WebView(std::move(state)));
    view->initialize();
    return view;
}

Ref<WebView> WebView::createWithConfiguration(std::shared_ptr<WebViewStateHaiku> state, Ref<API::PageConfiguration>&& configuration)
{
    Ref view = adoptRef(*new WebView(std::move(state)));
    view->initialize(WTF::move(configuration));
    return view;
}

#if ENABLE(WK_WEB_EXTENSIONS)
Ref<WebView> WebView::createForExtensionPage(std::shared_ptr<WebViewStateHaiku> state, Ref<API::PageConfiguration>&& configuration)
{
    Ref view = adoptRef(*new WebView(std::move(state)));
    view->initialize(WTF::move(configuration));
    return view;
}

Ref<WebView> WebView::createForExtensionPopup(std::shared_ptr<WebViewStateHaiku> state, Ref<API::PageConfiguration>&& configuration)
{
    ASSERT(RunLoop::isMain());
    Ref view = adoptRef(*new WebView(std::move(state)));
    auto& pool = configuration->processPool();
    view->m_page = pool.createWebPage(view.get(), WTF::move(configuration));
    view->m_page->setUIClient(makeUnique<JavaScriptUIClientHaiku>(view->m_state, false));
    auto& pageConfiguration = view->m_page->configuration();
    view->m_page->initializeWebPage(pageConfiguration.openedSite(), pageConfiguration.initialSandboxFlags(), pageConfiguration.initialReferrerPolicy());
    view->m_page->setIntrinsicDeviceScaleFactor(displayScaleFactorHaiku());
    view->updateGeometry();
    return view;
}

Ref<WebView> WebView::createForExtensionBackground(Ref<API::PageConfiguration>&& configuration)
{
    ASSERT(RunLoop::isMain());
    auto state = std::make_shared<WebViewStateHaiku>(BMessenger { });
    state->status = B_OK;
    Ref view = adoptRef(*new WebView(WTF::move(state)));
    auto& pool = configuration->processPool();
    view->m_page = pool.createWebPage(view.get(), WTF::move(configuration));
    auto& pageConfiguration = view->m_page->configuration();
    view->m_page->initializeWebPage(pageConfiguration.openedSite(), pageConfiguration.initialSandboxFlags(), pageConfiguration.initialReferrerPolicy());
    // Nothing is shown, but pages choose image sizes from devicePixelRatio.
    view->m_page->setIntrinsicDeviceScaleFactor(displayScaleFactorHaiku());
    view->updateGeometry();
    return view;
}
#endif

WebView::WebView(std::shared_ptr<WebViewStateHaiku> state)
    : m_state(std::move(state))
{
}

void WebView::initialize(RefPtr<API::PageConfiguration> configuration)
{
    ASSERT(RunLoop::isMain());
    if (!m_state->context) {
        status_t status;
        m_state->context = WebViewContextHaiku::defaultContext(status);
        if (!m_state->context) {
            m_state->status = status;
            BMessage message(B_WEBKIT_PROCESS_EXITED);
            message.AddInt32("error", status);
            {
                std::lock_guard guard(m_state->mutex);
                message.AddMessenger("view", m_state->view);
            }
            m_state->target.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
            return;
        }
    }
    if (!configuration) {
        configuration = API::PageConfiguration::create();
        m_state->context->configure(*configuration);
    }
#if USE(COORDINATED_GRAPHICS)
    // The coordinated layer tree is the whole point of this configuration: it
    // is what paints tiles, and SkiaPaintingEngine paints those on a worker
    // pool. Without compositing the drawing area falls back to its
    // non-composited renderer, which paints the page on one thread.
    configuration->preferences().setAcceleratedCompositingEnabled(true);
    configuration->preferences().setForceCompositingMode(true);
    configuration->preferences().setThreadedScrollingEnabled(true);
#if ENABLE(DAMAGE_TRACKING)
    // Frames carry what changed, so the readback and app_server copy only
    // that. SUMMIT_DAMAGE_TRACKING=0 goes back to whole frames.
    // The compositor also redraws only the damage, as GTK and WPE do.
    if (const char* damage = std::getenv("SUMMIT_DAMAGE_TRACKING"); !damage || std::strcmp(damage, "0")) {
        configuration->preferences().setPropagateDamagingInformation(true);
        configuration->preferences().setUseDamagingInformationForCompositing(true);
        configuration->preferences().setUnifyDamagedRegions(true);
    }
#endif
#else
    configuration->preferences().setAcceleratedCompositingEnabled(false);
    configuration->preferences().setForceCompositingMode(false);
    configuration->preferences().setThreadedScrollingEnabled(false);
#endif
    // Allow repeatable CPU/GPU Canvas 2D comparisons without changing the
    // browser's normal preference. The generated preference defaults to true
    // for Skia ports, so an unset variable preserves the shipping behavior.
    if (const char* canvasAcceleration = std::getenv("SUMMIT_CANVAS_ACCELERATION"))
        configuration->preferences().setCanvasUsesAcceleratedDrawing(std::strcmp(canvasAcceleration, "0"));
    // There is no native way to keep the display awake yet, and a granted request ended the
    // page's process (seen on browserbench.org). Pages must see the API as absent.
    configuration->preferences().setScreenWakeLockAPIEnabled(false);
    // Chrome and Firefox ship requestIdleCallback, and sites and extensions built for
    // them call it unconditionally. WebKit's implementation is complete but off by default.
    configuration->preferences().setRequestIdleCallbackEnabled(true);
    // Block pop-ups: window.open() needs a click or key press, as in other browsers.
    configuration->preferences().setJavaScriptCanOpenWindowsAutomatically(false);
#if ENABLE(WEB_AUTHN)
    // Passkeys reach this port through a password manager, which can only extend
    // Web Authentication when the page exposes it. Summit has no authenticator of
    // its own; see UIProcess/WebAuthentication/haiku.
    configuration->preferences().setWebAuthenticationEnabled(true);
#endif
    // Opt-in diagnostics: page and content-script console messages go to stderr.
    if (const char* trace = std::getenv("SUMMIT_TRACE_PAGE_CONSOLE"); trace && !std::strcmp(trace, "1"))
        configuration->preferences().setLogsPageMessagesToSystemConsoleEnabled(true);
    auto& pool = configuration->processPool();
    m_page = pool.createWebPage(*this, configuration.releaseNonNull());
    m_page->setUIClient(makeUnique<JavaScriptUIClientHaiku>(m_state, true));
    m_page->setNavigationClient(makeUniqueRef<CloseNavigationClientHaiku>(m_state));
    m_page->setIconLoadingClient(makeUnique<IconLoadingClientHaiku>(m_state));
    auto& pageConfiguration = m_page->configuration();
    m_page->initializeWebPage(pageConfiguration.openedSite(), pageConfiguration.initialSandboxFlags(), pageConfiguration.initialReferrerPolicy());
    m_page->setIntrinsicDeviceScaleFactor(geometry().scale);
    WKPageStateClientV0 observer { };
    observer.base.clientInfo = this;
    auto changed = [](const void* context) { static_cast<const WebView*>(context)->notifyState(); };
    observer.didChangeIsLoading = changed;
    observer.didChangeTitle = changed;
    observer.didChangeActiveURL = changed;
    observer.didChangeEstimatedProgress = changed;
    observer.didChangeCanGoBack = changed;
    observer.didChangeCanGoForward = changed;
    observer.didChangeHasOnlySecureContent = changed;
    observer.didChangeWebProcessIsResponsive = changed;
    WKPageSetPageStateClient(toAPI(m_page.get()), &observer.base);
    updateGeometry();
    notifyState();
}

WebView::~WebView()
{
    ASSERT(RunLoop::isMain());
    ASSERT(!m_page);
    if (m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
}

void WebView::didChangeContentSize(const WebCore::IntSize& size)
{
    ASSERT(RunLoop::isMain());
    if (auto callback = m_state->contentSizeChanged)
        callback->run(size);
}

void WebView::close()
{
    ASSERT(RunLoop::isMain());
    Ref protectedThis { *this };
    m_state->contentSizeChanged = nullptr;
    m_state->dialogs->cancelAll(true);
    BMessage dismissDialogs(javaScriptDialogsCancelHaiku);
    sendToView(dismissDialogs);
    m_state->presenter.close();
    if (m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
    if (m_page) {
        WKPageSetPageStateClient(toAPI(m_page.get()), nullptr);
        if (m_state->context)
            m_state->context->browserTabs()->removePage(m_page->identifier());
        m_page->close();
        m_page = nullptr;
    }
    m_undoController.clearAllEditCommands();
}

WebViewGeometryHaiku WebView::geometry() const
{
    std::lock_guard guard(m_state->mutex);
    return m_state->geometry;
}

void WebView::sendToView(BMessage& message) const
{
    BMessenger view;
    {
        std::lock_guard guard(m_state->mutex);
        view = m_state->view;
    }
    view.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
}

void WebView::notifyState(uint32_t what) const
{
    if (!m_page || m_state->closed)
        return;
    const auto& state = m_page->pageLoadState();
    BMessage message(what);
    message.AddString("url", state.activeURL().string().utf8().legacyCStringPointer());
    message.AddString("title", state.title().utf8().legacyCStringPointer());
    message.AddBool("loading", state.isLoading());
    message.AddDouble("progress", state.estimatedProgress());
    message.AddBool("canGoBack", state.canGoBack());
    message.AddBool("canGoForward", state.canGoForward());
    message.AddDouble("pageZoom", m_page->pageZoomFactor());
    message.AddDouble("textZoom", m_page->textZoomFactor());
    message.AddBool("closeApprovalInvalidated", m_state->closeApprovalInvalidated);
    const auto& load = m_state->load;
    message.AddUInt64("loadGeneration", load.generation);
    message.AddString("loadOutcome", load.outcome);
    message.AddBool("loadError", !load.errorDescription.isEmpty());
    message.AddString("loadErrorDescription", load.errorDescription.utf8().legacyCStringPointer());
    message.AddString("loadErrorDomain", load.errorDomain.utf8().legacyCStringPointer());
    message.AddString("loadErrorURL", load.errorURL.utf8().legacyCStringPointer());
    message.AddInt32("loadErrorCode", load.errorCode);
    message.AddBool("loadErrorProvisional", load.errorProvisional);
    message.AddUInt64("loadSuccessSequence", load.successSequence);
    message.AddString("loadSuccessURL", load.successURL.utf8().legacyCStringPointer());
    message.AddString("loadSuccessTitle", load.successTitle.utf8().legacyCStringPointer());
    {
        std::lock_guard guard(m_state->mutex);
        message.AddMessenger("view", m_state->view);
    }
    m_state->target.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
}

void WebView::handleMessage(const BMessage& message)
{
    if (message.what == viewResetCloseHaiku) {
        if (!m_state->closeRequestPending && !m_state->closeDecisionInFlight) {
            m_state->closeRequestApproved = false;
            m_state->closeApprovalInvalidated = false;
            ++m_state->closeRequestGeneration;
        }
        return;
    }
    if (message.what == viewRequestCloseHaiku) {
        if (m_state->closeRequestPending || m_state->closeRequestApproved)
            return;
        // Stop an existing load before the ordered TryClose IPC assesses the
        // current document. Failed/stalled loads must not trap the close path.
        // A new observed navigation after this point still invalidates it.
        if (m_page && m_page->pageLoadState().isLoading()) {
            stopLoadHaiku(m_state);
            m_page->stopLoading();
        }
        m_state->closeRequestPending = true;
        m_state->closeApprovalInvalidated = false;
        m_state->closeNavigationGeneration = m_state->navigationGeneration;
        m_state->closeDocumentIdentifier = m_state->documentIdentifier;
        ++m_state->closeRequestGeneration;
        if (!m_page || m_page->tryClose())
            notifyCloseDecisionHaiku(m_state, true);
        return;
    }
    if (!m_page)
        return;
    switch (message.what) {
    case viewLoadHaiku: {
        URL url { String::fromUTF8(message.FindString("url")) };
        if (url.isValid()) {
            auto fragmentDocument = url.hasFragmentIdentifier()
                && equalIgnoringFragmentIdentifier(url, m_page->pageLoadState().url())
                ? m_state->documentIdentifier : std::nullopt;
            String fragmentURL = fragmentDocument ? url.string() : String();
            navigationChangedHaiku(m_state);
            beginUnidentifiedLoadHaiku(m_state);
            RefPtr navigation = m_page->loadRequest(ResourceRequest(WTF::move(url)));
            trackLoadHaiku(m_state, navigation.get());
            m_state->load.sameDocumentIdentifier = fragmentDocument;
            m_state->load.sameDocumentURL = WTF::move(fragmentURL);
            rememberNativeNavigationHaiku(*m_state, WTF::move(navigation));
            notifyState();
        }
        break;
    }
    case viewDownloadHaiku: {
        URL url { String::fromUTF8(message.FindString("url")) };
        if (url.isValid()) {
            BMessenger view;
            {
                std::lock_guard guard(m_state->mutex);
                view = m_state->view;
            }
            m_state->context->download(*m_page, ResourceRequest(WTF::move(url)), view);
        }
        break;
    }
    case viewBackHaiku:
        if (m_page->pageLoadState().canGoBack()) {
            navigationChangedHaiku(m_state);
            beginUnidentifiedLoadHaiku(m_state);
            RefPtr navigation = m_page->goBack();
            trackLoadHaiku(m_state, navigation.get());
            rememberNativeNavigationHaiku(*m_state, WTF::move(navigation));
            notifyState();
        }
        break;
    case viewForwardHaiku:
        if (m_page->pageLoadState().canGoForward()) {
            navigationChangedHaiku(m_state);
            beginUnidentifiedLoadHaiku(m_state);
            RefPtr navigation = m_page->goForward();
            trackLoadHaiku(m_state, navigation.get());
            rememberNativeNavigationHaiku(*m_state, WTF::move(navigation));
            notifyState();
        }
        break;
    case viewReloadHaiku: {
        navigationChangedHaiku(m_state);
        beginUnidentifiedLoadHaiku(m_state);
        RefPtr navigation = m_page->reload({ });
        trackLoadHaiku(m_state, navigation.get());
        rememberNativeNavigationHaiku(*m_state, WTF::move(navigation));
        notifyState();
        break;
    }
    case viewStopHaiku:
        stopLoadHaiku(m_state);
        m_page->stopLoading();
        break;
    case viewEditHaiku: {
        uint32 command;
        if (message.FindUInt32("command", &command) != B_OK)
            break;
        String name;
        switch (command) {
        case B_CUT: name = "Cut"_s; break;
        case B_COPY: name = "Copy"_s; break;
        case B_PASTE: name = "Paste"_s; break;
        case B_SELECT_ALL: name = "SelectAll"_s; break;
        case B_UNDO: name = "Undo"_s; break;
        case B_REDO: name = "Redo"_s; break;
        default: break;
        }
        if (!name.isNull())
            m_page->executeEditCommand(name);
        break;
    }
    case viewZoomHaiku: {
        int32 direction;
        bool textOnly;
        if (message.FindInt32("direction", &direction) != B_OK
            || message.FindBool("textOnly", &textOnly) != B_OK
            || direction < -1 || direction > 1)
            break;
        if (!direction)
            m_page->setPageAndTextZoomFactors(1, 1);
        else {
            double current = textOnly ? m_page->textZoomFactor() : m_page->pageZoomFactor();
            double next = direction > 0 ? current * 1.1 : current / 1.1;
            if (std::isfinite(next) && next >= 0.5 && next <= 3) {
                if (textOnly)
                    m_page->setTextZoomFactor(next);
                else
                    m_page->setPageZoomFactor(next);
            }
        }
        notifyState();
        break;
    }
    case viewHideFindHaiku:
        m_page->hideFindUI();
        break;
    case viewFindHaiku: {
        uint64 identifier;
        const char* bytes;
        bool forward, caseSensitive, wrapSelection;
        if (message.FindUInt64("identifier", &identifier) != B_OK
            || message.FindString("query", &bytes) != B_OK
            || message.FindBool("forward", &forward) != B_OK
            || message.FindBool("caseSensitive", &caseSensitive) != B_OK
            || message.FindBool("wrapSelection", &wrapSelection) != B_OK)
            break;
        String query = String::fromUTF8(bytes);
        auto searchURL = m_page->pageLoadState().activeURL();
        auto reply = [state = m_state, identifier, query, searchURL](bool found, status_t error = B_OK) {
            if (state->closed || state->findRequestIdentifier != identifier)
                return;
            RefPtr client = state->client;
            if (!client || !client->page() || client->page()->pageLoadState().activeURL() != searchURL)
                return;
            if (error == B_OK && !client->page()->hasRunningProcess())
                error = B_NO_INIT;
            BMessage result(B_WEBKIT_FIND_RESULT);
            result.AddString("query", query.utf8().legacyCStringPointer());
            result.AddUInt64("identifier", identifier);
            result.AddInt32("error", error);
            if (error == B_OK)
                result.AddBool("found", found);
            {
                std::lock_guard guard(state->mutex);
                result.AddMessenger("view", state->view);
            }
            state->target.SendMessage(&result, static_cast<BHandler*>(nullptr), 0);
        };
        if (query.isNull() || !m_page->hasRunningProcess()) {
            reply(false, query.isNull() ? B_BAD_VALUE : B_NO_INIT);
            break;
        }
        OptionSet<FindOptions> options { FindOptions::ShowHighlight };
        if (!forward)
            options.add(FindOptions::Backwards);
        if (!caseSensitive)
            options.add(FindOptions::CaseInsensitive);
        if (wrapSelection)
            options.add(FindOptions::WrapAround);
        m_page->findString(query, options, 1000, [reply = WTF::move(reply)](bool found) { reply(found); });
        break;
    }
    case viewGeometryHaiku: updateGeometry(); break;
    case viewPresentedHaiku: {
        uint64 identifier = 0;
        if (message.FindUInt64("identifier", &identifier) == B_OK)
            didPresent(identifier);
        break;
    }
    case viewInputHaiku: {
        BMessage native;
        if (message.FindMessage("event", &native) != B_OK)
            break;
        BPoint local = message.FindPoint("local"), screen = message.FindPoint("screen");
        if (auto key = NativeWebKeyboardEvent::create(native))
            m_page->handleKeyboardEvent(key.releaseNonNull());
        else if (auto wheel = NativeWebWheelEvent::create(native, local, screen))
            m_page->handleNativeWheelEvent(wheel.releaseNonNull());
        else if (auto mouse = NativeWebMouseEvent::create(native, local, screen, m_buttons)) {
            m_buttons = mouse->buttons();
            m_page->handleMouseEvent(mouse.releaseNonNull());
        }
        break;
    }
    default: break;
    }
}

Ref<DrawingAreaProxy> WebView::createDrawingAreaProxy(WebProcessProxy& process)
{
#if USE(COORDINATED_GRAPHICS)
    return DrawingAreaProxyCoordinatedGraphics::create(*m_page, process);
#else
    return DrawingAreaProxyHaiku::create(*m_page, process);
#endif
}

void WebView::updateGeometry()
{
    if (!m_page)
        return;
    auto current = geometry();
    m_page->legacyMainFrameProcess().send(Messages::WebPage::SetWindowFrameHaiku(FloatRect(current.windowFrame)), m_page->webPageIDInMainFrameProcess());
    // The screen's density changes when monitors are rearranged or rescaled.
    if (current.scale > 0)
        m_page->setIntrinsicDeviceScaleFactor(current.scale);
    if (auto* drawingArea = m_page->drawingArea())
        drawingArea->setSize(current.size);
    m_page->activityStateDidChange({ ActivityState::IsFocused, ActivityState::WindowIsActive,
        ActivityState::IsVisible, ActivityState::IsInWindow });
    if (!current.visible && m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
}

void WebView::setViewNeedsDisplay(const Region&)
{
    BMessage message(viewFrameHaiku);
    sendToView(message);
}

#if USE(COORDINATED_GRAPHICS)
void WebView::updateAcceleratedSurface(uint64_t surfaceID)
{
    if (!m_acceleratedBackingStore) {
        if (!surfaceID)
            return;
        m_acceleratedBackingStore = AcceleratedBackingStore::create(*m_page);
    }
    m_acceleratedBackingStore->updateSurfaceID(surfaceID);
}
#endif

void WebView::presentBitmapHaiku(Ref<ShareableBitmap>&& bitmap, const IntSize& size, float scale, CompletionHandler<void()>&& callback)
{
    if (m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
    auto current = geometry();
    auto identifier = ++m_presentationIdentifier;
    if (m_state->closed || !current.visible || !m_state->presenter.publish(identifier, bitmap, size, scale)) {
        callback();
        return;
    }
    m_presentationCallback = WTF::move(callback);
    BMessenger view;
    {
        std::lock_guard guard(m_state->mutex);
        view = m_state->view;
    }
    BMessage message(viewFrameHaiku);
    if (std::getenv("SUMMIT_UI_FRAME_STATS"))
        message.AddInt64("summit:queuedMicros", system_time());
    if (view.SendMessage(&message, static_cast<BHandler*>(nullptr), 0) != B_OK)
        std::exchange(m_presentationCallback, { })();
}

void WebView::presentSharedFrameHaiku(std::shared_ptr<const BBitmap>&& image, const IntSize& size, float scale, const Vector<IntRect, 1>& damage)
{
    if (m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
    auto current = geometry();
    auto identifier = ++m_presentationIdentifier;
    if (m_state->closed || !current.visible || !m_state->presenter.publishShared(identifier, WTF::move(image), size, scale)) {
        m_presentationNeedsFullRedraw = true;
        return;
    }
    BMessenger view;
    {
        std::lock_guard guard(m_state->mutex);
        view = m_state->view;
    }
    BMessage message(viewFrameHaiku);
    // Redraw only what changed, in the view's logical coordinates, rounded
    // outwards so a fractional scale never leaves a sliver behind.
    if (!std::exchange(m_presentationNeedsFullRedraw, false) && scale > 0) {
        for (auto& rect : damage) {
            BRect logical(std::floor(rect.x() / scale), std::floor(rect.y() / scale),
                std::ceil(rect.maxX() / scale) - 1, std::ceil(rect.maxY() / scale) - 1);
            if (logical.IsValid())
                message.AddRect("damage", logical);
        }
    }
    if (std::getenv("SUMMIT_UI_FRAME_STATS"))
        message.AddInt64("summit:queuedMicros", system_time());
    view.SendMessage(&message, static_cast<BHandler*>(nullptr), 0);
}

void WebView::didPresent(uint64_t identifier)
{
    if (identifier == m_presentationIdentifier && m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
}

void WebView::processDidExit()
{
    m_state->load.pending = false;
    m_state->load.identified = false;
    m_state->load.outcome = "process-exited";
    clearLoadErrorHaiku(m_state->load);
    m_state->dialogs->cancelAll();
    BMessage dismissDialogs(javaScriptDialogsCancelHaiku);
    sendToView(dismissDialogs);
    ++m_state->findRequestIdentifier;
    m_undoController.clearAllEditCommands();
    if (m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
    // A dead process has no replacement document whose unload needs checking.
    m_state->closeApprovalInvalidated = false;
    m_state->closeNavigationGeneration = m_state->navigationGeneration;
    m_state->closeDocumentIdentifier = m_state->documentIdentifier;
    notifyState(B_WEBKIT_PROCESS_EXITED);
    if (m_state->closeRequestPending)
        notifyCloseDecisionHaiku(m_state, true);
}

void WebView::didRelaunchProcess()
{
    updateGeometry();
    notifyState();
}

void WebView::pageClosed()
{
    if (m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
}

void WebView::toolTipChanged(const String&, const String& text)
{
    BMessage message(viewTooltipHaiku);
    message.AddString("text", text.utf8().legacyCStringPointer());
    sendToView(message);
}

void WebView::setCursor(const Cursor& cursor)
{
    if (auto* native = cursor.platformCursor()) {
        BMessage archive;
        if (native->Archive(&archive) == B_OK) {
            BMessage message(viewCursorHaiku);
            message.AddMessage("cursor", &archive);
            sendToView(message);
        }
    }
}

void WebView::registerEditCommand(Ref<WebEditCommandProxy>&& command, UndoOrRedo kind) { m_undoController.registerEditCommand(WTF::move(command), kind); }
void WebView::clearAllEditCommands() { m_undoController.clearAllEditCommands(); }
bool WebView::canUndoRedo(UndoOrRedo kind) { return m_undoController.canUndoRedo(kind); }
void WebView::executeUndoRedo(UndoOrRedo kind)
{
    if (m_undoController.canUndoRedo(kind))
        m_undoController.executeUndoRedo(kind);
}
IntPoint WebView::screenToRootView(const IntPoint& point) { return point - toIntSize(geometry().screenOrigin); }
IntPoint WebView::rootViewToScreen(const IntPoint& point) { return point + toIntSize(geometry().screenOrigin); }
IntRect WebView::rootViewToScreen(const IntRect& rect) { auto result = rect; result.move(toIntSize(geometry().screenOrigin)); return result; }

RefPtr<WebPopupMenuProxy> WebView::createPopupMenuProxy(WebPageProxy& page) { return WebPopupMenuProxyHaiku::create(m_state, page.popupMenuClient()); }
RefPtr<WebColorPicker> WebView::createColorPicker(WebPageProxy&, const Color&, const IntRect&, ColorControlSupportsAlpha, Vector<Color>&&, std::optional<FrameIdentifier>) { return nullptr; }
RefPtr<WebDataListSuggestionsDropdown> WebView::createDataListSuggestionsDropdown(WebPageProxy&) { return nullptr; }
RefPtr<WebDateTimePicker> WebView::createDateTimePicker(WebPageProxy&) { return nullptr; }

#if ENABLE(CONTEXT_MENUS)
#if ENABLE(WK_WEB_EXTENSIONS)
// Extension items (menus/contextMenus) of the context menu on screen, named by
// the tokens the host received. Main thread only; a new menu replaces them.
struct ExtensionMenuChoiceHaiku {
    RefPtr<WebExtensionContext> context;
    Ref<WebExtensionMenuItem> item;
    WebExtensionMenuItemContextParameters parameters;
};

static std::unordered_map<uint64_t, ExtensionMenuChoiceHaiku>& extensionMenuChoicesHaiku()
{
    static NeverDestroyed<std::unordered_map<uint64_t, ExtensionMenuChoiceHaiku>> choices;
    return choices.get();
}

static void addExtensionMenuItemsHaiku(BMessage& into, WebExtensionContext& context, const WebExtensionMenuItem::MenuItemVector& items,
    const WebExtensionMenuItemContextParameters& parameters)
{
    static uint64_t lastToken;
    for (const auto& item : items) {
        if (!item->isVisible() || !item->matches(parameters))
            continue;
        BMessage entry;
        if (item->type() == WebExtensionMenuItemType::Separator) {
            entry.AddBool("separator", true);
            into.AddMessage("item", &entry);
            continue;
        }
        // Chrome and Firefox show the selection in place of %s.
        addTextHaiku(entry, "title", makeStringByReplacingAll(item->title(), "%s"_s, parameters.selectionString));
        entry.AddBool("enabled", item->isEnabled());
        entry.AddBool("checkable", isCheckedType(item->type()));
        entry.AddBool("checked", item->isChecked());
        if (!item->submenuItems().isEmpty())
            addExtensionMenuItemsHaiku(entry, context, item->submenuItems(), parameters);
        else {
            const uint64_t token = ++lastToken;
            extensionMenuChoicesHaiku().emplace(token, ExtensionMenuChoiceHaiku { &context, item, parameters });
            entry.AddUInt64("token", token);
        }
        into.AddMessage("item", &entry);
    }
}

// As WebExtensionContext::addItemsToContextMenu on macOS: the clicked
// element's contexts, for every loaded extension allowed on this page.
static void addExtensionMenusHaiku(BMessage& message, WebPageProxy& page, const ContextMenuContextData& contextData, const FrameInfoData& fallbackFrame)
{
    extensionMenuChoicesHaiku().clear();
    RefPtr controller = page.webExtensionController();
    if (!controller)
        return;
    const auto& hitTest = contextData.webHitTestResultData();
    const FrameInfoData& frame = hitTest && hitTest->frameInfo ? *hitTest->frameInfo : fallbackFrame;
    for (Ref context : controller->extensionContexts()) {
        if (!context->isLoaded() || context->mainMenuItems().isEmpty()
            || !(context->hasPermission(WebExtensionPermission::menus()) || context->hasPermission(WebExtensionPermission::contextMenus())))
            continue;
        WebExtensionMenuItemContextParameters parameters;
        parameters.frameIdentifier = toWebExtensionFrameIdentifier(frame);
        parameters.frameURL = frame.request.url();
        RefPtr tab = context->getTab(page.identifier());
        if (tab)
            parameters.tabIdentifier = tab->identifier();
        if (!context->hasPermission(frame.request.url(), tab.get()) && (!tab || !frame.isMainFrame || !context->hasPermission(WebExtensionPermission::activeTab())))
            continue;
        if (hitTest) {
            if (!hitTest->absoluteImageURL.isEmpty()) {
                parameters.types.add(WebExtensionMenuItemContextType::Image);
                parameters.sourceURL = URL { hitTest->absoluteImageURL };
            }
            if (!hitTest->absoluteMediaURL.isEmpty() && hitTest->elementType != WebHitTestResultData::ElementType::None) {
                parameters.sourceURL = URL { hitTest->absoluteMediaURL };
                parameters.types.add(hitTest->elementType == WebHitTestResultData::ElementType::Audio
                    ? WebExtensionMenuItemContextType::Audio : WebExtensionMenuItemContextType::Video);
            }
            if (hitTest->isContentEditable) {
                parameters.types.add(WebExtensionMenuItemContextType::Editable);
                parameters.editable = true;
            }
            if (hitTest->isSelected && !contextData.selectedText().isEmpty()) {
                parameters.types.add(WebExtensionMenuItemContextType::Selection);
                parameters.selectionString = contextData.selectedText();
            }
            if (!hitTest->absoluteLinkURL.isEmpty()) {
                parameters.types.remove(WebExtensionMenuItemContextType::Selection);
                parameters.types.add(WebExtensionMenuItemContextType::Link);
                parameters.linkURL = URL { hitTest->absoluteLinkURL };
                parameters.linkText = hitTest->linkLabel;
            }
        }
        if (parameters.types.isEmpty())
            parameters.types.add(frame.isMainFrame ? WebExtensionMenuItemContextType::Page : WebExtensionMenuItemContextType::Frame);
        BMessage extension;
        addExtensionMenuItemsHaiku(extension, context, context->mainMenuItems(), parameters);
        if (extension.HasMessage("item")) {
            addTextHaiku(extension, "name", protect(context->extension())->displayShortName());
            message.AddMessage("extension", &extension);
        }
    }
}

void performExtensionMenuItemHaiku(uint64_t token)
{
    ASSERT(RunLoop::isMain());
    auto found = extensionMenuChoicesHaiku().find(token);
    if (found == extensionMenuChoicesHaiku().end())
        return;
    auto choice = std::move(found->second);
    extensionMenuChoicesHaiku().clear();
    if (RefPtr context = choice.context; context && context->isLoaded())
        context->performMenuItem(choice.item, choice.parameters, WebExtensionContext::UserTriggered::Yes);
}
#else
void performExtensionMenuItemHaiku(uint64_t) { }
#endif

// The host builds its own native menu from what was clicked; WebKit's
// proposed items (and their actions) are not used.
class PendingContextMenuHaiku final : public WebContextMenuProxy {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(PendingContextMenuHaiku);
public:
    PendingContextMenuHaiku(std::weak_ptr<WebViewStateHaiku> state, WebPageProxy& page, FrameInfoData&& frame, ContextMenuContextData&& context, const UserData& data)
        : WebContextMenuProxy(page, WTF::move(frame), WTF::move(context), data), m_state(std::move(state)) { }
private:
    void showContextMenuWithItems(Vector<Ref<WebContextMenuItem>>&&) override
    {
        if (auto state = m_state.lock(); state && !state->closed) {
            BMessage message(B_WEBKIT_CONTEXT_MENU);
            const auto location = m_context.menuLocation();
            message.AddPoint("where", BPoint(location.x(), location.y()));
            addTextHaiku(message, "selected_text", m_context.selectedText());
            addTextHaiku(message, "frame_url", m_frameInfo.request.url().string());
            message.AddBool("main_frame", m_frameInfo.isMainFrame);
            if (const auto& hit = m_context.webHitTestResultData()) {
                addTextHaiku(message, "link_url", hit->absoluteLinkURL);
                addTextHaiku(message, "link_label", hit->linkLabel);
                addTextHaiku(message, "link_title", hit->linkTitle);
                addTextHaiku(message, "link_filename", hit->linkSuggestedFilename);
                addTextHaiku(message, "image_url", hit->absoluteImageURL);
                addTextHaiku(message, "image_filename", hit->imageSuggestedFilename);
                addTextHaiku(message, "media_url", hit->absoluteMediaURL);
                message.AddBool("editable", hit->isContentEditable);
                message.AddBool("selected", hit->isSelected);
                message.AddBool("downloadable_media", hit->isDownloadableMedia);
            }
#if ENABLE(WK_WEB_EXTENSIONS)
            if (RefPtr page = this->page())
                addExtensionMenusHaiku(message, *page, m_context, m_frameInfo);
#endif
            sendToHostHaiku(state, message);
        }
        if (RefPtr page = this->page())
            page->didDismissContextMenu();
    }

    const std::weak_ptr<WebViewStateHaiku> m_state;
};

Ref<WebContextMenuProxy> WebView::createContextMenuProxy(WebPageProxy& page, FrameInfoData&& frame, ContextMenuContextData&& context, const UserData& data)
{
    return adoptRef(*new PendingContextMenuHaiku(m_state, page, WTF::move(frame), WTF::move(context), data));
}
#endif

void WebView::requestDOMPasteAccess(DOMPasteAccessCategory, DOMPasteRequiresInteraction, FrameIdentifier, const IntRect&, const String&, CompletionHandler<void(DOMPasteAccessResponse)>&& callback)
{
    callback(DOMPasteAccessResponse::DeniedForGesture);
}

void WebView::processWillSwap()
{
    // PageClient's default treats a normal navigation swap as a process exit.
    // Preserve the in-flight load and tab state while dropping the old
    // process's outstanding presentation callback.
    if (m_presentationCallback)
        std::exchange(m_presentationCallback, { })();
}

} // namespace WebKit
