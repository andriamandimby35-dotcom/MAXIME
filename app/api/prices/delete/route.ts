import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";


export async function POST(req:Request){

try{


const supabase = await createServerClient();
const {
data:{user}
}=await supabase.auth.getUser();


if(!user){

throw new Error(
"Utilisateur non connecté"
);

}

const body = await req.json();


const {
id
}=body;
const {data:member}=await supabase
.from("organization_members")
.select("organization_id")
.eq(
"user_id",
user.id
)
.single();


const organizationId =
member?.organization_id;


if(!organizationId){

throw new Error(
"Organisation introuvable"
);

}


if(!id){

return NextResponse.json(
{
error:"ID manquant"
},
{
status:400
}
);

}


// suppression

const {data,error}=await supabase

.from("price_library")
.delete()
.eq(
"id",
id
)
.eq(
"organization_id",
organizationId
)
.select()
.single();

if(error){
throw error;


}

console.log(
"PRIX SUPPRIME :",
data
);





return NextResponse.json({

success:true

});


}
catch(error:any){


console.log(
"ERREUR SUPPRESSION PRIX:",
error
);


return NextResponse.json(
{
error:error.message
},
{
status:500
}
);


}

}