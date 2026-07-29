# Changelog

Все заметные изменения Playlist-Transfer фиксируются в этом файле.

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
