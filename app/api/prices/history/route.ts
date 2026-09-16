import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";


export async function GET(req: Request) {

try {

const supabase = await createServerClient();


// utilisateur connecté

const {
data:{user}
}=await supabase.auth.getUser();


if(!user){

throw new Error("Utilisateur non connecté");

}


// récupérer organisation

const {data:member,error:memberError}=await supabase
.from("organization_members")
.select("organization_id")
.eq("user_id",user.id)
.single();


if(memberError){

throw memberError;

}


const organizationId = member.organization_id;



// paramètres filtres

const {searchParams}=new URL(req.url);


const categorie =
searchParams.get("categorie");


const periode =
searchParams.get("periode");


const priceId =
searchParams.get("priceId");



// requête historique

let query = supabase
.from("price_history")
.select(`
*,
price_library!price_history_price_id_fkey(
designation,
categorie,
unite
)
`)
.eq(
"organization_id",
organizationId
)
.order(
"date_modification",
{
ascending:false
}
);



// filtre matériau précis

if(priceId){

query=query.eq(
"price_id",
priceId
);

}



// filtre catégorie

if(categorie && categorie !== "tous"){

query=query.eq(
"price_library.categorie",
categorie
);

}



// filtre période

if(periode){

const date=new Date();

if(periode==="7"){

date.setDate(
date.getDate()-7
);

}

if(periode==="30"){

date.setDate(
date.getDate()-30
);

}


query=query.gte(
"date_modification",
date.toISOString()
);

}



const {data,error}=await query;



if(error){

throw error;

}



return NextResponse.json({

success:true,

data

});


}
catch(error:any){

console.log(
"ERREUR HISTORIQUE PRIX:",
error
);


return NextResponse.json({

error:error.message

},
{
status:500
});


}

}