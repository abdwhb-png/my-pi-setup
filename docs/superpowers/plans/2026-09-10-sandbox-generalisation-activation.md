# Préparation de l’activation personnelle

> **Superseded activation note (2026-09-12):** This procedure records the
> earlier architecture only. Do not use its activation claims for the approved
> [private runtime and local environments design](../../brainstorming/2026-09-12-sandbox-private-runtime-and-local-environments-design.md),
> whose implementation and installation are recorded in the
> [runtime guide](../../../agent/extensions/sandbox/docs/runtime.md#qualification-and-activation).
> The newer release atomically installs and pins its private runtime
> distribution, then validates admission-backed evidence.

Garde cette procédure séparée de l’implémentation. N’exécute pas l’activation, la migration personnelle ni le rollback sans choix explicite de l’utilisateur.

## Conditions avant activation

- A1 — Termine les lots backend et Pi, puis identifie les révisions de code et le binaire Zerobox avec version, SHA-256, pin upstream et patches rejoués. Mets la provenance attendue du candidat en accord avec cet artefact.
- A2 — Exécute un Pi neuf isolé avec les packages effectivement résolus. Vérifie les deux modes et les profils descriptifs, les permissions, la configuration globale/projet et le refus sans repli hôte.
- A3 — Consigne les résultats ciblés, la suite des frontières partagées et les essais système. Distingue les preuves WSL, Linux natif et trajet Windows/LAN. Rapporte les plateformes absentes sans les remplacer par des fixtures.
- A4 — Présente la prévisualisation de migration personnelle et les limites globales choisies. Ne réunis pas automatiquement les anciens accords Docker par projet. Signale les champs incompatibles et les accords qui ne seront pas réactivés.

## Activation après choix explicite

Archive exactement les configurations touchées et conserve leur empreinte. Vérifie leur contenu avant la publication pour ne pas écraser une édition intervenue depuis la prévisualisation. Conserve les autres réglages et changements personnels.

Laisse terminer les opérations admises et arrête leurs anciens propriétaires. Installe ensemble le code et le binaire qualifiés, puis publie les configurations consolidées par la migration prévue. Conserve la barrière d’admission en cas d’interruption et utilise la récupération vérifiée.

Démarre un Pi entièrement neuf. N’utilise pas un simple /reload comme preuve du remplacement des propriétaires et des schémas. Vérifie les packages chargés, la provenance du binaire, les configurations actives et les parcours autorisés et refusés prévus dans le rapport de qualification.

## Rollback sur choix explicite

Vérifie d’abord les modifications intervenues depuis l’activation. Présente les différences avant de restaurer une archive. Restaure ensemble une version compatible du code, du binaire et du format d’autorité.

Ne réactive pas automatiquement les anciens accords. Ne remplace pas des modifications utilisateur étrangères au rollback. Laisse la barrière d’admission active si la récupération détecte une divergence et rapporte les fichiers concernés.

## État de cette préparation

Activation autorisée et réalisée le 2026-09-11. Le code qualifié est installé dans `~/.pi/agent/extensions` et le binaire dans `~/.pi/bin/zerobox`, SHA-256 `87a73d1bd2556ad629e3a675b8d39898aa693c4e0b7cc27c33078e4a3b298b7f`. Les sauvegardes exactes du code, de l’ancien binaire et des configurations sont conservées dans `~/.local/state/pi/sandbox-activation-20260911-KKgIngiq`.

La configuration globale active est `~/.pi/agent/sandbox.json`. Cliproxy et Shein ont chacun leur `.pi/sandbox.json`. Les deux anciennes sources globales sont archivées hors des emplacements actifs. Les fichiers `settings.json` sont conservés à l’identique. Le global autorise Docker, limite les opérations et conserve l’exception sensible exacte de Cliproxy. Les cibles ordinaires restent choisies dans les projets. Docker est initialement activé seulement dans Cliproxy.

Deux essais dans un nouveau processus avec le runtime Pi installé passent : shell, outils installés, HOME/cache privé, inspection Docker et sonde exec autorisée, refus de l’exec libre et refus Docker dans Shein, analyses JavaScript/Python et commande Think. Le magasin Think des essais est isolé. Aucun fournisseur LLM n’est appelé et aucun service Docker n’est redémarré. La session Pi préexistante dans Shein reste ouverte et doit être relancée pour charger le nouveau code. Les preuves restent limitées à WSL.
