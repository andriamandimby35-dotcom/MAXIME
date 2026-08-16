const required = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Variables manquantes: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("Configuration minimale valide.");
