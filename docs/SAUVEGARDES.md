# Sauvegardes et reprise

## Objectifs recommandés
- Base de données : sauvegarde quotidienne, conservation 30 jours.
- Documents critiques : versionnage et réplication hors du projet principal.
- Export mensuel chiffré des clients, devis, chantiers, situations et paiements.
- RPO conseillé : 24 heures au démarrage ; RTO conseillé : 8 heures.

## Test de reprise trimestriel
1. Restaurer la base dans un projet de test.
2. Vérifier les comptes, organisations et politiques RLS.
3. Ouvrir un devis, un chantier, un document et une situation.
4. Comparer les totaux de contrôle avec la production.
5. Documenter la durée, les anomalies et les corrections.

Les sauvegardes ne doivent pas contenir de clés d’API en clair.
