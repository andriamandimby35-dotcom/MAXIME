import { createServerClient } from "@/lib/supabase/server";


export async function analyzeDAO(
  pdfUrl:string
){

  const supabase =
    await createServerClient();


  /*
    1 - Récupération PDF
    (connexion IA extraction à venir)
  */


  const extractedText =
  `
  Analyse DAO automatique

  Travaux détectés :
  - Construction générale
  `;



  /*
    2 - Analyse des lots
  */


  const lots = [

    {
      designation:
      "Travaux de construction",

      categorie:
      "Construction",

      quantite:1,

      unite:
      "forfait"

    }

  ];



  /*
    3 - Retour analyse
  */


  return {

    titre:
    "Analyse DAO IA",


    resume:
    extractedText,


    lots,


    confiance_ia:
    70

  };


}