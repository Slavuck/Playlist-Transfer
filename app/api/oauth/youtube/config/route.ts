import { apiError, apiOk } from "../../../_shared";
import { isYoutubeApiReleaseEnabled } from "../../../../../packages/connectors-core/src/policy";
import { requireLocalRead } from "../../../../../packages/security/src/loopback-session";

const clientIdPattern = /\.apps\.googleusercontent\.com$/u;

export function GET(request: Request) {
  try {
    requireLocalRead(request);
    const configuredClientId = process.env.PLAYLIST_TRANSFER_YOUTUBE_CLIENT_ID?.trim() ?? "";
    return apiOk({
      maintainerClientConfigured: clientIdPattern.test(configuredClientId),
      policyGateEnabled: isYoutubeApiReleaseEnabled(),
    });
  } catch (error) {
    return apiError(error);
  }
}
