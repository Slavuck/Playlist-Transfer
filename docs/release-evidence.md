# Release evidence — v1.0.1 guided local baseline

Дата проверки: **2026-07-29**  
Профиль: бесплатная local-first сборка, без hosted/SaaS и обязательных платных компонентов.  
Среда финального прогона: Windows `10.0.26200.0`, Node.js `v26.1.0`, npm `11.13.0`.

## Автоматический release gate

Из корня проекта выполнено:

```powershell
npm.cmd run check
```

Результат:

- ESLint — PASS, без warnings/errors;
- TypeScript `tsc --noEmit` — PASS;
- core/integration/e2e/security tests — **253/253 PASS**;
- MV3 tests — **24/24 PASS**;
- воспроизводимая MV3 unpacked/ZIP сборка — PASS;
- production `next build --webpack` — PASS.

Матрица coordinator покрывает шесть направлений × три destination modes × SAFE/RISKY × review on/off: **72/72 PASS**. Четыре SoundCloud-направления проходят только как `MANUAL_ONLY`: `forceGuided=true`, API/DOM mutation выключена, action cards являются user-operated, а положительная reconciliation создаёт только `USER_CONFIRMED_MANUAL`.

Три storage-теста подтверждают одноразовую миграцию legacy-branded SQLite: существующий encrypted profile/connections переносятся в `playlist-transfer.sqlite`, пустая каноническая БД вместе с WAL/SHM архивируется, исходник сохраняется, а непустая каноническая БД никогда не перезаписывается.

## Воспроизводимость MV3

`npm.cmd run extension:build` выполнен повторно после полного gate. Оба запуска дали один и тот же SHA-256 архива:

```text
f22256870943b327762e234970fa4e5cf7bb2d14c15f9bbc1d6296b0c21b3419
```

Артефакты:

- `apps/extension/dist/chromium-guided-unpacked/`;
- `apps/extension/dist/playlist-transfer-extension-1.0.1-chromium-guided.zip`;
- `apps/extension/dist/SHA256SUMS`.

ZIP — детерминированный local review/archive artifact. Он не является store-signed пакетом и не доказывает прохождение Chrome Web Store или Edge Add-ons review.

## Production runtime smoke

Production server запущен командой `npm.cmd run start` на literal origin `http://127.0.0.1:3210` с отдельным временным data directory. Проверено:

- `GET /` → HTTP `200`;
- session bootstrap вернул exact origin `http://127.0.0.1:3210`;
- защищённый `GET /api/health` с session cookie/nonce → `status=healthy`, `storage=sqlite`, `hostedDependencies=false`, `loopbackOnly=true`; тот же запрос без nonce → HTTP `403`;
- локальный профиль создан через CSRF-protected API и независимо прочитан обратно: `exists=true`, `unlocked=true`, language `en`.
- production response содержит CSP, `Referrer-Policy: no-referrer` и `Permissions-Policy`.

После smoke server остановлен, а проверенный exact временный каталог `.release-smoke-data-v101` удалён. Реальные provider credentials в smoke не использовались.

## In-app browser smoke

В браузере на literal `http://127.0.0.1:3210` с synthetic data пройден пользовательский сценарий:

- создание локального профиля без provider password;
- сохранение Spotify/SoundCloud identity с явной маркировкой `IDENTITY ONLY · NO LIBRARY ACCESS`;
- отображение account-first страницы «Ваши плейлисты», bulk fallback и локальной библиотеки с одним 3-item snapshot;
- multi-select источника, Spotify → SoundCloud, `SEPARATE_COPY`, `SAFE` + `REVIEW`;
- 3–5 official-origin URL candidates, каждый с `URL SYNTAX ONLY · UNVERIFIED` и `NO DERIVED SCORE`;
- новый пустой destination, прямая кнопка официальной страницы, count `0`, ownership/edit attestation;
- одна atomic guided action card с freshness gate и точным public permalink; action link не открывался автоматически;
- UI явно показывает `MANUAL ONLY`, `USER OPERATED` и обещает только `USER_CONFIRMED_MANUAL`.

OS file chooser недоступен управляющей поверхности браузера, поэтому именно клик/выбор файла в нативном диалоге не автоматизировался. ZIP/JSON/CSV parsing и bulk extraction проверены отдельными importer tests; snapshot для UI smoke был записан тем же CSRF-protected local API с synthetic provider URLs. Это не считается real-provider acceptance.

## Что не считается выполненной проверкой

- `SC-BASE-LEGAL` остаётся `UNKNOWN`; приложение блокирует SoundCloud automation, но сохраняет обязательный `MANUAL_ONLY` user-operated path без API/DOM mutation.
- Реальные transfer runs во всех шести направлениях, real-provider quota/region behavior и strict competitive playback не заявлены проверенными.
- Ручная acceptance в Chrome/Edge с реальными provider accounts, screen reader, 200% zoom/narrow viewport и browser-store privacy review имеет статус **NOT EXECUTED** в `docs/manual-acceptance.md`; semantic browser smoke выше не заменяет её.
- Exact acknowledgement flags открывают только optional local operator path и не являются доказательством provider compliance approval.

Эти внешние/manual gates намеренно не смешиваются с зелёным автоматическим release gate и не повышаются до `VERIFIED_PROVIDER`.
