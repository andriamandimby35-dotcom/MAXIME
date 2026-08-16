"use client";

export default function DeletePriceButton({
  id
}:{
  id:string
}){


async function deletePrice(){

console.log("BOUTON SUPPRIMER CLIQUE :", id);


const confirmDelete = confirm(
"Supprimer ce prix ?"
);


if(!confirmDelete) return;


const response = await fetch("/api/prices/delete",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({
id:id
})

});


const result = await response.json();


console.log(
"REPONSE DELETE :",
result
);


window.location.reload();

}


return (

<button
onClick={deletePrice}
className="bg-red-600 text-white px-3 py-1 rounded"
>
Supprimer
</button>

);


}