# Capability matrix

Версия policy registry в коде: `2026-07-29`. Эта матрица описывает guided zero-budget local build. Дата версии не означает, что provider/security compliance audit или ручная acceptance-проверка выполнены; матрица не является юридическим заключением и не превращает внешний provider gate в `allowed`.

Обозначения:

- **Да** — реализованный baseline path без платной подписки.
- **Guided** — действие выполняет пользователь в видимой официальной вкладке; приложение не нажимает control.
- **Optional API** — бесплатный для конкретной локальной установки официальный accelerator, но не обязательное условие; default выключен и требует точного acknowledgement-флага.
- **External gate** — policy registry не имеет положительного решения; автоматизация остаётся fail-closed. Если официальный API-path недоступен, release обязан сохранить явный user-operated guided/manual path и не выдавать его за разрешённую автоматизацию.
- **Нет** — отключено или запрещено в default build.

## Provider capabilities

| Возможность | Spotify | SoundCloud | YouTube / YouTube Music |
|---|---|---|---|
| Baseline connection | `IDENTITY SAVED` для guided; не library access | `IDENTITY SAVED`/local import; transfer runtime `MANUAL_ONLY` | Обычная кнопка Google sign-in, если владелец сборки настроил Client ID; advanced BYO fallback; прямая owned-библиотека после exact acknowledgement |
| Provider password в приложении | Нет | Нет | Нет |
| Source entity | Официальный Account Data ZIP/JSON до 10 000 позиций либо точный share URL/Spotify ID | Data portability archive только при наличии поддерживаемых playlist-файлов либо точный permalink | Массовый выбор API-owned playlists; иначе Google Takeout ZIP/CSV или точный URL |
| Публичная metadata validation | Default URL syntax; optional oEmbed после exact acknowledgement, без ownership/write proof | Default URL syntax; optional oEmbed после exact acknowledgement, без URN/duration/ownership | Default URL syntax; optional oEmbed/API после exact acknowledgement |
| Guaranteed ownership | `USER_ATTESTED_OWNED` в baseline | `USER_ATTESTED_OWNED`, дополнительно external gate | Только API-owned для guaranteed scope; manual — attested |
| Baseline destination write | User-operated Add/Save | User-operated Add/Save на официальной странице; app не выполняет API/DOM mutation | User-operated Save |
| Provider-verified write | Не в zero-budget baseline | Не в zero-budget baseline | Да, optional BYO API insert + read-after-write после exact acknowledgement |
| Create playlist | Guided | Guided user-operated на официальной странице | Guided или optional BYO API |
| Collaborative | Не заявляется без provider verification | Не поддерживается | Non-owned experimental вне baseline; collaborator membership не доказана API |
| DOM read | Нет, gate unknown/off | Нет, blocked/off | Нет, blocked |
| UI auto-click | Нет, gate unknown/off | Нет, blocked/off | Нет, blocked |
| Official playback около 25% | Link-out/embed без обещания seek | Disabled | Видимый official iframe может seek к ближайшему keyframe |
| Side-by-side competitive playback | Blocked, только sequential/link-out | Blocked, выключено | Недостаточно одного YouTube player: pair требует разрешения второго provider-а |
| Платный API/subscription как prerequisite | Нет | Нет | Нет |
| Главное ограничение | Spotify API development path не baseline; Premium/approval ограничения | Artist Pro API не baseline; `SC-BASE-LEGAL=UNKNOWN` | Нет отдельного YT Music API; quota и видимость в YTM не гарантированы |

### Operational constraints, требующие повторной ручной сверки

Ниже зафиксированы допущения policy registry, а не доказательство завершённого provider review или принятия приложения provider-ом.

- **Spotify:** владелец Development Mode app должен иметь Premium, а development app ограничен небольшим allowlist (на дату review — до 5 пользователей). Это делает API непригодным как гарантированный zero-budget baseline. Общий public connector не поставляется; refresh token не следует считать бессрочным (текущий maximum lifetime — 6 месяцев). Guided share-URL path не зависит от developer app.
- **YouTube:** BYO project использует бесплатную default quota. Текущая локальная модель учитывает отдельный search bucket 100 calls и general bucket 10 000 units на календарную дату `America/Los_Angeles`; `playlistItems.insert` и playlist create моделируются по 50 general units, paginated reads — отдельно. Release gate запрещает cross-provider automatic search/scoring, поэтому обычный manual path не должен автоматически расходовать search bucket. Значения нужно повторно сверять перед release. OAuth project в Testing может требовать частую повторную авторизацию; приложение отражает это как `REAUTH_REQUIRED`.
- **SoundCloud:** self-service API key требует Artist Pro и поэтому исключён из baseline. Public oEmbed не даёт стабильный URN, structured duration, playlist membership или write/ownership proof. Отдельного официального разрешения на конкретный cross-service transfer use case в repository нет; `SC-BASE-LEGAL` остаётся `unknown`.

## Шесть направлений

| Направление | Zero-budget source | Zero-budget destination | Release status |
|---|---|---|---|
| Spotify → YouTube | Spotify bulk export/exact share URLs + user attestation; oEmbed optional/off by default | Manual-selected exact `videoId`: optional BYO API write или guided Save | Технический baseline path; auto search/scoring blocked; real-provider acceptance не выполнен |
| YouTube → Spotify | Массово выбранный API-owned snapshot, bulk export или exact URLs/user attestation | Spotify guided search/Add | Технический baseline path; real-provider acceptance не зафиксирован |
| Spotify → SoundCloud | Spotify guided | SoundCloud user-operated target | `MANUAL_ONLY`: exact official-page actions + reconciliation; no app mutation |
| SoundCloud → Spotify | SoundCloud exact permalink/import | Spotify user-operated Add | `MANUAL_ONLY`: exact official-page actions + reconciliation; no app mutation |
| SoundCloud → YouTube | SoundCloud exact permalink/import | Manual-selected YouTube target | `MANUAL_ONLY`: exact official-page actions + reconciliation; no app mutation |
| YouTube → SoundCloud | API-owned snapshot или exact YouTube URLs | SoundCloud user-operated target | `MANUAL_ONLY`: exact official-page actions + reconciliation; no app mutation |

Ни один путь не должен требовать Spotify Premium, SoundCloud Artist Pro, hosting или платный API. Текущая release-сборка не содержит пользовательского флага, который мог бы открыть автоматическую SoundCloud mutation: даже будущий положительный ответ потребует обновления registry/кода и повторной release-проверки. Import и user-operated guided actions доступны, но всегда помечены `MANUAL_ONLY`; пользовательская reconciliation создаёт только `USER_CONFIRMED_MANUAL`.

## Transfer modes и matching

Три режима являются возможностями одного приложения:

| Режим | Поведение |
|---|---|
| `SEPARATE_COPY` | Каждый выбранный source playlist получает отдельный, созданный для transfer новый пустой destination. Existing playlist и count не равный `0` отклоняются. |
| `MERGE_NEW` | Несколько источников объединяются в один созданный для transfer новый пустой destination с явной политикой порядка/повторов. Existing playlist и count не равный `0` отклоняются. |
| `APPEND_EXISTING` | Добавление в существующий destination после read-before-write или явной guided сверки. |

Matching также задаётся per transfer, а не через тариф/редакцию:

| Risk mode | Review uncertain | Результат |
|---|---:|---|
| `SAFE` | on | Разрешённый provider-validated connector использует высокий порог; в default guided path uncertain item отправляется в ручной review. |
| `SAFE` | off | Uncertain item пропускается, а не добавляется наугад; если selectable items нет, transfer завершается `PARTIAL` без destination/write plan. |
| `RISKY` | on | Разрешённый provider-validated connector может использовать более широкий порог; в default guided path решение остаётся за пользователем и получает видимый risk flag. |
| `RISKY` | off | Только разрешённый provider-validated connector может применить guarded relevance fallback. В policy-gated guided path uncertain item пропускается и остаётся в отчёте. |

Таблица режимов описывает автоматический алгоритм только там, где policy gate разрешает derived matching. В release-путях с Spotify или YouTube более строгий gate блокирует cross-provider automatic search и derived scoring независимо от `SAFE`/`RISKY`; ни один режим не подставляет «первый результат». Переключатель review при этом остаётся функциональным: `on` создаёт явную очередь, `off` честно пропускает uncertain items.

Review принимает 3–5 вручную собранных точных official URL и сохраняет решение per item. Пользователь сравнивает неизменённые raw title/artist/channel/duration metadata только если официальный endpoint действительно вернул их, и сам выбирает provider ID; для policy-gated cross-provider пары score не вычисляется и отображается `MANUAL CHOICE`/`NO DERIVED SCORE`. При недоступном read-back остаются canonical URL, exact ID и ручной выбор со статусом `URL SYNTAX ONLY · UNVERIFIED`: source title не подставляется, existence/duration/embeddable имеют неизвестный статус. LLM, embeddings, audio fingerprinting и скачивание аудио не используются.

## Honest status contract

| Категория отчёта | Что доказано | Считается успехом |
|---|---|---:|
| `VERIFIED_PROVIDER` | Реальный target ID существовал, запись выполнена и официальный provider read-back подтвердил membership после записи | Да |
| `USER_CONFIRMED_MANUAL` | Пользователь явно подтвердил наличие конкретного target ID после guided action | Да, но только как user attestation |
| `WRITE_CONFIRMED_NON_OWNED` | Insert мог пройти, но collaborator/ownership не доказан | Нет, показывается как unverified |
| `WRITE_UNVERIFIED` / `UNVERIFIED` | Provider read-back или явной user attestation нет | Нет |
| `SKIPPED_NOT_FOUND` / `SKIPPED` | Пользователь/политика осознанно пропустили item | Нет |
| `WRITE_FAILED` / `ERROR` | Запись завершилась ошибкой | Нет |
| `IN_PROGRESS` | Финального evidence ещё нет | Нет |

Official oEmbed по умолчанию выключен. После точного operator acknowledgement он может подтвердить существование/публичную metadata entity, но не destination membership и не ownership. Успешное открытие или синтаксическая проверка URL также не являются `VERIFIED_PROVIDER`.

## Policy gates default build

| Gate | Состояние | Default behavior |
|---|---|---|
| Spotify guided transfer | `allowed` | User-operated share URL/search/Add |
| Spotify DOM read / UI write | `unknown` | Выключено, guided fallback |
| Spotify oEmbed metadata | `unknown` | Выключено; только exact acknowledgement может открыть endpoint, не gate |
| Spotify cross-provider auto matching | `blocked` | Нет automatic search/derived score; manual raw-metadata choice |
| Spotify competitive playback | `blocked` | Только sequential/link-out |
| SoundCloud base cross-service use | `unknown` | Automation disabled; runtime выдаёт только `MANUAL_ONLY` official-page actions, нужен письменный ответ и новая release-проверка для автоматизации |
| SoundCloud DOM read / UI write | `blocked` | Не входит в build |
| SoundCloud competitive playback | `blocked` | Не входит в build |
| YouTube owned Data API | `unknown` | Default off; release-owner Client ID или advanced BYO client только при exact acknowledgement |
| YouTube oEmbed metadata | `unknown` | Default off; URL-only manual fallback |
| YouTube cross-provider auto matching | `blocked` | Нет API auto search/derived score; 3–5 manual official URLs |
| YouTube collaborative API | `unknown` | Experimental non-owned вне baseline |
| YouTube DOM read / UI write | `blocked` | Отсутствует; manual URL/Save или quota reset |

Exact acknowledgement для двух optional endpoint-классов — `I_ACCEPT_PROVIDER_POLICIES` в `PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API` либо `PLAYLIST_TRANSFER_ENABLE_PROVIDER_OEMBED`. Это self-attestation оператора, а не изменение значений registry и не доказательство compliance.

## Quota/access fallback

- YouTube: granular ledger разделяет `search` и `general`; period key основан на Pacific date (`America/Los_Angeles`, включая DST). После exhaustion конкретного bucket — ожидание следующей Pacific date либо manual watch URL/Save. Никакой ротации project-ов.
- YouTube auth: `invalid_grant`, отсутствующий refresh token или 401 переводят connection в `REAUTH_REQUIRED`; API не ретраится до нового OAuth. При неудаче Google revoke disconnect/delete требует ручного revoke в Google security settings и отдельного confirmation до удаления локальных API Data.
- Spotify: отсутствие API access не требует оплаты; используется guided official Web Player workflow.
- SoundCloud: отсутствие Artist Pro не требует покупки; exact permalink/export может быть импортирован, а transfer завершается через `MANUAL_ONLY` official-page actions. Ни oEmbed, ни user attestation не открывают `SC-BASE-LEGAL` и не разрешают приложению выполнять API/DOM mutation.
- Любой unknown UI state останавливает automation и возвращает пошаговую reconciliation. Blind retry после неоднозначного timeout запрещён.

## Официальные источники для повторной проверки

Policy/API условия меняются. Перед каждой release-сборкой сверяйте как минимум:

- Spotify: [Developer Policy](https://developer.spotify.com/policy), [Developer Terms](https://developer.spotify.com/terms), [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [Download your data](https://support.spotify.com/article/data-rights-and-privacy-settings/) и [структура Spotify data](https://support.spotify.com/article/understanding-your-data/).
- YouTube: [OAuth for installed apps](https://developers.google.com/identity/protocols/oauth2/native-app), [Data API getting started](https://developers.google.com/youtube/v3/getting-started), [Google Takeout](https://support.google.com/accounts/answer/3024190), [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost), [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) и [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference).
- SoundCloud: [API registration](https://developers.soundcloud.com/docs/api/register-app), [GDPR/data portability](https://help.soundcloud.com/hc/en-us/articles/360004066174-General-Data-Protection-Regulation-GDPR), [API Terms](https://developers.soundcloud.com/docs/api/terms-of-use), [SoundCloud Terms of Use](https://soundcloud.com/terms-of-use) и [Widget API](https://developers.soundcloud.com/docs/api/html5-widget).
- Extension/platform: [Chrome MV3 permissions](https://developer.chrome.com/docs/extensions/mv3/declare_permissions), [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) и [Microsoft Edge extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/).

Ссылки перечислены для будущей ручной проверки. Само их наличие не доказывает, что policy/compliance audit или acceptance выполнены, и не закрывает `SC-BASE-LEGAL` и иные gates: для них требуется применимое к конкретному use case письменное решение provider-а и зафиксированный release evidence.
