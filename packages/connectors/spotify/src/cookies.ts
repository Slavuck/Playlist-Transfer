const allowedCookieNames = new Set(["sp_dc", "sp_key", "sp_t"]);

export function parseSpotApiCookies(cookieHeader: string): Record<string, string> {
  if (/[\r\n]/u.test(cookieHeader)) throw new Error("SPOTAPI_COOKIE_HEADER_INVALID");
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!allowedCookieNames.has(name) || !value || value.length > 8_192) continue;
    cookies[name] = value;
  }
  if (!cookies.sp_dc) throw new Error("SPOTAPI_SP_DC_REQUIRED");
  return cookies;
}
