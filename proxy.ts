import { NextResponse, type NextRequest } from "next/server";
import { preferredLocale } from "./lib/locale-routing";

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-atlas-locale", preferredLocale(request.nextUrl.pathname,
    request.cookies.get("atlas-locale")?.value, request.headers.get("accept-language") ?? ""));
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/", "/en", "/zh"] };
