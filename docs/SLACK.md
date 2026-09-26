# Slack on Haiku

## Can the Slack desktop app be ported?

Not by us, and not usefully by running it on Aurora. That work is deferred;
the Slack client for Haiku is **Natter** (`apps/natter`), a native app.

**Slack's desktop client has no source release.** The Linux package
(`slack-desktop-4.52.162-amd64.deb`, September 2026) contains Electron 44.3.0
(Chromium 152, Node 24.20) and `resources/app.asar`: about 1.7 MB of
minified, bundled JavaScript for the main process and preloads. Its
`package.json` says "All rights reserved". The service terms forbid modifying
the client or making derivative works of it, so the asar could not be shipped
with Haiku. At most, an installer could download Slack's own package on the
user's machine, as the AUR `slack-electron` package does to run it on the
system Electron.

Running that asar on Aurora is technically possible to start, but not to
finish:

- **The app is a thin shell around Slack's website.** It loads Slack's
  closed web client from `https://app.slack.com`, and that client drives the
  shell through a large, undocumented contract made for Chromium:
  - a `window.desktop` bridge of 27 namespaces and about 138 members;
  - about 136 IPC channels;
  - a synchronous IPC call before any page script runs;
  - a generic "call any of 98 BrowserWindow methods" RPC;
  - MessagePorts, and functions passed in both directions across the bridge;
  - Chromium's cookie, webRequest and service-worker behaviour;
  - `desktopCapturer` and WebRTC for huddles.
- **The contract changes all the time.** Slack changes the web client
  server-side every week, it can only be tested against a live account, and
  Slack stops serving desktop versions older than about a year.
- **Huddles would never work.** Slack supports them only in Chrome and
  Firefox.
- **Nobody has done it on another engine.** Every known re-host of the asar
  keeps the same Electron major version.

Aurora gives the app everything else it needs, but keeping pace with that
contract would mean reverse-engineering a proprietary client indefinitely.

## What works instead

1. **Natter**, a native Slack client written against the Interface Kit. It
   is modelled on *make-slack-great-again* (msga), a Qt client, but is its
   own MIT-licensed code; msga is GPL-3.0.
   - **Sign-in:** it signs in the way Slack's web client does, with the
     browser's `d` cookie and the `xoxc` session token, or with your own Slack
     app's tokens.
   - **Real time:** RTM, Socket Mode, or polling when neither works.
   - **Features:** channels and direct messages with unread and mention
     counts, threads, reactions, files and images, mentions, custom emoji,
     editing and deleting, uploads, and notifications. Huddles are not
     supported.
   - **Risk:** the session method is unofficial, so Slack can break it.
2. **Slack in the browser.** Slack supports Safari 26 and later, and Summit's
   engine identifies as Safari 26. So `app.slack.com` works in Summit, or in
   an Aurora window pointed at it, without huddles. A probe of Slack's sign-in
   page accepted Safari 26 and version-less WebKit user agents. It refused
   Safari 18 and WebPositive's.

The research, with evidence, is in
`/home/jmgasper/HaikuOverflow/electron/research/slack-viability.md`. It
covers the package's contents, the Electron API use counts, the native
modules, the preload bridge, the user-agent probe, the licence terms and
msga's design.
