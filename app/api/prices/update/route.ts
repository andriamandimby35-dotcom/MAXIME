import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";


export async function POST(req:Request){

try{


const supabase = await createServerClient();


const body = await req.json();


const {
id,
designation,
prix,
unite_achat,
quantite_par_unite_achat,
prix_unite_achat
}=body;



if(!id){

throw new Error(
"ID manquant"
);

}



// utilisateur connecté

const {
data:{user}
}=await supabase.auth.getUser();



if(!user){

throw new Error(
"Utilisateur non connecté"
);

}



// organisation

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



// récupérer ancien prix avant modification

const {data:oldPrice,error:oldPriceError}=await supabase
.from("price_library")
.select("prix_actuel,prix_retenu,prix_ia")
.eq("id",id)
.eq("organization_id",organizationId)
.single();


if(oldPriceError){

throw oldPriceError;

}



// calcul variation

const ancienPrix = Number(oldPrice.prix_retenu) || Number(oldPrice.prix_actuel) || Number(oldPrice.prix_ia) || 0;

const nouveauPrix = Number(prix);


const difference = nouveauPrix - ancienPrix;


const pourcentage =
ancienPrix > 0
?
Number(((difference / ancienPrix) * 100).toFixed(2))
:
0;


const typeVariation =
ancienPrix <= 0
?
"nouveau"
:
difference > 0
?
"augmentation"
:
difference < 0
?
"diminution"
:
"stable";



// mise à jour du prix actuel

const {data,error}=await supabase
.from("price_library")
.update({

designation,

prix_actuel:nouveauPrix,

prix_entreprise:nouveauPrix,

prix_retenu:nouveauPrix,

unite_achat: unite_achat || null,

quantite_par_unite_achat: quantite_par_unite_achat ? Number(quantite_par_unite_achat) : null,

prix_unite_achat: prix_unite_achat ? Number(prix_unite_achat) : null,

updated_at:new Date()

})
.eq("id",id)
.eq("organization_id",organizationId)
.select()
.single();



if(error){
throw error;
}



// sauvegarde historique
// Un enregistrement sans changement réel de prix ne doit pas polluer
// l'historique avec des lignes identiques répétées.

if(nouveauPrix !== ancienPrix){

const {error:historyError}=await supabase
.from("price_history")
.insert({

price_id:id,

organization_id:organizationId,

ancien_prix:ancienPrix,

nouveau_prix:nouveauPrix,

difference:difference,

pourcentage_variation:pourcentage,

type_variation:typeVariation

});



if(historyError){

console.log(
"ERREUR INSERT HISTORY :",
historyError
);

throw historyError;

}

}

console.log(
"HISTORIQUE ENREGISTRE",
{
price_id:id,
ancienPrix,
nouveauPrix,
difference,
pourcentage,
typeVariation
}
);


return NextResponse.json({

success:true,

data

});


}
catch(error:any){


console.log(
"ERREUR MODIFICATION PRIX:",
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