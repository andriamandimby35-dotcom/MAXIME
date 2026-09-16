import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // pdfjs-dist charge son fichier "worker" par un chemin résolu à
  // l'exécution ; regroupé par le bundler de Next.js, ce chemin est réécrit
  // vers un module virtuel qui n'existe pas sur le disque et getDocument()
  // échoue systématiquement ("Setting up fake worker failed"). En le
  // marquant externe, Next.js ne le regroupe plus du tout : il est chargé
  // directement depuis node_modules au runtime, comme dans un script Node
  // classique, là où le problème n'est jamais apparu.
  serverExternalPackages: ["pdfjs-dist"],
};
export default nextConfig;
