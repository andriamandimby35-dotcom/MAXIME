"use client";

import { useState } from "react";


export default function EditPriceButton({
  price
}:{
  price:any
}){


const [open,setOpen]=useState(false);

const [designation,setDesignation]=useState(
price.designation
);

const [prix,setPrix]=useState(
price.prix_actuel
);

async function updatePrice(){


await fetch("/api/prices/update",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({

id:price.id,

designation,

prix:Number(prix)

})

});


window.location.reload();

}

return (

<>

<button
onClick={()=>setOpen(true)}
className="bg-blue-600 text-white px-3 py-1 rounded"
>
Modifier
</button>



{open && (

<div className="fixed inset-0 bg-black/40 flex items-center justify-center">


<div className="bg-white p-6 rounded-xl w-96">


<h2 className="font-bold text-xl mb-4">
Modifier le prix
</h2>



<input
className="border p-2 w-full mb-2"
value={designation}
onChange={(e)=>setDesignation(e.target.value)}
/>


<input
className="border p-2 w-full mb-2"
value={prix}
onChange={(e)=>setPrix(e.target.value)}
/>



<button
onClick={updatePrice}
className="bg-green-600 text-white px-4 py-2 rounded mr-2"
>
Enregistrer
</button>



<button
onClick={()=>setOpen(false)}
className="bg-gray-400 text-white px-4 py-2 rounded"
>
Annuler
</button>



</div>


</div>

)}


</>

);

}