# Installer Sébastien BTP

## 1. Préparer l’environnement
Vous avez besoin de l’un des deux environnements suivants :
- Docker Desktop ; ou
- Node.js 22 et npm avec accès au registre npm public.

Copiez le fichier de configuration :
```bash
cp .env.example .env.local
```

Renseignez :
- `NEXT_PUBLIC_SUPABASE_URL` ;
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` ;
- `OPENAI_API_KEY` uniquement pour l’analyse IA ;
- `OPENAI_MODEL`.

N’ajoutez jamais de clé `service_role` dans ce fichier destiné à l’application web.

## 2. Installer avec Docker — méthode recommandée
```bash
./install-docker.sh
```
Ou manuellement :
```bash
docker compose up -d --build
```
L’application est accessible à `http://localhost:3000`.

Vérifiez :
```bash
curl http://localhost:3000/api/health
```

## 3. Installer sans Docker
```bash
./install.sh
npm start
```
Pour le développement :
```bash
npm run dev
```

## 4. Supabase
Pour le projet Supabase créé pendant cette conversation, les migrations complémentaires ont déjà été appliquées. Pour un nouveau projet, appliquez dans l’ordre les fichiers de `supabase/migrations` depuis le SQL Editor ou la CLI Supabase.

Dans Supabase Auth, configurez :
- l’URL du site ;
- `https://votre-domaine/auth/callback` comme URL de redirection ;
- la confirmation d’e-mail selon votre politique ;
- MFA pour les comptes administrateurs.

## 5. Installer sur téléphone
L’application doit être déployée en HTTPS.
- Android/Chrome : menu → **Installer l’application** ou **Ajouter à l’écran d’accueil**.
- iPhone/Safari : Partager → **Sur l’écran d’accueil**.

Une page hors connexion et un cache de consultation sont inclus. La saisie complète hors ligne avec synchronisation différée reste une évolution recommandée.

## 6. Déployer
### Vercel
1. Importez le dépôt Git.
2. Ajoutez les variables d’environnement.
3. Déployez.
4. Mettez à jour les URL Auth dans Supabase.

### Serveur Docker
Utilisez un reverse proxy HTTPS, par exemple Caddy, Nginx ou Traefik, devant le port 3000.

## 7. Recette avant ouverture aux utilisateurs
- créer un compte et vérifier l’entreprise ;
- créer un client, un fournisseur et un prix ;
- créer un appel d’offres et tester l’analyse IA ;
- créer un devis et un chantier ;
- enregistrer une situation et un paiement ;
- téléverser puis relire un document ;
- tester les accès avec deux entreprises différentes ;
- sauvegarder puis restaurer sur un environnement de test.
