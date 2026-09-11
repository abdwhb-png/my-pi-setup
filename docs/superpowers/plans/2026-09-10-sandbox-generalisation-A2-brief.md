# Lot A2 : configuration et autorité

Travaille uniquement dans le worktree Pi `~/projects/pi-integrations/.worktrees/pi-sandbox-generalisation`. Préserve les changements A1/A3 et A4 existants. Ne restaure ni ne nettoie les fichiers d’un autre lot. N’active pas le candidat dans l’installation personnelle.

## Contrat obligatoire

- Lis uniquement `~/.pi/agent/sandbox.json` et `<projet>/.pi/sandbox.json` comme sources actives après migration. Versionne le format consolidé. N’ajoute ni fichier de capacités ni section globale `projects`.
- Valide les champs selon leur provenance. Refuse explicitement un champ réservé au global dans un projet. Conserve l’identité machine, la canonicalisation et les protections des fichiers d’autorité.
- Résous socle → global → projet sous plafond global → accords temporaires de session autorisés. Garde ces derniers en mémoire. Préserve les champs absents, listes vides et exclusions sans réouvrir un accès par défaut.
- Fais agir une édition globale valide sans second octroi. Déduis le profil descriptif de la politique effective, y compris les restrictions supplémentaires. Expose seulement les modes `sandbox` et `host`; garde `isolated`/`integrated` uniquement dans le lecteur historique.
- Préserve les domaines autorisés du global lorsque le projet ne précise rien. Si le projet précise une liste, applique l’intersection et les exclusions. Canonicalise les chemins relatifs depuis leur propre racine projet. N’accorde pas de droits de lecture par le PATH.
- Applique `tmpNamespace: "lease-private"` par défaut. Autorise `host` seulement dans le plafond global explicite, avec restriction privée possible par projet. Garde Think privé.
- Fais utiliser la section `environment.path` introduite par A1/A3. N’ajoute pas une seconde clé PATH équivalente.
- Réserve `docker.allowed` au global et `docker.enabled` au projet, booléens stricts, chacun faux si absent. Sans activation du projet, désactive Docker. Sans autorisation globale, désactive Docker même si le projet demande son activation, avec diagnostic explicite.
- Garde l’autorisation Docker, les limites d’opérations et les exceptions sensibles exactes au niveau global. Place les cibles et les opérations choisies dans chaque projet. N’impose aucun registre global de cibles ordinaires ou de racines projet et ne convertis pas l’accord broker en accès brut au daemon.
- Préserve les sélections hôte explicites et leurs permissions. Ne déduis jamais le mode hôte d’un échec, d’une configuration invalide ou d’un ancien `enabled: false` hors migration.

## Migration

- Isole la lecture des anciennes sources dans `legacy-authority.ts`. Prévisualise la conversion sans écriture.
- Archive leurs octets exacts. Ne transforme pas les accords par projet en autorisations globales plus larges sans un choix explicite du plafond proposé. Conserve les droits incompatibles inactifs avec explication.
- Prépare et valide les deux destinations avant publication. Sérialise les écritures concurrentes shell/Docker du même global sans écraser les autres sections.
- Bloque les nouvelles admissions pendant la migration et après un échec partiel. Détecte une migration interrompue. Une annulation avant publication ne modifie rien.
- Conserve les autres réglages Pi, les autres projets, les opérations déjà admises, leurs délais et annulations. Ne migre aucun fichier personnel dans les tests.

## Frontières de code

Adapte `sandbox/capabilities/{authority,policy,commands,protection,runtime}.ts`, `sandbox/runtime/docker-policy.ts`, leurs tests, `sandbox/index.ts`, ses tests et les schémas de documentation concernés. Crée les lecteurs de migration et les tests nécessaires dans le même module propriétaire. Ne duplique pas les parsers ou les règles des opérations Docker. Coordonne explicitement les changements de types partagés avec le lot A4.

## Preuves minimales

- Commence par un RED via `loadSandboxConfig` ou le point d’entrée public propriétaire, pas une copie de parser.
- Couvre une édition globale de domaine, une restriction projet, une liste vide, des exclusions, un projet voisin, des chemins relatifs, une édition invalide et l’absence de fallback hôte.
- Couvre les cinq combinaisons Docker global/projet, l’activation de deux projets sans écriture globale, les mauvaises portées et les types non booléens.
- Couvre migration annulée, identité étrangère, interruption entre publications, conservation des archives et sérialisation des modifications shell/Docker.
- Vérifie ensuite les commandes via le vrai runtime Pi lorsque les hooks, l’UI ou l’admission font partie du comportement.
- Rapporte les tests exécutés, filtrés, échoués et non disponibles séparément. Ne termine pas sur une API parallèle non reliée au chargement actif.

Ne commence ce lot qu’après attribution explicite par le coordinateur. UDP, sockets et publication backend restent hors de ce sous-lot.
