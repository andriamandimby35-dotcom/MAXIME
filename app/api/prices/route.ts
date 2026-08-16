import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";


export async function POST(req: Request){

try{


const supabase = await createServerClient();


const body = await req.json();


const {
id,
designation,
categorie,
unite,
prix
}=body;



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


// récupérer ancien prix

const {data:oldPrice,error:oldError}=await supabase
.from("price_library")
.select("prix_actuel")
.eq(
"id",
id
)
.single();


if(oldError){

throw oldError;

}



// calcul historique

const difference =
Number(prix) - Number(oldPrice.prix_actuel);



const pourcentage =
oldPrice.prix_actuel > 0
?
(difference / Number(oldPrice.prix_actuel))*100
:
0;



const typeVariation =
difference > 0
?
"augmentation"
:
difference < 0
?
"diminution"
:
"stable";




// mise à jour du prix

const {error}=await supabase
.from("price_library")
.update({

designation,
categorie,
unite,

prix_actuel:Number(prix),

prix_entreprise:Number(prix),

updated_at:new Date()

})
.eq(
"id",
id
);



if(error){

throw error;

}



// sauvegarder historique

await supabase
.from("price_history")
.insert({

price_id:id,

ancien_prix:oldPrice.prix_actuel,

nouveau_prix:Number(prix),

difference,

pourcentage_variation:pourcentage,

type_variation:typeVariation

});



return NextResponse.json({

success:true

});


}
catch(error:any){


console.log(
"ERREUR UPDATE PRIX :",
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