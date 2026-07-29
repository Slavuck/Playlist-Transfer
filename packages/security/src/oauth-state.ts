export type YoutubeOAuthState = {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  policyVersion: string;
  policyAcceptedAtMs: number;
  expiresAtMs: number;
};

declare global {
  var __playlistTransferYoutubeOAuthStates: Map<string, YoutubeOAuthState> | undefined;
}

const states = globalThis.__playlistTransferYoutubeOAuthStates ?? new Map<string, YoutubeOAuthState>();
globalThis.__playlistTransferYoutubeOAuthStates = states;

export function storeYoutubeOAuthState(state: YoutubeOAuthState) {
  cleanupYoutubeOAuthStates();
  states.set(state.state, state);
}

export function claimYoutubeOAuthState(value: string): YoutubeOAuthState | undefined {
  cleanupYoutubeOAuthStates();
  const state = states.get(value);
  if (state) states.delete(value);
  return state;
}

export function cleanupYoutubeOAuthStates(now = Date.now()) {
  for (const [key, state] of states) if (state.expiresAtMs < now) states.delete(key);
}
