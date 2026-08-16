# Déploiement de Sébastien BTP

## 1. Supabase
1. Ouvrir le projet **Sebastien BTP**.
2. Appliquer les migrations du dossier `supabase/migrations` dans l’ordre.
3. Vérifier que le bucket privé `btp-documents` existe.
4. Dans Auth > URL Configuration, définir l’URL de production et ajouter `/auth/callback` aux redirections autorisées.
5. Exécuter les Security Advisors après chaque migration.

## 2. Application
1. Importer ce dépôt dans GitHub.
2. Créer un projet Vercel depuis le dépôt.
3. Ajouter les variables de `.env.example`.
4. Déployer.

## 3. Vérifications avant ouverture
- inscription d’un propriétaire ;
- création automatique de l’entreprise ;
- création d’un client, devis, chantier et appel d’offres ;
- téléversement d’un document ;
- isolation des données avec un deuxième compte ;
- génération IA avec une clé OpenAI côté serveur ;
- création d’une situation et d’un paiement après migration.
