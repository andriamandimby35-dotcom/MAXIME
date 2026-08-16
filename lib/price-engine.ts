import { createServerClient } from "@/lib/supabase/server";


// Sauvegarde nouveau prix IA
export async function calculatePrice(

  designation:string,

  quantite:number = 1,

  categorie?:string,

  organizationId?:string,

  marge?:number

){

  const supabase = await createServerClient();


  const {data:price}=await supabase

    .from("price_library")

    .select("*")

    .ilike(
      "designation",
      `%${designation}%`
    )

    .limit(1)

    .single();



  if(!price){

    return {

      designation,

      quantite,

      prix_unitaire:0,

      total:0,

      cout_unitaire:0,

      cout_total:0,

      marge_percent:marge || 30,

      prix_vente:0,

      source:"Aucun",

      found:false

    };

  }


  const prix_unitaire =
    Number(price.prix_actuel || 0);


  const total =
    prix_unitaire * quantite;


  const margeFinale =
    marge || 30;


  const prix_vente =
    total + (total * margeFinale / 100);


  return {

    designation,

    quantite,

    prix_unitaire,

    total,

    cout_unitaire:prix_unitaire,

    cout_total:total,

    marge_percent:margeFinale,

    prix_vente,

    source:price.prix_source || "Entreprise",

    source_prix:price.prix_source || "Entreprise",

    distance_chantier_km:price.distance_chantier_km || 0,

    confiance_ia:price.confiance_ia || 100,

    found:true

};

}
export async function savePrice(

  designation:string,

  prix:number,

  source:string="IA",

  organizationId:string

){

  const supabase = await createServerClient();


  const {data,error}=await supabase

    .from("price_library")

    .insert({

      designation,

      prix_actuel:prix,

      prix_source:source,

      organization_id:organizationId

    })

    .select()

    .single();



  if(error){

    console.log(
      "Erreur sauvegarde prix",
      error
    );

    return null;

  }


  return data;

}