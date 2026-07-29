# Playlist-Transfer guided MV3 connector

This is the default zero-budget Chrome/Edge extension. It captures an explicitly selected
Spotify, SoundCloud, or YouTube URL and opens typed guided navigation steps. It never reads
provider DOM, injects scripts, clicks controls, intercepts traffic, or stores provider tokens.

## Build and install

Run `npm run extension:build`. Load
`apps/extension/dist/chromium-guided-unpacked` with **Load unpacked** from either
`chrome://extensions` or `edge://extensions` after enabling developer mode.

The same command produces a deterministic review/archive ZIP and `SHA256SUMS`. The ZIP is not
presented as a replacement for Chrome/Edge store signing; the free local baseline uses Load
unpacked.

## Local bridge

The only externally connectable page is exactly
`http://127.0.0.1:3210/extension-bridge`. The local listener must bind literal `127.0.0.1`,
validate `Host`, `Origin`, CSRF, and its local authenticated session. Bootstrap values arrive in
the URL fragment; the bridge must copy them to memory and immediately call
`history.replaceState(null, "", "/extension-bridge")` before messaging the extension.

External request metadata:

```json
{
  "protocol": "playlist-transfer.extension",
  "schemaVersion": 1,
  "type": "EXT_HELLO",
  "requestId": "a-random-identifier-at-least-16-chars",
  "issuedAtMs": 0,
  "body": { "clientVersion": "1.0.0" }
}
```

Supported external types are `EXT_HELLO`, `PAIR_CLAIM`, `HANDOFF_CLAIM`,
`NAVIGATION_STAGE`, `SESSION_CLOSE`, and authenticated `SESSION_CLEAR`. A staged navigation never opens by itself; it appears
in the popup and requires another explicit click.

Pair invites expire in two minutes, handoffs in five minutes, navigation intents in ten minutes,
and request IDs are replay-protected. Pairing and all captured data use only
`chrome.storage.session`, which is cleared on browser restart, extension reload, disable, or
update.

`service-tab` handoff is available only on a canonical public account-profile page. It opens and
prefills **Connections**; a generic home, feed, track, or playlist page cannot be used as account
attestation. Public resource captures claimed by the app accumulate in one origin-wide local
import draft so consecutive popup captures can be used together. The draft is removed when used,
discarded, or on account deletion. This app-side draft never accepts a secret URL.

Private SoundCloud tokens are redacted from UI, encrypted in session storage, and removed before
the one-time claim response is returned. They are not persisted into the app import draft, and
SoundCloud transfer directions remain `MANUAL_ONLY` while `SC-BASE-LEGAL` is unresolved: the extension may stage a public official URL after explicit user action, but neither the extension nor the app performs API/DOM mutation or auto-click.
The extension does not label a URL capture as
`VERIFIED_PROVIDER` or `USER_CONFIRMED_MANUAL`; those statuses belong to provider API read-back
or an explicit user receipt in the local application.
