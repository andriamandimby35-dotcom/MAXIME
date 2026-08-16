import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";


export function proxy(request: NextRequest) {

  const url = request.nextUrl.pathname;


  // Laisser les pages publiques accessibles
  if (
    url.startsWith("/login") ||
    url.startsWith("/api") ||
    url.startsWith("/_next")
  ) {
    return NextResponse.next();
  }


  return NextResponse.next();
}


export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};