import { NextResponse } from "next/server";
import { searchExistingPrice } from "@/lib/price-engine/search-price";

export async function POST(req: Request) {
  const body = await req.json();

  const result = await searchExistingPrice({
    designation: body.designation,
    unite: body.unite,
    region: body.region,
    organizationId: body.organizationId,
  });

  return NextResponse.json({
    success: true,
    result,
  });
}
