import { decidePrice } from "@/lib/price-engine/price-decision";


export async function getEstimatePrice({
  designation,
  categorie,
  unite,
  region,
  organizationId,
  quantite
}:{
  designation:string;
  categorie:string;
  unite:string;
  region:string;
  organizationId:string;
  quantite:number;
}){


const result = await decidePrice({

designation,
categorie,
unite,
region,
organizationId

});



if(!result.price){

return null;

}



const prixUnitaire =
result.price.prix_retenu ??
result.price.prix_actuel ??
result.price.prix_ia ??
0;



return {

designation,

unite,

quantite,

prix_unitaire:prixUnitaire,

total:
quantite * prixUnitaire,

source:result.source,

type:result.type

};


}