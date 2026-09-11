# Intégration Pi des ressources A1b

Applique ce lot après le correctif HOME, la provenance de `!s` et la restauration du break-glass. Conserve le worker Pi comme unique propriétaire des fichiers TypeScript. Coordonne les interfaces avec le worker backend. Ne déclare pas TCP disponible sur le seul parsing de ses options.

## Contrat

- R1 — Conserve seulement les deux documents `sandbox.json`. Déclare les sockets Unix précis et les publications dans la politique générique. Ne crée ni fichier, ni profil, ni identifiant de produit supplémentaire.
- R2 — Fais définir les ressources autorisées par le global. Permets au projet et à la session de les conserver ou de les réduire. Une liste absente hérite, une liste vide ferme. Canonicalise les chemins avant de comparer les droits. Compare une publication par son tuple complet transport, scope, écoute et destination.
- R3 — Distingue explicitement TCP et UDP. Refuse UDP avec un diagnostic d'indisponibilité. Exige une adresse IP littérale et un port non nul. Limite la cible au loopback privé. Exige une sélection distincte host ou lan et refuse les adresses wildcard.
- R4 — Compile les ressources vers les interfaces qualifiées `--allow-unix-socket PATH` et `--publish-tcp SCOPE@LISTEN->TARGET`, sans réécrire la commande utilisateur. Ajoute les ressources à l'empreinte de politique et à la dérivation default/custom.
- R5 — Garde Think et Analysis stricts. Ne propage pas une ressource shell comme autorisation implicite à leurs profils internes.
- R6 — Préserve Docker via son broker. Refuse les endpoints daemon connus et configurés et leurs alias lorsqu'ils sont demandés comme sockets bruts. Compare les chemins canoniques et l'identité de l'inode quand disponible. N'ajoute pas de filtre produit dans Zerobox.
- R7 — Détecte le backend réellement chargé et refuse une capacité qu'il ne sait pas appliquer. Une provenance valide et une configuration acceptée ne remplacent pas un test d'échange réel.

## Durée de vie à résoudre avant clôture

Ferme l'écoute publiée et refuse les nouvelles connexions lors de la révocation. Borne le traitement des connexions déjà admises. Ne suppose pas que le drainage actuel d'un ancien runtime ferme une écoute ou révoque un socket Unix bindé.

Décris et teste le mécanisme exact avec le worker backend. Une commande déjà admise peut encore effectuer des connexions tant que son mount ou son transport reste actif. Ne présente pas une simple interdiction de la prochaine commande comme une révocation de ces connexions.

Conserve timeout, annulation, diagnostic de conflit et nettoyage. La publication est paresseuse après LISTEN privé : un `pwd` concurrent ne réserve pas le port. Un conflit du second serveur ne doit pas interrompre le premier ni être décrit comme un refus avant démarrage de sa cible.

## Validation

- V1 — Commence par RED public du loader et de la compilation : plafonds, restrictions, listes vides, alias, champs inconnus, UDP et scope/ports invalides.
- V2 — Exécute un service Unix jetable avec le vrai runtime Pi : socket autorisé joignable, voisin et endpoint Docker refusés, identité/permissions conservées. Vérifie les effets observés côté serveur.
- V3 — Exécute une publication TCP avec le vrai runtime Pi : connexion hôte autorisée, absence de publication par défaut, refus réseau sortant maintenu, commande ordinaire concurrente, conflit et nettoyage.
- V4 — Modifie les deux fichiers dans une session persistante. Vérifie les nouvelles admissions, les nouvelles connexions et le traitement borné des anciennes connexions. Ne masque pas l'absence de mécanisme de révocation par un mock.
- V5 — Utilise uniquement des fixtures et des racines de lease/probe/récupération isolées. Consigne binaire, SHA et packages réellement résolus. Distingue preuve WSL, Linux natif et connexion depuis un pair LAN.
