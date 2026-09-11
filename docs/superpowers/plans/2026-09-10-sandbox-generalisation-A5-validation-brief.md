# Lot A3/A5 : preuves restantes de l’intégration Pi

Attends l’attribution du coordinateur. Travaille dans le candidat Pi. Préserve les contrats mode/profil, la migration, les protections et le drainage acquis. Utilise le binaire candidat explicitement identifié, sans remplacer l’installation personnelle.

## Matrice à compléter

- V1 — Exécute via le vrai runtime Pi les refus de permission et restrictions dépôt/session. Vérifie un marqueur de processus absent après refus. Conserve les contrôles existants, identifie le package réellement chargé et importe les vrais modules.
- V2 — Exécute les cas Docker global interdit/projet activé et global autorisé/projet absent : aucune requête autorisée n’atteint le daemon de fixture. Active ensuite Docker dans le fichier projet, autorise une opération bornée via le vrai broker sans registre global de projets. Révoque par édition globale puis projet avant l’admission suivante. Utilise uniquement un daemon ou endpoint de fixture, aucun service personnel.
- V3 — Qualifie tmpNamespace privé par défaut et hôte sur plafond global explicite. Vérifie la visibilité d’un marqueur hôte et d’une écriture depuis l’hôte, le refus d’une élévation projet non autorisée, le retour privé par restriction projet et les exclusions. Vérifie que Think conserve son tmp privé dans tous ces cas. N’infère pas cette propriété de la seule forme d’un objet de politique.
- V4 — Conserve timeout, annulation, préparation en échec, sortie non nulle et absence de preuve de provenance. Vérifie les modes sandbox et host, le drainage, l’invalidation avant nouvelle admission et l’absence de repli entre moteurs.
- V5 — Exécute des commandes littérales et composées avec des arguments ressemblant à des noms de gestionnaires, pipelines et scripts projet. Assert sur la commande réellement exécutée et l’absence d’ajout automatique de SFW, --ignore-scripts et --path.
- V6 — Qualifie les ressources A1b par la vraie compilation Pi après réception du backend : socket autorisé, voisin refusé, publication explicite, absence d’ouverture sortante implicite, retrait avant nouvelle admission et cleanup. Distingue écoute WSL de trajet Windows/LAN réellement vérifié.

## Correction Docker identifiée par le coordinateur

Valide la structure avant de décider qu’une section est inactive. Le vrai resolveDockerPolicy accepte actuellement sans erreur un global avec mode/targets invalides lorsque allowed est absent, un projet avec targets invalide lorsque enabled vaut false, et une exception allowUnsafeTarget placée dans un projet inactif. Commence par des RED publics pour ces cas. Conserve allowed/enabled absents à false et les restrictions valides sauvegardées lors des bascules. Refuse les champs réservés au global à toute portée projet, y compris lorsque Docker est désactivé. Vérifie ensuite le chargement réel de configuration avant admission.

## Méthode et limites

Commence par un test public minimal RED pour chaque comportement nouveau ou défectueux. Réutilise les tests existants valides pour les invariants préservés. N’ajoute pas de tests qui copient les fonctions ni de mocks qui remplacent la frontière à démontrer.

Signale immédiatement une limite du harness ou du noyau avec l’observation précise. Ne transforme pas un test réel impossible en mock présenté comme preuve équivalente. WSL est disponible ; Linux natif et client LAN externe restent à signaler séparément s’ils ne sont pas exécutés.

Rapporte pour chaque V1–V6 les fichiers, commande, résultat et éventuel manque de preuve. Termine par un FINAL seulement lorsque le sous-lot attribué est terminé. N’active pas le candidat personnellement.
