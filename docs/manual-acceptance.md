# Manual acceptance

> **Текущий статус: NOT EXECUTED.** Этот файл является чек-листом, а не доказательством прохождения. Ни один real-provider scenario ниже не считается выполненным без даты, environment, tester и сохранённых redacted evidence. Unit/integration tests и synthetic fixtures не заменяют ручную provider-проверку.

## Запись запуска

| Поле | Значение |
|---|---|
| Release commit/tag | NOT RECORDED |
| Дата и timezone | NOT RECORDED |
| Tester | NOT RECORDED |
| OS / Node.js | NOT RECORDED |
| Chrome version | NOT RECORDED |
| Edge version | NOT RECORDED |
| Extension ZIP SHA-256 | NOT RECORDED |
| Policy matrix review date | NOT RECORDED |
| Real provider test accounts | NOT RECORDED |
| Evidence directory | NOT RECORDED |

Не записывайте в evidence provider tokens, cookies, private playlist URLs, email, track titles из приватной библиотеки или raw browser storage. Используйте redacted screenshots/IDs и synthetic playlists.

## Gate prerequisites

- [ ] Повторно проверены актуальные Spotify, SoundCloud и YouTube official policies.
- [ ] `SC-BASE-LEGAL` получен в письменном виде и положителен перед любой автоматической SoundCloud API/DOM mutation; без него проверяется только user-operated `MANUAL_ONLY` path.
- [ ] Spotify/SoundCloud DOM/UI accelerators остаются disabled, если отдельное письменное разрешение отсутствует.
- [ ] Competitive side-by-side playback disabled для каждой пары без письменного разрешения обоих provider-ов и бесплатного official player path.
- [ ] YouTube BYO project один и фиксированный; project rotation для quota bypass исключён.

Пока второй пункт не закрыт, четыре направления с SoundCloud принудительно работают как **MANUAL_ONLY**: app automation выключена, а пользователь вручную выполняет выданное действие на официальной странице и отдельно подтверждает видимый результат.

## Автоматический release check

- [ ] Fresh checkout/clean workspace: `npm ci`.
- [ ] `npm run check` завершился с exit code 0.
- [ ] Повторный `npm run extension:build` дал тот же ZIP SHA-256 на том же commit/toolchain.
- [ ] Production server `npm run start` слушает только `127.0.0.1:3210`.
- [ ] `/api/health` с session cookie и nonce сообщает local SQLite и отсутствие hosted dependencies; без nonce отвечает отказом.
- [ ] Проверено, что repository/artifacts не содержат `.data`, `.env.local`, tokens, cookies или private URLs.

## Local profile и vault

- [ ] Новый профиль отвергает passphrase короче 10 символов.
- [ ] Верный passphrase разблокирует vault; неверный не раскрывает данные и не ломает профиль.
- [ ] Lock удаляет открытый ключ из памяти приложения; restart требует unlock.
- [ ] Provider password нигде не запрашивается.
- [ ] Encrypted backup создаётся и открывается только с правильным отдельным passphrase.
- [ ] Diagnostics redacts `authorization`, access/refresh token, secrets и private URL tokens.
- [ ] Disconnect удаляет локальные credentials выбранного provider-а.
- [ ] Clear history сохраняет profile/connections и удаляет transfer history.
- [ ] Delete account удаляет локальный профиль/connections/history/quota/import draft/handoffs и fail-closed останавливается без `SESSION_CLEAR` либо отдельной аттестации после ручной очистки popup.

## Loopback/security smoke

- [ ] UI и mutations работают на exact `http://127.0.0.1:3210`.
- [ ] `localhost`, неверный Host и cross-origin mutation получают fail-closed response.
- [ ] Mutation без CSRF отклоняется.
- [ ] OAuth state/PKCE callback нельзя повторно claim-нуть.
- [ ] Oversized/malformed provider URL, extension JSON и handoff отклоняются.
- [ ] Private SoundCloud query token не появляется в UI/report/diagnostics.
- [ ] CSP/frame/referrer/permissions headers присутствуют в production response.

## Guided MV3 — Chrome и Edge

- [ ] Unpacked build загружается в Chrome без warnings о запрещённых permissions.
- [ ] Unpacked build загружается в Edge.
- [ ] Manifest имеет только `activeTab` и `storage`; нет host permissions/content scripts.
- [ ] Pairing работает только с exact `/extension-bridge` origin.
- [ ] Expired invite/handoff и повторный request ID отклоняются.
- [ ] Capture происходит только после user click на extension action.
- [ ] Staged navigation требует отдельный user click и не открывает background tab сама.
- [ ] Spotify, SoundCloud и YouTube URL capture проходит без DOM access.
- [ ] Несколько последовательных public resource capture накапливаются в одном import draft; private SoundCloud URL туда не попадает.
- [ ] Service-tab с публичного profile URL открывает и заполняет Connections, а generic feed/resource page отклоняется.
- [ ] Unknown/unsupported page возвращает fail-closed result с manual fallback.
- [ ] Extension reload/browser restart очищает session payload.

## Provider connection/import

### Spotify SpotAPI + guided fallback

- [ ] Обычный бесплатный аккаунт, без developer app/Premium prerequisite.
- [ ] Diagnostic находит локальный Python и точную SpotAPI version; отсутствующая dependency даёт actionable error.
- [ ] Форма принимает `sp_dc`/`sp_key`, отбрасывает прочие cookies и никогда не показывает secret после submit.
- [ ] Owned library показывает только owner-match + `canEditItems`; followed/public playlists исключены.
- [ ] Catalog search возвращает реальные track IDs; SAFE/RISKY thresholds не выбирают случайный первый result.
- [ ] Append выполняет read-before-write и read-after-write; ambiguous timeout требует reconciliation.
- [ ] Истёкшая cookie session переводит connection в `REAUTH_REQUIRED` без blind retry.
- [ ] Exact track и playlist share URLs принимаются; неверный origin/resource отклоняется.
- [ ] oEmbed evidence не выдаётся за ownership/write verification.

### YouTube guided и BYO API

- [ ] Manual watch URL всегда даёт конкретный 11-символьный `videoId`.
- [ ] Desktop Client ID + PKCE loopback проходит; если Google требует generated client secret, он задан только в `.env.local` и не отображается в UI.
- [ ] UI показывает конкретный YouTube channel.
- [ ] API source list содержит только owned playlists в guaranteed scope.
- [ ] Multi-channel account требует осознанного выбора/проверки channel.
- [ ] OAuth Testing expiry/reauth показывается честно.
- [ ] Quota estimate разделяет search/general; exhaustion предлагает reset/manual URL, не DOM/auto-click.
- [ ] Read-after-write membership создаёт `VERIFIED_PROVIDER` только для точного `videoId`.
- [ ] YouTube Music visibility отображается как limitation, а не гарантия.

### SoundCloud guided/manual

- [ ] Без положительного `SC-BASE-LEGAL` transfer помечен **MANUAL_ONLY**, а app не выполняет API/DOM mutation или auto-click.
- [ ] Permalink/import работает без Artist Pro и выдаёт точные official-page действия.
- [ ] oEmbed не выдаётся за URN/duration/ownership/write proof.
- [ ] Private permalink redacted; cookies/DOM/network responses не читаются.
- [ ] Playlist >500 items останавливается или разбивается только после confirmation.
- [ ] Reconciliation создаёт только `USER_CONFIRMED_MANUAL`, никогда `VERIFIED_PROVIDER`.

## Матрица real-provider transfer

Каждый ряд должен быть выполнен для `SEPARATE_COPY`, `MERGE_NEW`, `APPEND_EXISTING`; для `SAFE` и `RISKY`; с review on и off. Минимально проверьте small и medium synthetic playlists. Large/limit сценарии ведутся отдельно и не должны расходовать quota без preflight.

| Направление | Status | Evidence | Notes |
|---|---|---|---|
| Spotify → YouTube | NOT EXECUTED | — | — |
| YouTube → Spotify | NOT EXECUTED | — | — |
| Spotify → SoundCloud | NOT EXECUTED | — | `MANUAL_ONLY`; automation gate `SC-BASE-LEGAL=UNKNOWN` |
| SoundCloud → Spotify | NOT EXECUTED | — | `MANUAL_ONLY`; automation gate `SC-BASE-LEGAL=UNKNOWN` |
| SoundCloud → YouTube | NOT EXECUTED | — | `MANUAL_ONLY`; automation gate `SC-BASE-LEGAL=UNKNOWN` |
| YouTube → SoundCloud | NOT EXECUTED | — | `MANUAL_ONLY`; automation gate `SC-BASE-LEGAL=UNKNOWN` |

Для каждого выполненного case зафиксируйте:

- [ ] Source version/snapshot и item count до записи.
- [ ] Destination ID и count до записи.
- [ ] Immutable write-plan hash/idempotency keys.
- [ ] Сохранение порядка и повторов согласно настройкам.
- [ ] Candidate IDs реальны; YouTube везде содержит `videoId`.
- [ ] Review decision сохраняется per item и переживает reload.
- [ ] Interrupted job возобновляется без скрытых дублей.
- [ ] Ambiguous timeout выполняет verify-before-retry/reconciliation.
- [ ] Final counts отдельно: provider-verified, user-confirmed, unverified, skipped, errors.
- [ ] Report содержит provider limitations и не называет manual receipt independent verification.

## Matching/review UX

- [ ] Safe auto-match precision gate `>=99%` подтверждён только на synthetic/licensed provider-neutral gold set.
- [ ] Не менее 1800 examples, минимум 300 на логическое направление и минимум 40% hard cases.
- [ ] Provider content не сохранён как benchmark corpus и не отправлялся в LLM/embedding/fingerprinting.
- [ ] Duration/version markers меняют decision/risk flag ожидаемым образом.
- [ ] Review показывает 3–5 реальных candidates с attribution.
- [ ] Только один player играет одновременно.
- [ ] YouTube official iframe стартует максимально близко к 25% после user gesture и остаётся видимым.
- [ ] Spotify/SoundCloud отображаются sequential/link-out, явно не как full comparison.

## Accessibility и UI

- [ ] Keyboard-only: profile, connections, import, wizard, review, guided reconciliation, report и delete.
- [ ] Focus indicator видим на onyx/jet/snow/gold palette.
- [ ] Screen reader объявляет progress, risk, verification и errors.
- [ ] Zoom 200% и narrow viewport не теряют controls/content.
- [ ] `prefers-reduced-motion` соблюдается.
- [ ] Цвет не является единственным носителем safe/risky/status.
- [ ] В release UI нет glass, shadows или декоративных borders.

## Strict gate — отдельно от guided baseline

Следующие пункты не закрываются sequential/link-out или self-attestation:

- [ ] Provider-verifiable owned/collaborative eligibility для заявленного scope.
- [ ] Письменное разрешение обоих provider-ов для side-by-side competitive playback.
- [ ] Бесплатные official players позволяют обоим трекам проигрываться рядом внутри app с seek около 25%.
- [ ] Spotify/SoundCloud approvals сохранены в release evidence.

До выполнения всех пунктов strict UX имеет статус **NOT MET — EXTERNAL GATE**. Это не блокирует честный guided local release для разрешённых provider paths, но запрещает заявлять полный неизменённый strict DoD.

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Engineering | NOT SIGNED | — | — |
| Security/privacy | NOT SIGNED | — | — |
| Provider policy | NOT SIGNED | — | — |
| Manual acceptance | NOT SIGNED | — | — |
