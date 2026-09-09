export const SESSION_COOKIE = "cub_sid";
export type Referrer = "direct" | "share_link" | "campaign";
export function referrerFrom(params: URLSearchParams): Referrer {
  if (params.has("ref")) return "share_link";
  if (params.has("utm_source")) return "campaign";
  return "direct";
}
