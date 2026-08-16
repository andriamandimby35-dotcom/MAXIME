import { companyProfile } from "@/lib/company";
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `Sébastien BTP — ${companyProfile.tradeName}`,
    short_name: "Sébastien BTP",
    description: `Gestion des appels d'offres, devis et chantiers de ${companyProfile.tradeName}`,
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f4f6f3",
    theme_color: "#163f2c",
    lang: "fr",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }
    ]
  };
}
