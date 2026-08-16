"use client";

import EditPriceButton from "./EditPriceButton";
import DeletePriceButton from "./DeletePriceButton";

export default function PriceActions({price}:{price:any}){


return (


<div
style={{
display:"flex",
flexDirection:"column",
alignItems:"flex-end",
gap:"10px",
width:"120px"
}}
>

<EditPriceButton
price={price}
/>

<button
className="
bg-green-700
text-white
px-3
py-2
rounded-lg
font-semibold
"
>
Mon prix
</button>

<DeletePriceButton
id={price.id}
/>

</div>

);

}