# Sécurité

- Ne jamais placer une clé Supabase `service_role` ou une clé OpenAI dans le navigateur.
- Utiliser uniquement la clé Supabase publiable côté client ; la sécurité repose aussi sur les politiques RLS.
- Activer MFA pour les comptes à privilèges et supprimer rapidement les accès des collaborateurs sortants.
- Limiter les formats et tailles de fichiers, analyser les fichiers sensibles avec un antivirus en production.
- Journaliser les actions financières et les changements de rôle.
- Exécuter les Supabase Advisors après chaque migration.
- Mettre à jour les dépendances chaque mois, après tests sur un environnement de préproduction.
- Configurer des en-têtes de sécurité au niveau du reverse proxy : HSTS, CSP, X-Content-Type-Options et Referrer-Policy.
- Tester la restauration des sauvegardes au moins chaque trimestre.
