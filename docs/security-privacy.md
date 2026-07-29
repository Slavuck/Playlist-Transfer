# Безопасность и приватность

Playlist-Transfer рассчитан на одного локального пользователя и literal loopback listener. Это не multi-user web service и не hosted security profile.

## Trust boundaries

1. **Локальный browser UI** взаимодействует только с `http://127.0.0.1:3210`.
2. **Local Node process** проверяет Host, Origin, session и CSRF и единственный имеет доступ к SQLite и открытому vault key.
3. **Provider endpoints** получают только свои OAuth/API/oEmbed запросы; один provider не получает token другого. YouTube API и provider oEmbed полностью выключены по умолчанию и не получают запросов без соответствующего точного acknowledgement-флага.
4. **MV3 extension** не является token vault/API proxy. Оно принимает typed one-time handoff и работает только после user gesture.
5. **Официальные provider tabs** остаются под управлением пользователя. Default build не читает DOM и не выполняет auto-click.

## Какие данные хранятся

| Данные | Где | Защита/retention |
|---|---|---|
| Local profile verifier | SQLite `local_profile` | scrypt salt + AES-GCM verifier; исходный пароль не хранится |
| Provider OAuth credentials | SQLite `service_connections.encrypted_secret` | AES-256-GCM; ключ только в памяти разблокированного local process |
| Guided connection attestation | SQLite | Не содержит provider password/token |
| Playlist snapshots и metadata | SQLite | Локально; default expiry marker 24 часа, explicit clear/delete доступен |
| Transfer settings, decisions, journal, receipts | SQLite | Локально для resume/idempotency/audit |
| Quota ledger | SQLite | Только counters/buckets, без track content |
| Loopback session, OAuth state, vault key | Память Node process | Теряется при process restart; session максимум 4 часа, OAuth state 10 минут |
| Extension pairing/handoff/navigation | `chrome.storage.session` | TTL, one-time claim/replay guard; очищается при browser/extension restart |

SQLite playlist metadata и journal не зашифрованы целиком. Шифруются credentials и portable backup. Поэтому ОС-account, filesystem permissions, full-disk encryption и блокировка экрана остаются частью threat model. Не размещайте `.data` в общем или автоматически синхронизируемом каталоге.

Snapshot expiry timestamp сам по себе не гарантирует мгновенное физическое удаление SQLite pages. Для немедленной логической очистки используйте `Clear history` или `Delete account`; для повышенных требований дополнительно удалите локальные backup-файлы и примените средства безопасного удаления/дискового шифрования ОС.

## Локальный vault

- KDF: scrypt, `N=16384`, `r=8`, `p=1`, случайная 16-byte salt.
- Cipher: AES-256-GCM, случайный 12-byte IV, authentication tag и purpose-specific AAD.
- Минимальная длина profile/backup passphrase — 10 символов; выбирайте длинную уникальную фразу.
- Vault key не сериализуется и очищается при lock/restart в пределах возможностей JavaScript runtime.
- Неверный пароль возвращает ошибку без расшифровки credentials.

Локальный пароль не является provider password. Восстановления пароля нет: без него encrypted connection secrets не читаются.

## Loopback/session controls

- Server scripts bind `127.0.0.1:3210`, не `0.0.0.0`.
- Request URL должен иметь `http`, hostname `127.0.0.1` и ожидаемый port.
- Host и Origin сверяются с exact `PLAYLIST_TRANSFER_ORIGIN`.
- Mutation требует header `x-playlist-transfer-csrf`, связанный с HttpOnly `SameSite=Strict` session cookie.
- Session и OAuth/claim operations имеют локальные rate limits.
- OAuth callback state одноразовый и истекает; YouTube использует PKCE S256.
- Ответы и CSP запрещают framing, object content, лишние browser permissions и uncontrolled script origins.

Plain HTTP допустим только для literal loopback OAuth flow. Не добавляйте DNS aliases, LAN interfaces, tunnels или reverse proxy без отдельного threat review.

## URL/network controls

- Принимаются только HTTPS URL exact provider hosts и известные entity shapes; credentials в URL authority и нестандартные ports запрещены.
- Spotify canonical host: `open.spotify.com`.
- SoundCloud canonical hosts: `soundcloud.com`/`www.soundcloud.com`; private secret URL не попадает в clickable report и редактируется.
- YouTube hosts ограничены official watch/playlist/share variants; video ID проверяется как 11-символьный.
- oEmbed endpoint выбирается приложением из allowlist, redirects запрещены, timeout 8 секунд, ответ ограничен 256 KB.
- YouTube API requests идут только к Google OAuth/YouTube Data endpoints, используют timeout и schema checks.

Обе сетевые возможности fail-closed: `PLAYLIST_TRANSFER_ENABLE_PROVIDER_OEMBED` и `PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API` должны быть равны точной строке `I_ACCEPT_PROVIDER_POLICIES`. Любое другое или отсутствующее значение оставляет endpoint закрытым. Эта строка — attestation оператора, не результат compliance audit и не способ закрыть внешние provider gates.

Не реализуются cookies extraction, webRequest interception, password reading, internal client ID/token extraction, CAPTCHA/DRM/quota bypass, stream ripping или undocumented YouTube Music endpoints.

## MV3 extension

Default manifest содержит только:

```json
{
  "permissions": ["activeTab", "storage"]
}
```

Нет `host_permissions`, content scripts, scripting/cookies/webRequest/debugger/downloads permissions и remote code. CSP расширения задаёт `connect-src 'none'`. Единственная externally connectable page — exact `http://127.0.0.1:3210/extension-bridge`.

Pair invite истекает через 2 минуты, handoff — через 5 минут, staged navigation — через 10 минут. Request ID защищён от replay. Navigation не открывается автоматически: её подтверждает пользователь отдельным click.

Private SoundCloud secret tokens редактируются в UI и шифруются в session storage до одноразового claim. Они не сохраняются в app-side import draft и не становятся transfer input; для переноса нужен безопасный публичный permalink или локальный export. SoundCloud-направления работают только как `MANUAL_ONLY` карточки на официальной странице. Extension никогда не получает provider OAuth token или app session cookie и не присваивает данным `VERIFIED_PROVIDER`.

## OAuth и provider-specific ограничения

### YouTube

- API/OAuth path опционален и по умолчанию закрыт `PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API=disabled`; guided exact-URL path не зависит от него.
- Desktop OAuth Client + Authorization Code/PKCE/loopback.
- `youtube.readonly` для чтения; `youtube.force-ssl` для записи, потому что playlist-only write scope отсутствует.
- Refresh/access tokens доступны только local backend и хранятся в vault.
- `invalid_grant`, отсутствующий refresh token или HTTP 401 сохраняют connection как `REAUTH_REQUIRED`; API path останавливается до нового полного OAuth, без blind retry.
- Quota ledger разделяет `search` и `general` и формирует period key по `America/Los_Angeles` (Pacific date, включая DST), а не по локальной дате ОС.
- Disconnect/delete сначала вызывает официальный Google revocation endpoint. Если он недоступен, локальное удаление не продолжается: пользователь отзывает grant в [Google Account security permissions](https://security.google.com/settings/security/permissions) и отдельно подтверждает manual fallback. После revoke удаляются локальные credentials и связанные YouTube API Data; provider playlists не удаляются.
- Cross-provider автоматический YouTube search и derived scoring заблокированы policy gate. Пользователь может сравнить неизменённые raw metadata для 3–5 вручную выбранных official URL и сохранить exact `videoId` без вычисленного cross-provider score.

### Spotify

Guided baseline не получает Spotify token. Spotify API/Web Playback optional profiles не входят в zero-budget release. DOM reader/UI writer выключены; competitive playback имеет policy state `blocked`, поэтому review использует только явно помеченный sequential/link-out. Spotify oEmbed также выключен по умолчанию и требует общего точного oEmbed acknowledgement-флага.

### SoundCloud

Guided baseline не получает OAuth token. Public permalink можно локально разобрать, а oEmbed по умолчанию выключен. Пока `SC-BASE-LEGAL` остаётся `unknown`, любой transfer с SoundCloud принудительно работает как `MANUAL_ONLY`: приложение не выполняет API/DOM mutation, автоматическое создание destination или auto-click, но выдаёт последовательные official-page действия и ждёт явную пользовательскую reconciliation. Artist Pro/API не prerequisite. Competitive playback выключен.

## Backup, export и удаление

Portable backup использует отдельную scrypt/AES-256-GCM envelope. Перед шифрованием connection credentials временно существуют в памяти local process. Содержимое нельзя экспортировать в diagnostics: diagnostics проходят recursive secret redaction.

Backup-файл содержит credentials внутри зашифрованного payload. Храните его как секрет, используйте уникальный пароль и удаляйте старые копии. Потерянный backup passphrase не восстанавливается.

- **Disconnect provider** удаляет локальный encrypted connection record.
- **Clear history** удаляет snapshots, transfers/items, decisions, receipts, journal и audit, но сохраняет профиль/connections.
- **Delete account** удаляет профиль, connections, history, quota, публичный MV3 import draft, handoffs и блокирует vault. Операция не вызывает SQLite wipe, пока bridge не подтвердит `SESSION_CLEAR`; при недоступном bridge пользователь сначала очищает extension popup и затем выполняет отдельную manual-fallback аттестацию.
- Для guided connections локальная SQLite-операция не изменяет provider-side data. Для YouTube API connection приложение сначала пытается отозвать token у Google; при сетевой ошибке требуется отдельный manual revoke + confirmation, иначе локальное удаление fail-closed останавливается.

Краткие disclosure для локального оператора доступны в UI и напрямую по [`/privacy.html`](http://127.0.0.1:3210/privacy.html) и [`/terms.html`](http://127.0.0.1:3210/terms.html). Их наличие не означает, что provider/security compliance audit или ручная acceptance-проверка выполнены.

## Honest evidence и logging

Audit должен содержать event types, opaque subject IDs и технические details без Authorization headers, provider tokens и private share links. Report выводит provider limitations.

`VERIFIED_PROVIDER` допустим только с independent provider read-back после записи. Official oEmbed подтверждает entity existence/metadata, но не membership. `USER_CONFIRMED_MANUAL` — только явная аттестация пользователя; `WRITE_UNVERIFIED` и ambiguous results не считаются успехом.

## Известные ограничения

- Это персональный local tool; защита от пользователя с полным доступом к OS/process memory не обещается.
- Full-database encryption и аппаратный OS key store не обязательны в текущем passphrase baseline.
- Реальный provider security/compliance audit, browser store privacy review и ручная acceptance-проверка не заявлены выполненными или подписанными.
- `SC-BASE-LEGAL` и competitive playback permissions остаются внешними gates.
- Любое изменение provider policy, OAuth scope, quota или API schema требует повторного review перед release.
