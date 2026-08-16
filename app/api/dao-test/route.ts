import { NextResponse } from "next/server";
import { getDaoTemplate } from "@/lib/dao/get-dao-template";


export async function GET(){

const template = await getDaoTemplate();


return NextResponse.json({
success:true,
template
});

}