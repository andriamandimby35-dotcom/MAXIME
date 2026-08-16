import { PwaRegister } from "@/components/pwa-register";
import { companyProfile } from "@/lib/company";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: `Sébastien BTP — ${companyProfile.shortName}`,
  description: `ERP intelligent BTP de ${companyProfile.tradeName} à Madagascar`,
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: `Sébastien BTP — ${companyProfile.shortName}` },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = { themeColor: "#163f2c" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="fr"><body><PwaRegister />{children}</body></html>;
}
