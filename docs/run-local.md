# Локальный запуск

Эта инструкция относится к бесплатной local-first редакции. Папка `website/` — отдельная статическая страница релиза для Vercel: она не содержит backend приложения, не принимает архивы, OAuth tokens или пользовательские плейлисты. Рабочее приложение по-прежнему запускается только на literal loopback.

## 1. Требования

- Windows, macOS или Linux с локальным loopback networking.
- Node.js `>=22.13.0` и npm.
- Chrome или Edge для обязательного guided MV3 shell.
- Интернет и обычные бесплатные provider-аккаунты для реальных действий.
- Свободный TCP-порт `3210` на `127.0.0.1`.

Spotify Premium и SoundCloud Artist Pro не нужны и не должны становиться prerequisite. Поэтому бесплатная сборка не выдаёт Spotify/SoundCloud identity за прямой API-доступ: для них основной массовый fallback — один локальный export-файл. Google Cloud project нужен только для опционального официального YouTube API-пути; bulk/guided YouTube workflow работает без него.

## 2. Чистая установка и проверка

Из корня репозитория:

```powershell
node --version
npm ci
npm run check
```

`npm ci` использует зафиксированный `package-lock.json`. `npm run check` последовательно запускает lint, TypeScript, тесты приложения и расширения, воспроизводимую MV3-сборку и production build. Он не должен требовать provider credentials или сетевых вызовов к реальным аккаунтам.

Переменные окружения не обязательны. Если нужно изменить каталог данных, скопируйте шаблон:

```powershell
Copy-Item .env.example .env.local
```

Baseline понимает следующие переменные:

| Переменная | Default | Назначение |
|---|---|---|
| `PLAYLIST_TRANSFER_ORIGIN` | `http://127.0.0.1:3210` | Ожидаемый exact loopback origin. Смена порта требует согласованной пересборки MV3 manifest и scripts; для обычного запуска не меняйте. |
| `PLAYLIST_TRANSFER_DATA_DIR` | `<project>/.data` | Каталог SQLite/WAL. Используйте локальный приватный каталог, не сетевой share и не синхронизируемую облачную папку. |
| `PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API` | `disabled` | Fail-closed gate для собственного YouTube Data API/OAuth. Единственное включающее значение — точная строка `I_ACCEPT_PROVIDER_POLICIES`. |
| `PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID` | пусто | Необязательный Desktop OAuth Client ID, один раз заданный владельцем сборки. Тогда пользователю доступна простая кнопка «Войти через Google» без ручного Client ID. Это публичный идентификатор, не secret. |
| `PLAYLIST_TRANSFER_ENABLE_PROVIDER_OEMBED` | `disabled` | Fail-closed gate для исходящих official oEmbed-запросов всех providers. Единственное включающее значение — точная строка `I_ACCEPT_PROVIDER_POLICIES`. |

Значения `enabled`, `true`, `1`, другая раскладка или пробелы не открывают gates. `I_ACCEPT_PROVIDER_POLICIES` означает только явное подтверждение локального оператора: он сверил актуальные правила, подготовил требуемые disclosure/contact данные и принимает ответственность за свой use case. Приложение не превращает эту строку в доказательство юридического разрешения, завершённого compliance audit или закрытого `SC-BASE-LEGAL`.

В шаблоне нет secret values. Desktop Client ID не является client secret. Если `PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID` задан владельцем сборки, пользователь просто нажимает «Войти через Google»; после подключения Client ID хранится как часть зашифрованного локального connection record. Client secret для Desktop PKCE flow не используется. Для guided/manual или архивного запуска оставьте provider-флаги в `disabled`.

## 3. Запуск

Development:

```powershell
npm run dev
```

Production-like local run:

```powershell
npm run build
npm run start
```

Откройте [http://127.0.0.1:3210](http://127.0.0.1:3210), не `http://localhost:3210`. Проверить listener можно так:

```powershell
$loopbackSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$bootstrap = Invoke-RestMethod http://127.0.0.1:3210/api/session -WebSession $loopbackSession
$headers = @{ "x-playlist-transfer-nonce" = $bootstrap.data.csrf }
Invoke-RestMethod http://127.0.0.1:3210/api/health -WebSession $loopbackSession -Headers $headers
```

Server должен оставаться привязан к literal loopback. Не публикуйте порт через LAN, reverse proxy, tunnel, контейнерный public port mapping или remote development forwarding: эта сборка не является hardened multi-user server.

## 4. Первый локальный профиль

1. Введите display name и локальный пароль длиной минимум 10 символов.
2. Сохраните пароль в своём password manager. Он не отправляется provider-ам и не восстанавливается через email.
3. После перезапуска Node process vault заблокирован: разблокируйте его тем же паролем.
4. Не вводите в приложение пароль Spotify, Google или SoundCloud. Авторизация provider-а выполняется только на его официальной странице.

Локальная HTTP session живёт до четырёх часов в памяти процесса. Чтение локальных данных требует session cookie и короткоживущий nonce; мутации дополнительно требуют same-origin CSRF token. Перезапуск process завершает session и удаляет ключ vault из памяти, но не удаляет SQLite.

## 5. Подключение сервисов

### Spotify — guided baseline

1. Войдите в Spotify на официальном сайте самостоятельно.
2. В приложении выберите Spotify guided connection и подтвердите, что будете работать только со своим или реально доступным для записи плейлистом.
3. Дополнительный архивный вариант: нажмите в приложении ссылку **Запросить Spotify export**, в Account Privacy запросите Account data, скачайте полученный ZIP и загрузите его целиком на странице **Плейлисты**. Поддерживаются также отдельные JSON, CSV/TSV, M3U/M3U8 и TXT. Spotify JSON может содержать `playlists[]`, `items[]`/`tracks[]`, `trackUri`/`track_url`; `spotify:track:…` преобразуется локально. Порядок и повторы сохраняются, до 10 000 треков импортируются одним действием.
4. Укажите один точный `https://open.spotify.com/playlist/...` share URL всего плейлиста и подтвердите ownership/edit control. URL каждого трека вручную вводить не нужно. По умолчанию app проверяет только синтаксис и официальный origin URL. Official oEmbed read-back возможен лишь после точного `PLAYLIST_TRANSFER_ENABLE_PROVIDER_OEMBED=I_ACCEPT_PROVIDER_POLICIES`; даже тогда он не подтверждает ownership или write access.

Baseline не использует Spotify Web API, Web Playback SDK, DOM reading или auto-click. Актуальный Web API Development Mode требует Premium у владельца app и allowlist пользователей, поэтому он не может быть обязательной частью zero-budget baseline. Сохранённый профиль имеет статус `IDENTITY SAVED`, ownership import-а — `USER_ATTESTED_OWNED`, а завершённое ручное добавление — `USER_CONFIRMED_MANUAL`.

### SoundCloud — внешний gate

Технический import принимает точный `https://soundcloud.com/...` permalink; oEmbed по умолчанию выключен и требует отдельного точного acknowledgement-флага. Ни URL, ни oEmbed не дают стабильный URN, duration, состав приватного playlist или право записи. DOM, cookies, localStorage, network responses и внутренние credentials не читаются.

`SC-BASE-LEGAL=UNKNOWN`: текущая сборка останавливает любой transfer с SoundCloud как `BLOCKED_EXTERNAL` до provider mutation. Этот gate нельзя закрыть локальным тестом, пользовательским согласием или `PLAYLIST_TRANSFER_ENABLE_PROVIDER_OEMBED`. Положительный письменный ответ потребует обновления policy registry и новой release-сборки. SoundCloud self-service API credentials требуют Artist Pro и потому не входят в baseline. Техническую библиотеку можно подготовить одним bulk-файлом, но это не закрывает внешний gate.

### YouTube/YouTube Music — guided baseline

Без API пользователь может загрузить целый локальный export-файл либо для нескольких элементов выбрать обычный watch/share URL; приложение локально извлекает 11-символьный `videoId`, открывает официальный destination и просит выполнить `Save`. Ни DOM, ни auto-click, ни undocumented YouTube Music endpoints не используются.

Cross-provider автоматический YouTube search и derived title/artist/duration scoring в release-сборке заблокированы policy gate независимо от `SAFE`/`RISKY`. Для review откройте официальный поиск и вставьте 3–5 разных URL. Если локальный YouTube API-клиент настроен, приложение точечно проверит каждый exact `videoId` через `videos.list` и покажет неизменённые raw metadata с `PROVIDER API · ID CONFIRMED`; duration и `embeddable=true` могут открыть official iframe около 25%. Если read-back недоступен, UI показывает только canonical URL/ID как `URL SYNTAX ONLY · UNVERIFIED`, не подставляет source title и не обещает existence, metadata или 25% playback. Выбор сохраняется как ручное решение без вычисленного cross-provider score.

YouTube Music — только пользовательское название поверхности: приложение изменяет YouTube playlist. Некоторые videoId могут не отображаться в YouTube Music.

### YouTube Data API — опциональный бесплатный accelerator

1. Сверьте актуальные YouTube/Google terms, настройте privacy contact/disclosure для своей установки и только после этого установите `PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API=I_ACCEPT_PROVIDER_POLICIES` в `.env.local`; перезапустите process.
2. Создайте один собственный Google Cloud project.
3. Включите **YouTube Data API v3**.
4. Настройте OAuth consent screen для использования этой сборки.
5. Создайте OAuth Client ID типа **Desktop app**. Client secret приложению не нужен.
6. Один раз задайте `PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID=<id>.apps.googleusercontent.com` в `.env.local` и перезапустите приложение. Пользователь теперь нажимает только **Войти через Google**. Ручное поле Client ID находится в раскрываемом разделе «Для разработчика» и не является обычным пользовательским сценарием.
7. Разрешите redirect на `http://127.0.0.1:3210/api/oauth/youtube/callback`. Flow использует Authorization Code + PKCE и одноразовый state.
8. Проверьте выбранный YouTube channel: Google account может управлять несколькими channel-ами.

После OAuth откройте **Плейлисты**: приложение вызовет owned-library listing, позволит выбрать несколько плейлистов и загрузит все страницы их элементов одной командой. Повторная синхронизация обновляет существующий snapshot, не создавая дубликат. В мастере `APPEND_EXISTING` owned destination также выбирается из этого списка; текущий состав перечитывается API во время preflight. Как независимый запасной путь можно открыть Google Takeout из карточки импорта, экспортировать YouTube/YouTube Music и загрузить полученный ZIP: playlist CSV с `Video ID` разбираются локально.

Read-only flow запрашивает `youtube.readonly`; запись требует `youtube.force-ssl`, потому что Google не предоставляет playlist-only write scope. Приложение использует write scope только для playlist operations. Проект в статусе OAuth Testing может требовать повторной авторизации, а refresh token external test user может истечь примерно через семь дней. При `invalid_grant`, отсутствии refresh token или HTTP 401 connection переводится в `REAUTH_REQUIRED`: API mutation не повторяется вслепую, а пользователь заново проходит полный OAuth либо продолжает guided/manual.

Quota ledger ведёт отдельные локальные buckets: `search` (модельный предел 100 вызовов) и `general` (10 000 units). Период определяется календарной датой `America/Los_Angeles`, то есть сбрасывается по Pacific time с учётом PST/PDT, а не по часовому поясу компьютера. Search, paginated reads, создание playlist и каждый insert оцениваются раздельно; UI/preflight не должен выдавать локальную оценку за гарантию доступной provider quota. Ошибки `YOUTUBE_SEARCH_QUOTA_WAIT`, `YOUTUBE_GENERAL_QUOTA_WAIT` и `YOUTUBE_QUOTA_WAIT` переводят шаг в ожидание Pacific reset или manual watch-URL selection. Запрещены project rotation, scraping и DOM/auto-click. Публичный Client ID может быть встроен владельцем конкретной release-сборки; client secret и удалённый token broker не поставляются.

## 6. Сборка и установка MV3

```powershell
npm run extension:build
npm run test:extension
```

Chrome:

1. Откройте `chrome://extensions`.
2. Включите **Developer mode**.
3. Нажмите **Load unpacked**.
4. Выберите `apps/extension/dist/chromium-guided-unpacked`.

Edge: повторите те же действия в `edge://extensions`.

После пересборки нажмите **Reload** на карточке расширения. Расширение принимает pairing только от exact page `http://127.0.0.1:3210/extension-bridge`, хранит pairing/handoff только в `chrome.storage.session` и требует отдельный user click для staged navigation. Последовательные публичные resource URL после claim накапливаются самим local app в одном origin-wide import draft; private URL туда не записываются. `service-tab` принимается только с публичной страницы профиля и открывает/заполняет **Connections**.

Проверка ZIP в PowerShell:

```powershell
Get-FileHash apps/extension/dist/playlist-transfer-extension-1.0.0-chromium-guided.zip -Algorithm SHA256
Get-Content apps/extension/dist/SHA256SUMS
```

ZIP является детерминированным review/archive artifact. Для бесплатной local edition устанавливайте unpacked directory; ZIP не заменяет подпись browser store.

## 7. Перенос

1. На странице **Плейлисты** массово выберите owned YouTube-плейлисты подключённого аккаунта. Дополнительный вариант — загрузите один официальный ZIP/export-файл Spotify или Google Takeout; SoundCloud data portability archive принимается только если внутри действительно есть поддерживаемые playlist-файлы. Построчный import находится только в раскрываемом аварийном разделе.
2. Выберите destination provider и один из трёх режимов: отдельная копия (`SEPARATE_COPY`), новый объединённый playlist (`MERGE_NEW`) или добавление в существующий (`APPEND_EXISTING`). Для API-подключённого YouTube новые destinations создаются официальным API, а существующий выбирается из аккаунта. Guided destinations по-прежнему требуют отдельного нового пустого плейлиста и fail-closed binding.
3. Настройте `SAFE` или `RISKY` и независимо включите/выключите review uncertain items. Это четыре комбинации внутри одного приложения. В default guided path review `on` создаёт очередь ручного выбора, а review `off` пропускает uncertain items и оставляет их в отчёте; RISKY не обходит policy gate.
4. Проверьте preflight: partial snapshot, provider limits, estimated manual actions и YouTube quota.
5. Для review выбирайте реальный provider URL/ID. Для YouTube обязателен конкретный `videoId`.
6. Выполняйте по одному guided action. Перед каждым Add обновите официальную страницу и сверьте exact destination identity/count с показанным baseline; отвечайте на reconciliation только после фактической проверки результата.
7. В отчёте отдельно сверяйте `VERIFIED_PROVIDER`, `USER_CONFIRMED_MANUAL`, `UNVERIFIED`, errors и limitations.

Не подтверждайте ручной успех «на доверии». Если вкладка закрылась, страница непонятна или результат неоднозначен, выберите unknown/absent и повторно сверяйте destination; приложение не должно слепо делать второй Add.

## 8. Данные, backup и удаление

- SQLite: `.data/playlist-transfer.sqlite` плюс WAL/SHM рядом с ним.
- Provider secrets: AES-256-GCM ciphertext внутри connection record.
- Playlist metadata, journal, decisions и receipts: локальная SQLite; это не обязательно secret ciphertext.
- Extension pairing/handoff/navigation state: только `chrome.storage.session`, очищается browser-ом при restart/reload/disable/update.
- App-side MV3 import draft: только публичные canonical URL в local storage literal loopback origin; удаляется после успешного импорта, кнопкой **Discard draft** или при `Delete account`.

Encrypted backup требует отдельный пароль минимум 10 символов. Внутри backup находятся credentials в открытом JSON, но вся оболочка зашифрована; относитесь к backup как к чувствительному файлу и не теряйте пароль.

`Clear history` удаляет snapshots, transfers, items, decisions, receipts, journal и audit, сохраняя локальный профиль и connections. `Delete account` удаляет также connections, quota, MV3 import draft и профиль и блокирует vault. Удаление fail-closed сначала ожидает подтверждённый `SESSION_CLEAR` от bridge. Если bridge недоступен, операция останавливается: откройте popup расширения, нажмите **Удалить данные расширения**, затем отметьте появившуюся manual-fallback аттестацию и повторите удаление. Если расширение не установлено, manual fallback требует явно подтвердить этот факт. Provider-side revoke при необходимости выполняйте отдельно на странице Google/Spotify/SoundCloud.

Отдельно для API-подключения YouTube disconnect/delete сначала вызывает официальный Google revocation endpoint. Если revoke недоступен, операция останавливается fail-closed: отзовите доступ вручную в [Google Account security permissions](https://security.google.com/settings/security/permissions), затем используйте отдельное подтверждение manual revocation; только после этого локальная копия credentials и связанных YouTube API Data удаляется. Это не удаляет уже созданные provider playlists.

Snapshot rows содержат expiry timestamp (default 24 часа), однако для немедленного гарантированного удаления используйте `Clear history`/`Delete account`, а не полагайтесь только на фоновую очистку.

Локальные disclosure-страницы доступны после запуска по [privacy policy](http://127.0.0.1:3210/privacy.html) и [terms of use](http://127.0.0.1:3210/terms.html). Они описывают self-operated build, но не являются отметкой о пройденном provider/security audit.

## 9. Troubleshooting

| Симптом | Проверка |
|---|---|
| UI открыт на `localhost`, API отвечает `LOOPBACK_ONLY`/`INVALID_HOST` | Перейдите на exact `http://127.0.0.1:3210`. |
| `EADDRINUSE` | Остановите другой процесс на 3210; не меняйте origin только в одном месте. |
| `VAULT_LOCKED` после restart | Это ожидаемо; снова введите локальный пароль. |
| Google `redirect_uri_mismatch` | Используйте Desktop OAuth client и exact loopback callback, не `localhost`. |
| `YOUTUBE_API_POLICY_GATE_CLOSED` | Оставьте manual workflow либо после собственного policy review задайте точное `PLAYLIST_TRANSFER_ENABLE_YOUTUBE_API=I_ACCEPT_PROVIDER_POLICIES` и перезапустите process. |
| Google `invalid_grant` / `YOUTUBE_REAUTH_REQUIRED` | Connection имеет `REAUTH_REQUIRED`; остановите API-шаг и пройдите полный OAuth заново либо выберите manual fallback, без blind retry. |
| YouTube quota exhausted | Смотрите конкретный bucket; ждите следующей календарной даты `America/Los_Angeles` или переходите на manual watch URL/Save. Не ротируйте projects. |
| `YOUTUBE_REVOKE_FAILED_MANUAL_REVOCATION_REQUIRED` | Локальное удаление остановлено. Отзовите grant в Google security settings и затем явно подтвердите manual revocation. |
| oEmbed отключён/недоступен | Это ожидаемый default. Entity остаётся user-selected/unverified; URL syntax не превращается в provider verification. Для разрешённого use case endpoint открывает только точное `PLAYLIST_TRANSFER_ENABLE_PROVIDER_OEMBED=I_ACCEPT_PROVIDER_POLICIES`. |
| Расширение не соединяется | Убедитесь, что app открыт на exact bridge origin, extension перезагружен после build, invite не старше 2 минут. |
| SoundCloud workflow заблокирован | Это ожидаемый fail-closed результат, пока `SC-BASE-LEGAL` не положителен. |

Ручная проверка реальных provider-аккаунтов ведётся отдельно по [`manual-acceptance.md`](manual-acceptance.md). Наличие зелёных unit tests не означает завершённый real-provider acceptance.
