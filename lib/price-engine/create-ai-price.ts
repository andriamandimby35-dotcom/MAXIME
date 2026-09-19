import { createServerClient } from "@/lib/supabase/server";
import { calculateAIPrice } from "./calculate-ai-price";

// Même normalisation que la protection anti-doublon de la bibliothèque de
// prix (colonne "designation_norm" de price_library) : on garde uniquement
// les lettres et les chiffres, en minuscule. Ça permet de reconnaître le
// même matériau même écrit avec des majuscules, des accents ou une
// ponctuation différente (ex: "Fer à béton Ø6" et "FER A BETON D6").
function designationNormKey(value: string) {
  return String(value ?? "").toLowerCase().replace(/[^a-zA-Z0-9]/g, "");
}

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

// On vérifie d'abord si ce matériau existe déjà QUELQUE PART dans la
// bibliothèque de l'entreprise (même dans une autre région/catégorie/unité),
// avec la même protection anti-doublon que la base : si oui, on réutilise
// ce prix plutôt que d'en créer un deuxième (qui serait de toute façon
// refusé par la base).
const targetKey = designationNormKey(designation);
const {data:allPrices}=await supabase
.from("price_library")
.select("*")
.eq(
  "organization_id",
  organizationId
);

const existingPrice = (allPrices ?? []).find(
  (price:any) => designationNormKey(price.designation) === targetKey
) ?? null;


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



// Même sans fournisseur connu (prix IA), on initialise la liste "fournisseurs"
// avec cette estimation : si un vrai fournisseur est ajouté plus tard pour ce
// même matériau (via le formulaire), il viendra s'ajouter à côté de celle-ci
// au lieu de créer un deuxième matériau.
const initialOffer = {
  fournisseur: "",
  ville: "",
  region,
  prix: prixPropose,
  disponibilite: "",
  livraison: "",
  date_prix: new Date().toISOString(),
};

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

fournisseurs:[initialOffer],

organization_id:organizationId

})
.select()
.single();



if(error){

// La protection anti-doublon de la base a bloqué l'insertion (code 23505 =
// conflit d'unicité) : ça veut dire qu'un matériau avec ce nom vient d'être
// créé entre-temps (par exemple par une autre ligne du même devis traitée
// juste avant). On va le chercher pour le réutiliser au lieu d'échouer.
if(error.code === "23505"){

const {data:refreshedPrices} = await supabase
.from("price_library")
.select("*")
.eq(
  "organization_id",
  organizationId
);

const fallback = (refreshedPrices ?? []).find(
  (price:any) => designationNormKey(price.designation) === targetKey
) ?? null;

if(fallback) return fallback;

}

console.error(
"Erreur création prix IA",
error
);

return null;

}



return data;


}