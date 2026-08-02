# Vercel hosted deployment

Hosted-профиль собирает полноценное Next.js приложение, а не прежнюю статическую папку `website`.

## Переменные окружения

Задайте в Vercel для Production, Preview и Development по необходимости:

- `PLAYLIST_TRANSFER_HOSTED=1`;
- `PLAYLIST_TRANSFER_PUBLIC_ORIGIN=https://playlist-transfer-ashen.vercel.app` для production;
- `PLAYLIST_TRANSFER_HOSTED_SECRET` — случайный секрет не короче 24 символов;
- `PLAYLIST_TRANSFER_SPOTIFY_CLIENT_ID` — публичный Client ID Spotify app;
- `PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID` — Client ID Google OAuth web client;
- `PLAYLIST_TRANSFER_YOUTUBE_CLIENT_SECRET` — secret Google web client, если он выдан.

Секреты нельзя добавлять в Git, Vercel build output, browser JavaScript или логи.

## OAuth callback allowlist

Production redirect URI должны точно совпадать:

- Spotify: `https://playlist-transfer-ashen.vercel.app/api/hosted/oauth/spotify/callback`;
- Google: `https://playlist-transfer-ashen.vercel.app/api/hosted/oauth/youtube/callback`.

Для preview используйте отдельный стабильный alias и добавьте его callback URI в обе консоли. Spotify требует HTTPS для любого redirect URI, кроме literal loopback разработки.

## Модель данных и безопасность

- Authorization Code + PKCE и одноразовый `state` для обоих провайдеров.
- Access/refresh tokens зашифрованы AES-256-GCM в `Secure; HttpOnly; SameSite=Lax` cookie.
- Write API принимает только same-origin JSON POST.
- Provider credentials никогда не возвращаются client-side.
- Playlist snapshots, candidates и report не записываются в hosted database.
- YouTube disconnect вызывает Google revocation; Spotify disconnect очищает grant-cookie.
- Перед записью exact target ID повторно валидируются, после записи playlist перечитывается.

## Ограничения провайдеров

- Один hosted transfer ограничен 100 доступными треками, чтобы ограничить payload, время Function и YouTube quota.
- YouTube search и insert расходуют quota; проекты нельзя ротировать для обхода лимита.
- В Spotify → YouTube пользователь обязан вручную выбрать и подтвердить видео.
- Spotify development mode допускает только allowlisted users в пределах лимита app. Для общего публичного сервиса нужен Extended Quota Spotify.
- SoundCloud automation не входит в hosted release.

## Release gate

```powershell
npm ci
npm run check
vercel build --prod
vercel deploy --prebuilt
```

После preview smoke-test проверьте production:

1. `/api/hosted/status` отвечает `200` и не раскрывает токены.
2. Оба OAuth callback возвращают на `/` и показывают аккаунт.
3. `Codex` YouTube → новый Spotify playlist завершается `verified=true`.
4. `Codex` Spotify → новый YouTube playlist проходит явный review и завершается `verified=true`.
5. После disconnect соответствующая cookie удалена, а YouTube grant отозван.
