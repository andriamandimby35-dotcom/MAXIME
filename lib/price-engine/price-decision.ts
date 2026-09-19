import { searchExistingPrice } from "./search-price";
import { createAIPrice } from "./create-ai-price";


export async function decidePrice({
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


// 1 - Chercher un prix existant

const existingPrice = await searchExistingPrice({

designation,

categorie,

unite,

region,

organizationId

});



// 2 - Si trouvé → utiliser le prix entreprise

if(existingPrice){


if(existingPrice.statut_prix === "entreprise"){


return {

type:"existing",

source:"entreprise",

price:existingPrice

};


}


// Prix IA déjà existant

return {

type:"existing",

source:"ia",

price:existingPrice

};


}



// 3 - Sinon créer une proposition IA

const aiPrice = await createAIPrice({

designation,

categorie,

unite,

region,

organizationId

});



return {

type:"new_ai",

source:"ia",

price:aiPrice

};


}