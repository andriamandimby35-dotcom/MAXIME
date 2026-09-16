"use client";

import EditPriceButton from "./EditPriceButton";
import DeletePriceButton from "./DeletePriceButton";

export default function PriceActions({price}:{price:any}){


return (


<div style={{ display:"flex", gap:"6px" }}>

<EditPriceButton
price={price}
/>

<DeletePriceButton
id={price.id}
/>

</div>

);

}