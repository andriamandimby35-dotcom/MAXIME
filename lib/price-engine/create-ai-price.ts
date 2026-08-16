import { createServerClient } from "@/lib/supabase/server";
import { calculateAIPrice } from "./calculate-ai-price";

export async function createAIPrice({
  designation,
  categorie,
  unite,
  region,
  organizationId
}:{
  designation:string;
  categorie:string;
  unite:string;
  region:string;
  organizationId:string;
}){


const supabase = await createServerClient();

const {data:existingPrice}=await supabase
.from("price_library")
.select("*")
.ilike(
  "designation",
  designation
)
.eq(
  "unite",
  unite
)
.eq(
  "region",
  region
)
.limit(1)
.single();


if(existingPrice){

return existingPrice;

}


// Simulation première version IA
// Plus tard remplacée par une vraie estimation IA + sources externes

const aiResult = await calculateAIPrice({

designation,

categorie,

unite

});


const prixPropose = aiResult.prix;

const confiance = aiResult.confiance;



const {data,error}=await supabase


.from("price_library")
.insert({

designation,

categorie,

unite,

region,

prix_ia:prixPropose,

prix_actuel:null,

prix_retenu:prixPropose,

prix_source:"IA",

statut_prix:"ia",

origine_prix:"internet_ia",

confiance_ia:confiance,

organization_id:organizationId

})
.select()
.single();



if(error){

console.error(
"Erreur création prix IA",
error
);

return null;

}



return data;


}