"""Small JSON-RPC bridge between Playlist Transfer and the locally installed SpotAPI.

The bridge intentionally accepts secrets through stdin and emits only canonical,
minimal records.  Spotify cookies never appear in argv, stdout, or tracebacks.
"""

from __future__ import annotations

import importlib.metadata
import json
import re
import sys
import time
from typing import Any, Mapping
from urllib.parse import quote


SENTINEL = "PLAYLIST_TRANSFER_SPOTAPI="
SPOTIFY_ID = re.compile(r"^[A-Za-z0-9]{22}$")
PLAYLIST_URI = re.compile(
    r"spotify:(?:user:[^:\s]+:)?playlist:([A-Za-z0-9]{22})"
)


class BridgeFailure(Exception):
    def __init__(self, code: str, *, mutation_may_have_started: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.mutation_may_have_started = mutation_may_have_started


def require_mapping(value: Any, code: str = "SPOTAPI_INVALID_RESPONSE") -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise BridgeFailure(code)
    return value


def nested(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def string_value(value: Any, fallback: str = "") -> str:
    return value.strip() if isinstance(value, str) else fallback


def id_from_uri(value: Any, kind: str) -> str:
    text = string_value(value)
    match = re.search(rf"spotify:{kind}:([A-Za-z0-9]{{22}})", text)
    if match:
        return match.group(1)
    if SPOTIFY_ID.fullmatch(text):
        return text
    return ""


def artist_names(data: Mapping[str, Any]) -> list[str]:
    result: list[str] = []
    containers = [data.get("artists"), data.get("firstArtist"), data.get("otherArtists")]
    for container in containers:
        items = nested(container, "items")
        if not isinstance(items, list):
            continue
        for item in items:
            name = string_value(nested(item, "profile", "name"))
            if not name:
                name = string_value(nested(item, "data", "profile", "name"))
            if name and name not in result:
                result.append(name)
    return result


def canonical_track(data: Any, position: int = 0) -> dict[str, Any] | None:
    if not isinstance(data, Mapping):
        return None
    track_id = id_from_uri(data.get("uri"), "track") or string_value(data.get("id"))
    if not SPOTIFY_ID.fullmatch(track_id):
        return None
    duration = nested(data, "duration", "totalMilliseconds")
    if not isinstance(duration, (int, float)):
        duration = nested(data, "trackDuration", "totalMilliseconds")
    playable = nested(data, "playability", "playable")
    return {
        "trackId": track_id,
        "title": string_value(data.get("name"), track_id),
        "artist": ", ".join(artist_names(data)),
        "durationMs": int(duration) if isinstance(duration, (int, float)) else None,
        "position": position,
        "availability": "UNAVAILABLE" if playable is False else "AVAILABLE",
        "url": f"https://open.spotify.com/track/{track_id}",
    }


def playlist_attribute(playlist: Mapping[str, Any], name: str) -> str:
    attributes = playlist.get("attributes")
    if not isinstance(attributes, list):
        return ""
    for attribute in attributes:
        if isinstance(attribute, Mapping) and attribute.get("key") == name:
            return string_value(attribute.get("value"))
    return ""


def canonical_playlist(playlist: Any) -> dict[str, Any]:
    data = require_mapping(playlist)
    playlist_id = id_from_uri(data.get("uri"), "playlist")
    if not playlist_id:
        raise BridgeFailure("SPOTAPI_PLAYLIST_NOT_FOUND")
    owner = require_mapping(nested(data, "ownerV2", "data") or {})
    owner_id = string_value(owner.get("username")) or id_from_uri(owner.get("uri"), "user")
    owner_label = string_value(owner.get("name"), owner_id)
    capabilities = require_mapping(data.get("currentUserCapabilities") or {})
    status = playlist_attribute(data, "status")
    item_count = nested(data, "content", "totalCount")
    return {
        "id": playlist_id,
        "title": string_value(data.get("name"), "Untitled"),
        "description": string_value(data.get("description")),
        "itemCount": int(item_count) if isinstance(item_count, (int, float)) else 0,
        "privacyStatus": "public" if status == "PUBLISHED" else "private",
        "ownerId": owner_id,
        "ownerLabel": owner_label,
        "snapshotId": string_value(data.get("revisionId")) or None,
        "url": f"https://open.spotify.com/playlist/{playlist_id}",
        "ownership": "API_OWNED",
        "canEdit": capabilities.get("canEditItems") is True,
    }


def collect_playlist_ids(value: Any, found: list[str]) -> None:
    if isinstance(value, str):
        for match in PLAYLIST_URI.finditer(value):
            playlist_id = match.group(1)
            if playlist_id not in found:
                found.append(playlist_id)
        return
    if isinstance(value, Mapping):
        for child in value.values():
            collect_playlist_ids(child, found)
        return
    if isinstance(value, list):
        for child in value:
            collect_playlist_ids(child, found)


def load_spotapi() -> Any:
    try:
        import spotapi  # type: ignore
    except ModuleNotFoundError as error:
        if error.name == "spotapi":
            raise BridgeFailure("SPOTAPI_NOT_INSTALLED") from None
        raise BridgeFailure("SPOTAPI_DEPENDENCY_MISSING") from None
    except ImportError:
        raise BridgeFailure("SPOTAPI_IMPORT_FAILED") from None
    return spotapi


def login_context(request: Mapping[str, Any]) -> tuple[Any, Any, Mapping[str, Any]]:
    spotapi = load_spotapi()
    credentials = require_mapping(request.get("credentials"), "SPOTAPI_CREDENTIALS_REQUIRED")
    cookies = require_mapping(credentials.get("cookies"), "SPOTAPI_COOKIES_REQUIRED")
    if "sp_dc" not in cookies:
        raise BridgeFailure("SPOTAPI_SP_DC_REQUIRED")
    identifier = string_value(credentials.get("identifier"), "playlist-transfer-local")
    config = spotapi.Config(logger=spotapi.NoopLogger())
    login = spotapi.Login.from_cookies(
        {"identifier": identifier, "password": "", "cookies": dict(cookies)}, config
    )
    try:
        profile_payload = spotapi.User(login).get_user_info()
    except Exception as error:
        message = str(error).lower()
        if "401" in message or "unauthorized" in message or "forbidden" in message:
            raise BridgeFailure("SPOTAPI_SESSION_EXPIRED") from None
        raise
    profile = require_mapping(nested(profile_payload, "profile") or {})
    username = string_value(profile.get("username"))
    if not username:
        raise BridgeFailure("SPOTAPI_ACCOUNT_ID_REQUIRED")
    return spotapi, login, profile


def account_result(profile: Mapping[str, Any]) -> dict[str, Any]:
    username = string_value(profile.get("username"))
    display_name = (
        string_value(profile.get("displayName"))
        or string_value(profile.get("name"))
        or username
    )
    return {
        "accountId": username,
        "userId": username,
        "displayName": display_name,
        "profileUrl": f"https://open.spotify.com/user/{quote(username, safe='')}",
    }


def fetch_playlist(spotapi: Any, login: Any, playlist_id: str, *, include_tracks: bool) -> dict[str, Any]:
    if not SPOTIFY_ID.fullmatch(playlist_id):
        raise BridgeFailure("SPOTAPI_PLAYLIST_ID_REQUIRED")
    client = spotapi.PublicPlaylist(playlist_id, client=login.client, language="en")
    first = require_mapping(client.get_playlist_info(limit=343, offset=0))
    playlist = require_mapping(nested(first, "data", "playlistV2"))
    canonical = canonical_playlist(playlist)
    if not include_tracks:
        return {"playlist": canonical, "tracks": [], "sourceVersion": canonical.get("snapshotId")}
    content = require_mapping(playlist.get("content") or {})
    total = content.get("totalCount")
    total_count = int(total) if isinstance(total, (int, float)) else 0
    tracks: list[dict[str, Any]] = []

    def append_items(page: Mapping[str, Any]) -> None:
        items = page.get("items")
        if not isinstance(items, list):
            return
        for item in items:
            track = canonical_track(nested(item, "itemV2", "data"), len(tracks))
            if track is not None:
                tracks.append(track)

    append_items(content)
    offset = 343
    while offset < total_count:
        page_response = require_mapping(client.get_playlist_info(limit=343, offset=offset))
        page = require_mapping(nested(page_response, "data", "playlistV2", "content"))
        append_items(page)
        offset += 343
    return {
        "playlist": canonical,
        "tracks": tracks,
        "sourceVersion": canonical.get("snapshotId") or f"{playlist_id}:{len(tracks)}",
    }


def assert_owned_editable(snapshot: Mapping[str, Any], username: str) -> None:
    playlist = require_mapping(snapshot.get("playlist"))
    if playlist.get("ownerId") != username or playlist.get("canEdit") is not True:
        raise BridgeFailure("SPOTAPI_PLAYLIST_NOT_OWNED")


def operation_result(request: Mapping[str, Any]) -> Any:
    operation = string_value(request.get("operation"))
    if operation == "status":
        load_spotapi()
        return {
            "installed": True,
            "package": "spotapi",
            "version": importlib.metadata.version("spotapi"),
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        }

    spotapi, login, profile = login_context(request)
    username = string_value(profile.get("username"))
    if operation == "account":
        return account_result(profile)
    if operation == "playlists":
        raw_library = spotapi.PrivatePlaylist(login, language="en").get_library(500)
        playlist_ids: list[str] = []
        collect_playlist_ids(raw_library, playlist_ids)
        playlists: list[dict[str, Any]] = []
        for playlist_id in playlist_ids[:250]:
            try:
                snapshot = fetch_playlist(spotapi, login, playlist_id, include_tracks=False)
                playlist = require_mapping(snapshot.get("playlist"))
                if playlist.get("ownerId") == username and playlist.get("canEdit") is True:
                    playlists.append(dict(playlist))
            except Exception:
                continue
        playlists.sort(key=lambda item: string_value(item.get("title")).casefold())
        return {"playlists": playlists}
    if operation in {"playlist_snapshot", "verify_playlist"}:
        playlist_id = string_value(request.get("playlistId"))
        snapshot = fetch_playlist(spotapi, login, playlist_id, include_tracks=True)
        assert_owned_editable(snapshot, username)
        return snapshot
    if operation == "search_tracks":
        query = string_value(request.get("query"))
        if not query or len(query) > 500:
            raise BridgeFailure("SPOTAPI_SEARCH_QUERY_REQUIRED")
        limit_value = request.get("limit")
        limit = max(1, min(10, int(limit_value) if isinstance(limit_value, (int, float)) else 10))
        raw = spotapi.Song(client=login.client, language="en").query_songs(query, limit=limit)
        items = nested(raw, "data", "searchV2", "tracksV2", "items")
        tracks: list[dict[str, Any]] = []
        if isinstance(items, list):
            for item in items:
                track = canonical_track(nested(item, "item", "data"), len(tracks))
                if track is not None:
                    tracks.append(track)
        return {"tracks": tracks}
    if operation == "track":
        track_id = string_value(request.get("trackId"))
        if not SPOTIFY_ID.fullmatch(track_id):
            raise BridgeFailure("SPOTAPI_TRACK_ID_REQUIRED")
        raw = spotapi.Song(client=login.client, language="en").get_track_info(track_id)
        track = canonical_track(nested(raw, "data", "trackUnion"), 0)
        if track is None:
            raise BridgeFailure("SPOTAPI_TRACK_NOT_FOUND")
        return {"track": track}
    if operation == "create_playlist":
        title = string_value(request.get("title"))
        if not title or len(title) > 100:
            raise BridgeFailure("SPOTAPI_PLAYLIST_TITLE_REQUIRED")
        uri = spotapi.PrivatePlaylist(login, language="en").create_playlist(title)
        playlist_id = id_from_uri(uri, "playlist")
        if not playlist_id:
            raise BridgeFailure("SPOTAPI_CREATE_UNVERIFIED", mutation_may_have_started=True)
        return {"id": playlist_id, "url": f"https://open.spotify.com/playlist/{playlist_id}"}
    if operation == "append_track":
        playlist_id = string_value(request.get("playlistId"))
        track_id = string_value(request.get("trackId"))
        if not SPOTIFY_ID.fullmatch(playlist_id):
            raise BridgeFailure("SPOTAPI_PLAYLIST_ID_REQUIRED")
        if not SPOTIFY_ID.fullmatch(track_id):
            raise BridgeFailure("SPOTAPI_TRACK_ID_REQUIRED")
        snapshot = fetch_playlist(spotapi, login, playlist_id, include_tracks=False)
        assert_owned_editable(snapshot, username)
        private_playlist = spotapi.PrivatePlaylist(login, playlist_id, language="en")
        try:
            spotapi.Song(private_playlist, language="en").add_songs_to_playlist([track_id])
        except Exception:
            raise BridgeFailure("SPOTAPI_WRITE_FAILED", mutation_may_have_started=True) from None
        return {"snapshotId": f"spotapi:{time.time_ns()}"}
    raise BridgeFailure("SPOTAPI_OPERATION_NOT_SUPPORTED")


def safe_error(error: Exception) -> BridgeFailure:
    if isinstance(error, BridgeFailure):
        return error
    message = str(error).lower()
    if "401" in message or "unauthorized" in message:
        return BridgeFailure("SPOTAPI_SESSION_EXPIRED")
    if "429" in message or "rate limit" in message:
        return BridgeFailure("SPOTAPI_RATE_LIMITED")
    if "not found" in message or "404" in message:
        return BridgeFailure("SPOTAPI_NOT_FOUND")
    return BridgeFailure("SPOTAPI_REQUEST_FAILED")


def emit(payload: Mapping[str, Any]) -> None:
    print(SENTINEL + json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def main() -> None:
    try:
        raw = sys.stdin.read(1_000_001)
        if len(raw) > 1_000_000:
            raise BridgeFailure("SPOTAPI_REQUEST_TOO_LARGE")
        request = require_mapping(json.loads(raw), "SPOTAPI_INVALID_REQUEST")
        emit({"ok": True, "data": operation_result(request)})
    except Exception as error:
        failure = safe_error(error)
        emit(
            {
                "ok": False,
                "error": failure.code,
                "mutationMayHaveStarted": failure.mutation_may_have_started,
            }
        )


if __name__ == "__main__":
    main()
