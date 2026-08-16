export function formatMoney(value:number){

  return new Intl.NumberFormat(
    "fr-FR"
  ).format(value);

}


export function formatAr(value:number){

  return (
    new Intl.NumberFormat(
      "fr-FR"
    ).format(value)
    + " Ar"
  );

}