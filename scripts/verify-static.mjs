import { existsSync, readFileSync } from "node:fs";

const required = [
  "package.json", ".env.example", "Dockerfile", "docker-compose.yml",
  "app/layout.tsx", "app/manifest.ts", "public/sw.js", "public/offline.html",
  "supabase/migrations/20260803_final_mvp_extensions.sql"
];
let failed = false;
for (const file of required) {
  if (!existsSync(file)) { console.error(`Fichier manquant: ${file}`); failed = true; }
}
const env = readFileSync(".env.example", "utf8");
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) {
  if (!env.includes(key)) { console.error(`Variable manquante: ${key}`); failed = true; }
}
if (failed) process.exit(1);
console.log("Vérification statique réussie.");
