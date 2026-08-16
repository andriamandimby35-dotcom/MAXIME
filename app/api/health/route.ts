import { NextResponse } from "next/server";
export function GET() {
  return NextResponse.json({ status: "ok", service: "sebastien-btp", timestamp: new Date().toISOString() });
}
