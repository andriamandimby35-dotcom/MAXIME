


export async function calculateAIPrice({
  designation,
  categorie,
  unite,
}:{
  designation:string;
  categorie:string;
  unite:string;
}){


// Première version du moteur IA
// Plus tard connecté aux données fournisseurs / internet / historique


let prixPropose = 0;


let confiance = 50;



// Règles temporaires IA matériaux BTP

const nom = designation.toLowerCase();


// Acier

if(
  nom.includes("acier")
){

  prixPropose = 150000;
  confiance = 85;

}


// Ciment

else if(
  nom.includes("ciment")
){

  prixPropose = 43000;
  confiance = 90;

}


// Bois

else if(
  nom.includes("bois")
  ||
  nom.includes("madrier")
  ||
  nom.includes("planche")
){

  prixPropose = 25000;
  confiance = 70;

}


// Sable

else if(
  nom.includes("sable")
){

  prixPropose = 60000;
  confiance = 70;

}


// Gravier

else if(
  nom.includes("gravier")
){

  prixPropose = 70000;
  confiance = 70;

}


// Cas inconnu

else{

  prixPropose = 0;
  confiance = 50;

}



return {

prix:prixPropose,

confiance

};


}