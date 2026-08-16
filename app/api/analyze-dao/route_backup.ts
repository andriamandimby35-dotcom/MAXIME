import { NextResponse } from "next/server";


export async function POST(req: Request) {

  try {

    const body = await req.json();


    console.log(
      "TEST API ANALYZE DAO",
      body
    );


    return NextResponse.json({

      success:true,

      message:"API analyse DAO fonctionne"

    });


  } catch(error:any){


    return NextResponse.json({

      error:error.message

    },

    {

      status:500

    });


  }

}