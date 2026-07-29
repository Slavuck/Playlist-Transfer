# Release evidence — guided local baseline

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
- core/integration/e2e/security tests — **240/240 PASS**;
- MV3 tests — **24/24 PASS**;
- воспроизводимая MV3 unpacked/ZIP сборка — PASS;
- production `next build --webpack` — PASS.

Матрица coordinator покрывает шесть направлений × три destination modes × SAFE/RISKY × review on/off. SoundCloud-ряды проверяют именно fail-closed `BLOCKED_EXTERNAL`, а не заявляют реальный provider transfer.

## Воспроизводимость MV3

`npm.cmd run extension:build` выполнен повторно после полного gate. Оба запуска дали один и тот же SHA-256 архива:

```text
2db3fa327b7345328bdf604bc6284dc065d2a3dd8ff3002ddf0feb02defbb619
```

Артефакты:

- `apps/extension/dist/chromium-guided-unpacked/`;
- `apps/extension/dist/playlist-transfer-extension-1.0.0-chromium-guided.zip`;
- `apps/extension/dist/SHA256SUMS`.

ZIP — детерминированный local review/archive artifact. Он не является store-signed пакетом и не доказывает прохождение Chrome Web Store или Edge Add-ons review.

## Production runtime smoke

Production server запущен командой `npm.cmd run start` на literal origin `http://127.0.0.1:3210` с отдельным временным data directory. Проверено:

- `GET /` → HTTP `200`;
- session bootstrap вернул exact origin `http://127.0.0.1:3210`;
- защищённый `GET /api/health` с session cookie/nonce → `healthy`, `storage=sqlite`, `hostedDependencies=false`, `loopbackOnly=true`;
- локальный профиль создан через CSRF-protected API и независимо прочитан обратно: `exists=true`, `unlocked=true`, language `en`.

После smoke server остановлен, а проверенный exact временный каталог `.release-smoke-data` удалён. Реальные provider credentials в smoke не использовались.

## Что не считается выполненной проверкой

- `SC-BASE-LEGAL` остаётся `UNKNOWN`; runtime блокирует любое направление с SoundCloud до provider mutation.
- Реальные transfer runs во всех шести направлениях, real-provider quota/region behavior и strict competitive playback не заявлены проверенными.
- Ручная acceptance в Chrome/Edge, keyboard/screen-reader/a11y и browser-store privacy review имеют статус **NOT EXECUTED** в `docs/manual-acceptance.md`.
- In-app automated browser smoke был начат, но после выявления и исправления loopback Host-normalization issue браузерный harness запретил дальнейшую local URL navigation своей URL policy. Это ограничение harness, а не положительный UI verdict; UI smoke поэтому не помечен как PASS.
- Exact acknowledgement flags открывают только optional local operator path и не являются доказательством provider compliance approval.

Эти внешние/manual gates намеренно не смешиваются с зелёным автоматическим release gate и не повышаются до `VERIFIED_PROVIDER`.
