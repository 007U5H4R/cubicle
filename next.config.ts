import type { NextConfig } from "next";

// SEC-001 — security response headers, applied to every route via `headers()`. `connect-src` widens
// to the Supabase project origin when NEXT_PUBLIC_SUPABASE_URL is set to a real URL (client-side
// Supabase calls are same-origin-adjacent, not proxied) — falls back to no extra origin (just
// `'self'`) if it's unset/unparseable, e.g. the offline `.env.local` placeholder or a build without
// env loaded yet. Gemini (`@google/genai`) is called only from server code (`lib/gateway/transport.ts`),
// never from the browser, so it needs no `connect-src` entry.
function supabaseOrigin(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildCsp(): string {
  const connectSrc = ["'self'", supabaseOrigin()].filter((v): v is string => Boolean(v)).join(" ");
  return [
    "default-src 'self'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Report-Only (can't break users). `pnpm dev` + claude-in-chrome browser-verification against
  // `/`, `/dev/office`, `/dev/tokens` never produced a single CSP console violation (Report-Only and
  // briefly enforcing both) — the policy itself looks safe — but the dev session also hit a
  // pre-existing, CSP-unrelated Next 16.3.4/Turbopack dev-mode hydration bug (InvariantError in
  // `createDebugChannel`, reproduced identically with zero custom headers) that intermittently broke
  // client interactivity on /dev/office, so a clean end-to-end "loads + steps the fixture" pass
  // could not be completed with confidence in this session. Ship Report-Only per the hard
  // constraint; flip to enforcing once re-verified end-to-end (see review-fixes-report.md).
  { key: "Content-Security-Policy-Report-Only", value: buildCsp() },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
