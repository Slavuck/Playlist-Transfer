# Changelog

Все заметные изменения Playlist-Transfer фиксируются в этом файле.

## [1.0.1] — 2026-07-29

Корректирующий guided-baseline релиз:

- направления с SoundCloud больше не упираются в ложный `BLOCKED_EXTERNAL`: автоматизация остаётся fail-closed, но обязательный `MANUAL_ONLY` путь проходит через official-page actions и отдельную reconciliation;
- исправлена потеря видимости профиля после переименования: пустая новая SQLite безопасно мигрирует legacy-профиль и подключения, а непустая БД никогда не перезаписывается;
- добавлена прямая кнопка создания destination на официальной странице и исправлено ложное обещание YouTube API-создания без активного OAuth;
- browser smoke подтверждает account-first библиотеку, bulk-import, multi-select, SAFE/REVIEW, 3–5 candidates, new-empty binding и atomic guided action;
- документация, capability matrix, публичная страница и release evidence синхронизированы с честным `MANUAL_ONLY` контрактом.

## [1.0.0] — 2026-07-29

Первый бесплатный local-first релиз:

- account-first библиотека YouTube/YouTube Music через официальный OAuth и YouTube Data API;
- массовый локальный импорт Spotify Account Data и Google Takeout из ZIP/JSON/CSV;
- guided/manual маршруты для недоступных или policy-gated provider-действий;
- единые режимы SAFE, RISKY и REVIEW с честными verification statuses;
- encrypted local vault, SQLite journal, backup/restore и удаление данных;
- MV3 guided connector без content scripts, host permissions, DOM reading и auto-click;
- воспроизводимые тесты, production build, extension ZIP и SHA-256 manifest;
- отдельная статическая Vercel-страница, которая не принимает пользовательские данные.

[1.0.0]: https://github.com/Slavuck/Playlist-Transfer/releases/tag/v1.0.0
[1.0.1]: https://github.com/Slavuck/Playlist-Transfer/releases/tag/v1.0.1
