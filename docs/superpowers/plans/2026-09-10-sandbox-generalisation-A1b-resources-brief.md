# Lot A1b : sockets précis et publication TCP

N’exécute ce lot qu’après attribution par le coordinateur. Préserve le socle qualifié et travaille dans le fork `~/projects/shared-services/sandboxes/zerobox-generalisation`. Intègre ensuite les contrats génériques dans le candidat Pi, sans nom de produit ni nouveau fichier de configuration.

## Contrats validés

- Garde les processus dans le sandbox. Refuse les ressources absentes, invalides ou non prises en charge sans repli hôte.
- Autorise un service via son socket Unix précis. Accepte les fonctions et permissions accordées par ce service, sans filtre applicatif. Conserve le broker Docker et son plafond séparés.
- Garde les serveurs privés par défaut. Publie explicitement vers la machine hôte et, via une autorisation distincte, vers le réseau local, avec adresses et ports précis.
- Distingue les sorties réseau, les services locaux accessibles et les publications entrantes. N’interprète pas `allowedDomains` comme une autorisation de publication.
- Distingue les protocoles dans le schéma. Refuse explicitement UDP et les transports non qualifiés dans cette livraison; UDP reste A7.
- Applique les plafonds globaux, les restrictions projet, les retraits avant nouvelles admissions et le drainage des opérations déjà admises.

## Sources déjà repérées

- `crates/zerobox/src/sandbox.rs` possède la préparation et les ressources d’une commande.
- `upstream/linux-sandbox/src/proxy_routing.rs` possède les routes et ponts privés existants. `prepare_private_loopback` prépare actuellement des routes sortantes vers des ports hôte autorisés; ne le présente pas comme une publication entrante.
- `upstream/linux-sandbox/src/landlock.rs` bloque les connexions en mode réseau fermé et les nouveaux sockets AF_UNIX en mode proxy. Conserve les paires de sockets de flux utilisées pour l’IPC privé.
- `scripts/upstream-proxy-routed-socket-filter.patch`, `upstream-network-hardening.patch` et `upstream-local-test-network.patch` décrivent des parties du mécanisme historique.
- `build_fs_policy` ajoute encore `/run` entier aux lectures quand le réseau est actif. Qualifie cette ouverture implicite et limite-la aux ressources techniques requises pour respecter P2.

## Qualification avant changement d’interface

Établis un contrat exécutable pour chaque mécanisme. Ne promets pas un accès Unix exact sur la seule base d’un champ de configuration.

Pour les sockets Unix, vérifie toutes les voies d’accès : chemin direct, alias, socket voisin dans un dossier déjà lisible, famille/type de socket et socket abstrait. Une simple autorisation de créer AF_UNIX ne constitue pas un contrôle par chemin si d’autres sockets hôte restent joignables. Ne suppose pas que le namespace réseau isole les sockets Unix nommés par un chemin du système de fichiers. Qualifie le mécanisme de contrôle choisi avec des services de fixture, sans contacter les services personnels.

Pour la publication, garde le serveur dans son namespace privé. Vérifie la route inverse, l’adresse d’écoute hôte, le port cible privé et les conflits. Ne confonds pas un serveur privé qui écoute sur `0.0.0.0` dans son namespace avec une autorisation d’écoute LAN hôte. Réserve explicitement chaque port et libère les listeners et processus auxiliaires après fermeture, annulation ou erreur de setup.

Sous WSL, distingue un listener sur l’hôte Linux WSL de son accessibilité effective depuis Windows ou une autre machine du réseau local. Ne présente pas un client lancé dans le même WSL comme une preuve de traversée du réseau local. Ne modifie pas automatiquement les règles Windows, le pare-feu ou le routage de la machine pour produire cette preuve. Rapporte séparément mécanisme backend, écoute observée et trajet réseau réellement exécuté.

## Publication concurrente retenue pendant l’implémentation

Active le listener hôte lorsque la cible TCP privée écoute effectivement. Une commande ordinaire comme pwd, qui ne crée pas ce serveur, ne doit réserver aucun port malgré la même configuration. Détecte l’état LISTEN par une interface du noyau dans le namespace privé, sans requête applicative ni connexion de sondage au service.

Garde la portée et les adresses fixes dans la configuration. Si un second serveur demande un port public occupé, rapporte un conflit précis et termine uniquement son opération. Ne touche pas au premier serveur. Puisque ce conflit est détecté après le démarrage de la cible privée, ne prétends pas que le processus n’a jamais démarré.

Garde le canal de contrôle privé au launcher et au monitor. Des permissions owner-only ne suffisent pas face à une commande du même utilisateur. Utilise un socketpair transmis uniquement aux helpers ou ferme le rendez-vous avant exec. Vérifie le nettoyage sur disparition du listener, fin, annulation, timeout et mort d’un helper. Qualifie les commandes concurrentes et la composition avec un socket Unix autorisé.

## Preuves et intégration

- Commence par des RED publics réels, puis implémente le mécanisme minimal. Préserve les tests du socle et les exclusions.
- Couvre accès autorisé, voisin refusé, absence de sortie réseau implicite, annulation, timeout, nettoyage, concurrence, conflit d’écoute et retrait avant nouvelle admission.
- Rejoue les patches depuis leur point d’application exact avant le formatage final. Ne modifie pas directement `upstream/` et arrête sur tout hunk rejeté.
- Préserve les patches historiques si un patch final distinct suffit. N’efface aucun cache ni état externe.
- Fais utiliser le contrat par les vraies commandes Pi et leurs permissions. Teste la résolution globale/projet et la provenance effective.
- Identifie le binaire et son SHA. Rapporte séparément WSL exécuté et Linux natif non disponible. Ne remplace pas une preuve système par un mock.
- Termine par un rapport final avec résultats réels, transports qualifiés et limites restantes. Ne publie et n’active pas le candidat personnellement.
