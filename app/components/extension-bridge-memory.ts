let pendingFragment = "";

/** Captures extension bootstrap material in module memory and removes it from browser history. */
export function scrubExtensionBridgeFragment(): void {
  if (typeof window === "undefined" || window.location.pathname !== "/extension-bridge") return;
  if (window.location.hash) pendingFragment = window.location.hash;
  if (window.location.hash || window.location.search) history.replaceState(null, "", "/extension-bridge");
}

export function consumeExtensionBridgeFragment(): string {
  scrubExtensionBridgeFragment();
  const value = pendingFragment;
  pendingFragment = "";
  return value;
}
