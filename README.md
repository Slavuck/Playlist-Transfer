# Playlist-Transfer

Playlist-Transfer — бесплатное local-first приложение для переноса плейлистов между Spotify, SoundCloud и YouTube/YouTube Music. Оно запускается на компьютере пользователя, хранит состояние в локальной SQLite и использует официальный API только там, где он доступен без обязательной оплаты. Во всех остальных случаях приложение формирует пошаговый guided workflow: открывает официальную страницу, а действие `Add`/`Save` выполняет сам пользователь.

В базовой сборке нет hosted/SaaS-профиля, Premium-функций, платной БД, платной очереди, обязательного Spotify developer app или SoundCloud Artist Pro. Safe/risky и review — настройки каждого переноса внутри одного приложения, а не разные продукты.

## Как теперь устроен нормальный сценарий

1. В **Подключениях** подключите Google OAuth для прямой YouTube-библиотеки либо сохраните identity Spotify/SoundCloud для честного guided fallback.
2. В **Плейлистах** YouTube показывает owned-плейлисты аккаунта: отметьте нужные списки и нажмите одну кнопку синхронизации. Название, owner, count и все `videoId` приложение читает само.
3. Архивный путь остаётся дополнительным: скачайте официальный export Spotify или Google Takeout и загрузите один локальный файл (`ZIP`, `JSON`, `CSV/TSV`, `M3U/M3U8` или `TXT`). До 10 000 треков импортируются за одно действие с сохранением порядка и повторов. Приложение не отправляет архив на сервер. Построчная форма скрыта в аварийном разделе и не является основным UX.
4. В мастере выберите source snapshots, сервис назначения и режим. При назначении в существующий owned YouTube-плейлист выберите его из библиотеки аккаунта — URL, owner и count заполняются и затем перечитываются официальным API.

Почему не обещан такой же прямой OAuth для всех трёх сервисов: актуальный Spotify Development Mode требует Premium у владельца developer app и ограничивает allowlist, а self-service API credentials SoundCloud выдаются владельцам Artist Pro. Делать эти платные условия обязательными запрещено zero-budget baseline, а scraping/чтение DOM не используется. Поэтому UI больше не называет сохранённый URL профиля «подключённой библиотекой» и прямо показывает разницу между `API CONNECTED` и `IDENTITY SAVED`.

Distributable baseline запускается fail-closed: YouTube Data API и все provider oEmbed-запросы выключены. Они становятся доступны только при точном значении `I_ACCEPT_PROVIDER_POLICIES` у соответствующей переменной окружения; это подтверждение ответственности оператора локальной установки, а не автоматически выполненный compliance review. Без флагов остаются URL-only/manual workflows.

## Важное ограничение SoundCloud

`SC-BASE-LEGAL` остаётся внешним юридическим gate со статусом **UNKNOWN**, поэтому текущий runtime fail-closed присваивает любому направлению с SoundCloud статус **`BLOCKED_EXTERNAL`** до первой provider mutation. Импорт публичного permalink и локальная attestation вкладки могут использоваться как техническая подготовка, но не запускают перенос и не закрывают gate. Даже включённый oEmbed не является письменным разрешением SoundCloud на cross-service transfer. Для изменения этого поведения нужны применимое письменное решение provider-а, обновление policy registry и отдельная release-проверка; scraping не является fallback.

DOM/UI automation Spotify и SoundCloud выключена. Для YouTube DOM/auto-click fallback отсутствует. Strict side-by-side playback конкурирующих сервисов также не заявлен: production fallback — явно помеченный sequential/link-out review.

## Быстрый запуск

Нужны Node.js `>=22.13.0`, npm, Chrome или Edge и обычные бесплатные аккаунты нужных сервисов.

```powershell
npm ci
npm run check
npm run dev
```

Откройте только [http://127.0.0.1:3210](http://127.0.0.1:3210). Адрес `localhost` намеренно не считается эквивалентом: локальные session/OAuth проверки привязаны к literal loopback origin.

При первом запуске создайте локальный профиль и пароль длиной не менее 10 символов. Это пароль локального vault, а не пароль Spotify, Google или SoundCloud. Приложение никогда не запрашивает provider-пароли.

Переменные окружения для guided baseline не обязательны. Необязательный шаблон находится в [`.env.example`](.env.example); подробная инструкция по fail-closed flags — в [`docs/run-local.md`](docs/run-local.md).

## MV3-расширение

```powershell
npm run extension:build
```

В `chrome://extensions` или `edge://extensions` включите режим разработчика, выберите **Load unpacked / Загрузить распакованное** и укажите `apps/extension/dist/chromium-guided-unpacked`.

Расширение имеет только разрешения `activeTab` и `storage`, не содержит content scripts или host permissions, не читает DOM и не выполняет клики. Оно захватывает URL текущей вкладки только после явного действия пользователя и подготавливает guided navigation. Сборка также создаёт детерминированный ZIP и `SHA256SUMS`; это локальный review-артефакт, не store-signed пакет.

## Опциональный бесплатный YouTube API-путь

YouTube Data API v3 можно подключить через один Google Cloud project владельца сборки и Desktop OAuth client с PKCE/loopback после установки `PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API=I_ACCEPT_PROVIDER_POLICIES`. Владелец релиза один раз задаёт публичный `PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID`; после этого пользователь видит обычную кнопку **Войти через Google** и ничего не копирует из Google Cloud. Client secret не нужен и не поставляется. Расширенный BYO Client ID оставлен как необязательный fallback для разработчика. После OAuth страница **Плейлисты** показывает owned-библиотеку и массово создаёт/обновляет локальные snapshots. Флаг не доказывает прохождение compliance review. Без него остаются ZIP/bulk-file и manual watch-URL/`Save` workflows. Нельзя создавать или переключать Cloud projects для обхода квоты.

Даже при включённом API cross-provider автоматический поиск и derived scoring YouTube заблокированы policy gate. Пользователь вручную собирает 3–5 точных официальных URL, сравнивает неизменённые raw metadata и выбирает конкретный `videoId`; приложение не показывает вычисленный cross-provider score. API остаётся полезен для собственных YouTube-плейлистов, записи уже выбранных ID и независимого read-after-write.

Для вручную вставленного YouTube URL приложение выполняет точечный `videos.list`, если локальный API-клиент доступен. Только успешный read-back помечается `PROVIDER API · ID CONFIRMED` и может дать duration/embeddable для official iframe около 25%. Без read-back остаются только canonical URL и exact `videoId`: существование, metadata и playback честно показываются как непроверенные/недоступные, а название исходного трека не подставляется кандидату.

YouTube Music здесь означает обычный YouTube-плейлист с реальными `videoId`. У Google нет отдельного YouTube Music API, поэтому наличие videoId после записи не гарантирует, что ролик будет показан в YouTube Music или распознан как музыкальный.

## Честные результаты

- `VERIFIED_PROVIDER` — официальный API независимо перечитал destination после записи и подтвердил конкретный target ID.
- `USER_CONFIRMED_MANUAL` — пользователь явно подтвердил результат guided-действия; это аттестация пользователя, не независимая provider-проверка.
- `UNVERIFIED` / `WRITE_UNVERIFIED` — запись не подтверждена и не считается успехом.
- `ERROR`, `SKIPPED`, `IN_PROGRESS` показываются отдельно и не смешиваются с успешными результатами.

Для YouTube candidate, write plan и report используют конкретный `videoId`; «каноническая песня» не подменяет provider entity.

`SEPARATE_COPY` и `MERGE_NEW` принимают только созданный для текущего переноса новый пустой destination: перед binding пользователь отдельно подтверждает ownership/edit control, факт нового создания и видимый count `0`. `APPEND_EXISTING` использует снимок существующего destination. Перед каждым guided Add приложение требует свежую сверку identity/count и считает baseline только по подтверждённым receipts.

## Команды

```text
npm run dev              локальный dev server на 127.0.0.1:3210
npm run build            production build Next.js
npm run start            локальный production server на 127.0.0.1:3210
npm run lint             ESLint
npm run typecheck        TypeScript без emit
npm test                 unit/integration tests
npm run test:extension   тесты MV3 shell
npm run extension:build  воспроизводимая unpacked/ZIP сборка расширения
npm run worker           локальный coordinator worker
npm run check            полный release-check pipeline
```

## Данные и приватность

По умолчанию данные находятся в `.data/playlist-transfer.sqlite` и не покидают компьютер, кроме явных запросов к официальным provider endpoints. Provider credentials шифруются AES-256-GCM ключом, полученным из локального пароля через scrypt; открытый ключ живёт только в памяти процесса. Никакой телеметрии или закрытого облачного компонента нет.

Локальные страницы раскрытия доступны по [`/privacy.html`](http://127.0.0.1:3210/privacy.html) и [`/terms.html`](http://127.0.0.1:3210/terms.html). Они описывают именно self-operated local build и не означают, что provider compliance audit или ручная приёмка уже выполнены.

Сделайте зашифрованный backup до очистки истории или удаления профиля. Подробности и ограничения описаны в [`docs/security-privacy.md`](docs/security-privacy.md).

## Документация

- [`docs/run-local.md`](docs/run-local.md) — установка, запуск, YouTube BYO OAuth и troubleshooting.
- [`docs/capability-matrix.md`](docs/capability-matrix.md) — возможности, fallback и внешние gates.
- [`docs/security-privacy.md`](docs/security-privacy.md) — модель безопасности, локальные данные и удаление.
- [`docs/manual-acceptance.md`](docs/manual-acceptance.md) — ручная приёмка с незаполненными provider checks.
- [`docs/release-evidence.md`](docs/release-evidence.md) — команды, результаты финального автоматического gate и честные непроверенные внешние пункты.
- [`docs/architecture.md`](docs/architecture.md) — архитектура, состояния и trust boundaries.
- [`Plan_Playlist-Transfer.md`](Plan_Playlist-Transfer.md) — исходный продуктовый и Definition of Done план.

На дату этой документации real-provider checks, provider/security compliance audit и ручная acceptance-проверка **не заявлены как выполненные или подписанные**; актуальный статус фиксируется только в `docs/manual-acceptance.md` с датой, окружением и доказательствами.
