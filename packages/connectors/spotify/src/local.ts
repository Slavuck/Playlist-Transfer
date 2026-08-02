import { isSpotifyApiReleaseEnabled } from "../../../connectors-core/src/policy";
import { getLocalDatabase } from "../../../storage-local/src/database";
import { getLocalVault } from "../../../storage-local/src/vault";
import { SpotifyApiClient, type SpotifyCredentials } from "./client";

export function loadLocalSpotifyClient(): SpotifyApiClient {
  if (typeof window !== "undefined") throw new Error("SPOTIFY_CLIENT_SERVER_ONLY");
  if (!isSpotifyApiReleaseEnabled()) throw new Error("SPOTAPI_POLICY_GATE_CLOSED");
  const database = getLocalDatabase();
  const vault = getLocalVault();
  if (!vault.isUnlocked) throw new Error("VAULT_LOCKED");
  const connection = database.getConnection("spotify");
  if (!connection || connection.strategy !== "api" || !connection.encryptedSecret) throw new Error("SPOTAPI_NOT_CONNECTED");
  if (connection.status === "REAUTH_REQUIRED") throw new Error("SPOTAPI_SESSION_EXPIRED");
  const credentials = vault.openJson<SpotifyCredentials>(connection.encryptedSecret, "connection:spotify");
  return new SpotifyApiClient(credentials, {
    onReauthRequired: () => database.saveConnection({ ...connection, status: "REAUTH_REQUIRED" }),
  });
}
