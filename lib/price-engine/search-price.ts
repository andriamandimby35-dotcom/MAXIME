import { createServerClient } from "@/lib/supabase/server";


export async function searchExistingPrice({
  designation,
  unite,
  region,
  organizationId
}:{
  designation:string;
  unite:string;
  region:string;
  organizationId:string;
}){


const supabase = await createServerClient();



const {data,error}=await supabase
.from("price_library")
.select("*")
.ilike(
  "designation",
  `%${designation}%`
)
.eq(
  "unite",
  unite
)
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



// Retourne le premier prix correspondant exactement

return data[0];


}