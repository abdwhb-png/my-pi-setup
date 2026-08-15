# Backends de compression locaux sélectionnables

Date : 2026-08-15
Statut : validé (brainstorming session)
Remplace pour le choix du moteur : `2026-07-01-edgee-bridge-design.md`

## Contexte

`save-tokens` compresse actuellement certains résultats de tools via un service
HTTP Edgee local. L'utilisateur veut conserver Edgee, intégrer Headroom et
choisir un seul moteur global depuis `saveTokens.compressor.backend`.

Toutes les données doivent rester sur la machine. Le gateway propriétaire Edgee
est exclu. L'extension Pi ne doit ni installer, ni construire, ni démarrer les
services. Docker Compose reste l'interface opérateur explicite.

Les sources ont changé depuis le benchmark initial :

- Headroom expose maintenant un endpoint officiel `POST /v1/compress` et une
  API directe `ContentRouter.compress()`.
- Le dépôt Edgee public ne contient plus `crates/compressor`. La compression a
  été déplacée vers le gateway privé sous le nom `tool-result-trimming`.
- La dernière source publique `edgee-compressor` reste disponible dans
  l'historique Git pré-suppression et sur crates.io en version `0.1.3`, sous
  licence Apache-2.0.
- Le container Edgee actuel utilise une image historique du 3 juillet 2026. Le
  service ne peut pas être reconstruit depuis l'arborescence actuelle : Compose
  et Cargo référencent encore les anciens chemins `service/` et `source/`.

## Décisions

1. Ajouter deux backends locaux : `headroom` et `edgee`.
2. Sélectionner un seul backend global. Aucun fallback automatique vers l'autre
   moteur.
3. Utiliser Headroom par défaut si `backend` est absent.
4. Utiliser le proxy HTTP officiel Headroom, pas un subprocess Python par
   résultat.
5. Vendor la dernière source publique Edgee pré-suppression, avec provenance,
   licence et checksum. Ne pas utiliser le gateway Edgee.
6. Démarrer manuellement uniquement le service sélectionné via Docker Compose.
7. Garder dans `save-tokens` les seuils, archives, cap fallback, fail-open,
   télémétrie et UI.
8. Bloquer techniquement tout egress du service Headroom. Les flags applicatifs
   seuls ne constituent pas une frontière de sécurité suffisante.

## Architecture

### Contrat interne

`save-tokens` utilise un contrat sémantique commun, indépendant des protocoles
HTTP propres aux moteurs :

```ts
interface CompressionBackendRequest {
    toolCallId: string;
    toolName: string;
    arguments: unknown;
    output: string;
    model: {
        provider: string;
        id: string;
        contextWindow: number;
    };
}

interface CompressionBackendResult {
    output: string | null;
    reason?: string;
    metrics?: {
        tokensBefore?: number;
        tokensAfter?: number;
        tokensSaved?: number;
        transforms?: string[];
    };
}

interface CompressionBackend {
    readonly id: "headroom" | "edgee";
    compress(
        request: CompressionBackendRequest,
        signal?: AbortSignal,
    ): Promise<CompressionBackendResult>;
}
```

Le registry reste statique et typé. Aucun plugin dynamique ni auto-discovery
n'est nécessaire pour deux moteurs connus.

### Couche de politique

La politique commune reste propriétaire de :

- l'allowlist des tools ;
- `excludeTools` ;
- la politique audit ;
- les seuils par groupe ;
- le traitement des erreurs ;
- le cap head/tail ;
- l'archivage de l'original ;
- l'escape hatch ;
- la validation du gain ;
- les observations, la télémétrie et l'UI.

Les adapters ne décident pas quand compresser. Ils traduisent une requête et
normalisent une réponse.

## Configuration

```json
{
  "saveTokens": {
    "compressor": {
      "backend": "headroom",
      "backends": {
        "headroom": {
          "baseUrl": "http://127.0.0.1:8787",
          "timeoutMs": 1000
        },
        "edgee": {
          "baseUrl": "http://127.0.0.1:8320",
          "timeoutMs": 800
        }
      }
    }
  }
}
```

Règles :

- `backend` accepte `headroom` ou `edgee` ;
- absence de `backend` sélectionne `headroom` ;
- config projet écrase config globale avec merge profond des blocs backend ;
- `HEADROOM_COMPRESSOR_BASE_URL` et `EDGEE_COMPRESSOR_BASE_URL` surchargent
  les URLs correspondantes ;
- les timeouts peuvent avoir des variables backend-spécifiques ;
- ancien `compressor.baseUrl` reste temporairement un alias Edgee ;
- ancien `routingStrategy` est déprécié. `benchmark` produit un warning unique
  puis suit le nouveau backend effectif ;
- backend invalide produit un warning unique et un fail-open.

## Adapter Headroom

### Protocole

L'adapter appelle `POST /v1/compress` avec un seul message OpenAI tool :

```json
{
  "messages": [
    {
      "role": "tool",
      "tool_call_id": "<pi-tool-call-id>",
      "content": "<tool-output>"
    }
  ],
  "model": "<canonical-model-id>",
  "config": {
    "protect_recent": 0
  }
}
```

Le mode reste marker-free. Headroom CCR n'est pas utilisé : `save-tokens`
possède déjà son archive et son mécanisme de récupération.

`protect_recent: 0` est obligatoire pour un résultat tool isolé. Les mesures
locales ont montré que la configuration par défaut protège parfois le seul
message et retourne `router:noop` ou `router:protected:recent_code`.

### Modèles

Le modèle Pi courant est résolu à chaque `tool_result`, car il peut changer en
cours de session. Une table explicite convertit les aliases locaux vers un ID
compris par Headroom. Aucun ID n'est inventé. Un fallback tokenizer doit être
documenté et télémétré si Headroom ne connaît pas le modèle.

### Validation

La réponse doit contenir exactement le message tool corrélé. Le contenu doit
être textuel, non vide et plus court que l'original. Sinon l'appel est `skipped`
ou `failed` et la politique commune décide du cap fallback.

Les métriques natives Headroom sont conservées comme metadata. Les tailles
compatibles avec l'historique `save-tokens` restent calculées à partir du texte
accepté. Les octets, caractères et tokens ne doivent pas être mélangés.

## Service Headroom

Le proxy officiel est un sidecar local persistant :

- bind hôte `127.0.0.1:8787` ;
- `HEADROOM_OFFLINE=1` ;
- `HEADROOM_STATELESS=1` ;
- télémétrie/beacon désactivés explicitement ;
- `HEADROOM_KOMPRESS_ENDPOINT` absent ;
- Kompress local préchargé dans l'image ou désactivé pour compression
  structurelle seulement ;
- egress refusé par la topologie container/pare-feu ;
- image pin par commit ou digest ;
- health check après initialisation du pipeline, pas seulement ouverture du
  port.

Le blocage egress est la garantie de confidentialité. `HEADROOM_OFFLINE` utilise
des défauts applicatifs et ne remplace pas une restriction réseau.

Mesures exploratoires sur fixtures synthétiques Pi :

- appels chauds `/v1/compress` : environ 18 à 95 ms ;
- premier appel observé : environ 3,1 s ;
- démarrage Python frais avec import `ContentRouter` : médiane environ 362 ms ;
- compression non garantie pour chaque payload ; un no-op sain est attendu.

Ces chiffres orientent le warmup et le timeout, mais ne remplacent pas le
benchmark final sur sorties réelles.

## Adapter et service Edgee

L'adapter conserve le contrat historique :

```json
{
  "tool_name": "read",
  "arguments": "{...}",
  "output": "...",
  "agent": "claude"
}
```

Réponse :

```json
{
  "compressed_output": "<string-or-null>"
}
```

Mappings prouvés : `read`, `grep`, `bash`, avec `safe_bash -> bash`. `ls` et
`find` ne sont pas envoyés sous un faux nom `glob` tant que le moteur vendored
ne prouve pas ce support. Ils passent par bypass ou cap fallback.

Le service Rust doit vendor la source publique `edgee-compressor` depuis le
commit parent de la suppression du crate. Le dossier vendored inclut :

- source exacte ;
- licence Apache-2.0 et notices ;
- URL et commit upstream ;
- version crates.io correspondante ;
- checksum de l'archive/source ;
- note expliquant que la branche Edgee actuelle ne maintient plus ce moteur.

Le build ne dépend plus de `edgee-source`, qui reste le CLI/gateway actuel. Le
port hôte est bind uniquement sur `127.0.0.1:8320`.

## Flux d'un résultat

1. Extraire les blocs texte ; bypass des contenus non textuels.
2. Appliquer allowlist, audit policy, exclusions, seuils et politique erreurs.
3. Résoudre config globale/projet et backend effectif.
4. Construire `CompressionBackendRequest` avec modèle Pi courant.
5. Appeler uniquement adapter sélectionné avec `AbortSignal`.
6. Valider réponse et gain.
7. Archiver original localement avant remplacement.
8. Ajouter agrégats et escape hatch.
9. Remplacer `content` et fusionner `details.compression`.
10. Émettre observation et mettre à jour UI.

Il n'existe aucun fallback automatique Headroom vers Edgee ou inversement. Le
cap local peut rester fallback déterministe selon la politique existante.

## Erreurs et télémétrie

Trois outcomes sont distingués :

- `compressed` : sortie acceptée, archivée et injectée ;
- `skipped` : backend sain mais no-op, résultat non rentable, taille trop petite
  ou outil non supporté ;
- `failed` : timeout, réseau, HTTP non-2xx, JSON/schema invalide, backend invalide
  ou résolution modèle impossible.

Chaque observation ajoute :

- backend et version ;
- latence ;
- raison exacte ;
- tailles originale et finale ;
- métriques tokens/transforms natives si disponibles ;
- tokenizer ou modèle effectif pour Headroom.

Les champs existants restent compatibles. Les warnings sont dédupliqués par
session. Une défaillance ne supprime ni ne corrompt jamais le résultat original.

Le widget affiche moteur actif et état dérivé des derniers appels. Aucun poll
de health constant n'est nécessaire.

## Docker Compose et exploitation

Un Compose racine définit deux profils indépendants :

```bash
docker compose --profile headroom up -d
docker compose --profile edgee up -d
```

Un seul profil doit tourner. Changer backend demande :

1. arrêter profil courant ;
2. démarrer nouveau profil ;
3. changer `saveTokens.compressor.backend` ;
4. recharger Pi.

README doit documenter build, start, stop, health, warmup, choix config et test
d'egress. Pi ne pilote jamais Docker.

## Tests

### TDD config

- backend absent sélectionne Headroom ;
- sélection Edgee ;
- merge global/projet profond ;
- variables backend-spécifiques ;
- migration anciens champs ;
- backend invalide.

### TDD adapters et handler

- traduction requête/réponse Headroom ;
- `protect_recent: 0` et mode marker-free ;
- modèle canonique et modèle inconnu ;
- traduction Edgee et outils supportés ;
- timeout, abort, non-2xx, JSON/schema invalide ;
- no-op et sortie plus grande ;
- fail-open ;
- archive et details ;
- télémétrie backend-aware ;
- absence de fallback inter-moteurs.

### Services

Edgee : `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test`,
tests `/health` et `/compress`, build Docker reproductible.

Headroom : tests upstream ciblés `/v1/compress`, health/warmup, offline/stateless,
et smoke test du service réel.

### Confidentialité

- canary unique dans payload ;
- aucune requête externe contenant canary ;
- egress depuis container doit échouer ;
- Pi vers loopback doit réussir ;
- aucune télémétrie distante ;
- archives et télémétrie locales restent explicitement documentées.

### Benchmark

Rejouer `read`, `grep`, `bash`, `safe_bash`, `ls` et `find` avec sorties réelles
anonymisées : code, JSON, logs, erreurs, Unicode, données répétitives et secrets
redacted. Mesurer réduction, signaux critiques préservés, latence froide/chaude,
no-op et fail-open. Les résultats n'activent aucun routage automatique dans
cette phase.

## Critères d'acceptation

- changer `backend` et profil Compose suffit pour changer moteur ;
- Headroom est défaut ;
- seul service sélectionné tourne ;
- aucune donnée ne quitte la machine ;
- backend mort conserve résultat original ;
- original complet reste récupérable via archive ;
- Edgee se reconstruit sans checkout CLI actuel ;
- Headroom ne dépend pas d'un subprocess Python par tool result ;
- tests, typecheck, lint, suites Rust/Python et smoke Compose passent ;
- provenance Edgee et pin Headroom sont audités et documentés.

## Alternatives rejetées

### Deux services toujours actifs

Rejeté : ressources, surface réseau et risque d'egress inutiles avec backend
global unique.

### Routeur HTTP unifié supplémentaire

Rejeté pour cette phase : ajoute un troisième composant et double traduction
sans besoin fonctionnel. Le contrat commun TypeScript suffit.

### Subprocess Headroom par résultat

Rejeté : coût de démarrage, dépendances Python dans le lifecycle Pi et API
directe moins stable que l'endpoint HTTP public.

### Gateway Edgee propriétaire

Rejeté : données sortent de la machine et moteur n'est pas auditable.

### Fallback automatique entre moteurs

Rejeté : rend comportement dépendant de disponibilité et réduit déterminisme.

### RTK à la place d'Edgee

Reporté : alternative locale active, mais comportement et contrat diffèrent du
moteur Edgee historique. Peut devenir une migration future si le moteur vendored
devient trop obsolète.

## Risques résiduels

- moteur Edgee vendored est figé et ne reçoit plus correctifs upstream publics ;
- mapping des aliases modèles Pi vers tokenizers Headroom doit rester maintenu ;
- modèles/assets Headroom peuvent augmenter taille image et warmup ;
- compression Headroom peut être no-op selon payload ;
- mises à jour Headroom peuvent modifier routing, métriques ou schéma ;
- archive et télémétrie locales contiennent potentiellement données sensibles,
  même sans egress.

Toute mise à jour de moteur exige pin explicite, revue changelog, benchmark,
tests de confidentialité et mise à jour de provenance.