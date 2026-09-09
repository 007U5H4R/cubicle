import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, referrerFrom } from "@/lib/session";
export function proxy(req: NextRequest) {
  const existing = req.cookies.get(SESSION_COOKIE)?.value;
  const headers = new Headers(req.headers);
  const id = existing ?? crypto.randomUUID();
  headers.set("x-cub-sid", id);
  headers.set("x-cub-new", existing ? "0" : "1");
  headers.set("x-cub-referrer", referrerFrom(req.nextUrl.searchParams));
  const res = NextResponse.next({ request: { headers } });
  if (!existing) res.cookies.set(SESSION_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return res;
}
export const config = { matcher: ["/((?!_next|favicon.ico|og-cover.png).*)"] };
