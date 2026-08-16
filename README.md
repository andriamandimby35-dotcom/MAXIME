# Sébastien BTP — version installable MVP

Application web/PWA de gestion BTP pour Madagascar, construite avec Next.js, Supabase et un module IA optionnel.

## Modules
- authentification et séparation des entreprises par RLS ;
- tableau de bord ;
- clients et fournisseurs ;
- appels d’offres, analyse IA et mémoire technique ;
- devis et bibliothèque de prix ;
- chantiers, dépenses et rapports ;
- situations de travaux et paiements ;
- documents privés ;
- installation PWA sur téléphone ;
- Docker, contrôle de santé et CI.

## Installation rapide avec Docker
```bash
cp .env.example .env.local
# Compléter .env.local
docker compose up -d --build
```
Ouvrez ensuite `http://localhost:3000`.

## Installation classique
```bash
cp .env.example .env.local
./install.sh
npm start
```

Consultez `INSTALLATION.md` pour la procédure complète et `docs/RECOMMANDATIONS.md` avant une mise en production.

## Base Supabase
Les migrations financières et les index de performance ont été appliqués au projet Supabase Sébastien BTP le 3 août 2026. Les fichiers SQL restent inclus pour reproduire une nouvelle installation.

## Vérifications réalisées
- contrôle statique des fichiers obligatoires : réussi ;
- migration financière : appliquée ;
- audit sécurité Supabase : aucune alerte ;
- index de performance recommandés : ajoutés.

La compilation Next.js doit encore être exécutée sur un poste, GitHub Actions, Vercel ou Docker disposant d’un accès au registre npm public. Le registre npm de l’environnement de génération ne fournit pas `@supabase/ssr`, ce qui empêche une compilation locale ici.

## Responsabilité
Ce MVP n’est pas un logiciel comptable certifié. Les taxes, retenues, contrats, mémoires techniques et productions IA doivent être validés par les responsables compétents avant usage officiel.

## Personnalisation May&Lanah
Cette édition est préconfigurée pour **May&Lanah (M&L)**. Les coordonnées légales sont centralisées dans `lib/company.ts` et décrites dans `PROFIL_ENTREPRISE.md`.

Aucun mot de passe personnel n’est inclus dans le dépôt.
