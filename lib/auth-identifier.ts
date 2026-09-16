// Un conducteur ou un chef de chantier peut être identifié par un simple nom
// plutôt qu'une vraie adresse e-mail. Supabase Auth exige toujours un format
// e-mail : si l'identifiant saisi n'en est pas un, on lui construit une
// adresse interne stable à partir de ce même identifiant (jamais une adresse
// réelle), pour que la connexion fonctionne avec l'identifiant tel quel.
const INTERNAL_EMAIL_DOMAIN = "id.sebastienbtp.local";

export function isEmailLike(value: string) {
  return /^\S+@\S+\.\S+$/.test(value.trim());
}

export function toLoginEmail(rawIdentifier: string) {
  const value = rawIdentifier.trim().toLowerCase();
  if (isEmailLike(value)) return value;
  const slug = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `${slug || "utilisateur"}@${INTERNAL_EMAIL_DOMAIN}`;
}
