import { createServerClient } from "@/lib/supabase/server";
import { canonicalMaterialKey, canonicalUnit, materialFamily } from "@/lib/material-normalization";


// Mots trop courants pour servir à reconnaître un matériau (sinon on
// "matcherait" juste parce que deux désignations partagent un "de" ou un
// "avec").
const STOPWORDS = new Set([
  "de","du","des","le","la","les","un","une","et","ou","a","au","aux",
  "pour","avec","sans","en","sur","sous","dans",
]);

// Exportées pour être réutilisées par la recherche de prix du devis
// (app/api/prices/internet-search/route.ts), qui applique le même repli
// "recherche dans les caractéristiques techniques" que la recherche interne.
export function usefulTokens(text: string) {
  return canonicalMaterialKey(text)
    .split(" ")
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

// Regroupe tout ce qu'on connaît d'un prix (nom + chaque caractéristique
// technique enregistrée : norme, nuance, dimensions, marque...) en un seul
// texte normalisé. Un DAO ne donne souvent que l'appellation technique ou la
// nuance, sans le nom commercial ("CEM II 32,5" au lieu de "Ciment Lafatra
// CEM II 32.5") : ce texte complet permet de reconnaître quand même le bon
// matériau.
export function priceSearchableText(price:any) {
  const parts = [price.designation, price.unite];
  const caracteristiques = Array.isArray(price.caracteristiques) ? price.caracteristiques : [];
  for (const item of caracteristiques) {
    if (item?.valeur) parts.push(String(item.valeur));
  }
  return canonicalMaterialKey(parts.join(" "));
}

export function priceValue(price:any) {
  const value = Number(price.prix_retenu ?? price.prix_actuel ?? price.prix_ia ?? NaN);
  return Number.isFinite(value) ? value : Infinity;
}

// Quand plusieurs matériaux se ressemblent assez pour être ambigus (ou
// qu'aucun ne se distingue vraiment), on prend le moins cher plutôt que de
// deviner : un vrai prix déjà enregistré reste préférable à un prix IA
// inventé, même si le produit exact n'est pas garanti.
export function cheapestOf(prices:any[]) {
  return prices.reduce((best, price) => (priceValue(price) < priceValue(best) ? price : best));
}


export async function searchExistingPrice({
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



const {data,error}=await supabase
.from("price_library")
.select("*")
.eq(
  "region",
  region
)
.eq(
  "organization_id",
  organizationId
);



if(error){

console.error(
"Erreur recherche prix",
error
);

return null;

}



if(!data || data.length===0){

return null;

}


// On ne compare plus le texte brut (un simple "contient"), car deux noms
// différents peuvent désigner le même matériau ("Tuyau PVC Ø63" vs "Tuyau
// PVC-U Ø63 pression PN16"). On utilise le même système de normalisation
// que la bibliothèque de prix pour retrouver le prix entreprise déjà
// enregistré au lieu d'en recréer un.
//
// On limite d'abord aux matériaux de la même catégorie et de la même unité
// (comparées elles aussi de façon tolérante, car le texte du DAO n'a pas
// forcément exactement la même orthographe que la bibliothèque).

const targetCategorie = canonicalMaterialKey(categorie);
const targetUnit = canonicalUnit(unite);
const candidates = data.filter(
  (price:any) => canonicalMaterialKey(price.categorie) === targetCategorie && canonicalUnit(price.unite) === targetUnit
);

if(candidates.length === 0){
  return null;
}

const targetKey = canonicalMaterialKey(designation);
const targetFamily = materialFamily(designation);

// 1 - Correspondance la plus précise : même désignation normalisée
const exactMatches = candidates.filter(
  (price:any) => canonicalMaterialKey(price.designation) === targetKey
);
if(exactMatches.length === 1) return exactMatches[0];
if(exactMatches.length > 1) return cheapestOf(exactMatches);

// 2 - Repli : même "famille" de matériau (ex: même diamètre d'acier, même
// dosage de béton), pour les libellés qui changent de forme mais pas de fond.
const familyMatches = candidates.filter(
  (price:any) => materialFamily(price.designation) === targetFamily
);
if(familyMatches.length === 1) return familyMatches[0];
if(familyMatches.length > 1) return cheapestOf(familyMatches);

// 3 - Le DAO ne donne parfois que l'appellation technique, la nuance ou la
// norme (sans nom commercial). On vérifie alors TOUS les détails enregistrés
// du matériau (nom + caractéristiques techniques) : on ne parle ici que
// d'une piste sérieuse si tous les mots utiles du DAO s'y retrouvent.
const targetTokens = usefulTokens(designation);
if(targetTokens.length > 0){

  const detailMatches = candidates.filter((price:any) => {
    const text = priceSearchableText(price);
    return targetTokens.every((word) => text.includes(word));
  });

  if(detailMatches.length === 1) return detailMatches[0];
  if(detailMatches.length > 1) return cheapestOf(detailMatches);

}

// 4 - Rien d'assez précis pour désigner un matériau en particulier (0 ou
// plusieurs pistes sérieuses) : plutôt qu'un prix IA inventé, on prend le
// moins cher des matériaux déjà enregistrés dans cette même catégorie et
// cette même unité. Le prix IA n'est utilisé que si rien du tout n'est
// enregistré pour cette catégorie/unité (candidates vide, déjà traité plus haut).
return cheapestOf(candidates);


}
