# Carezy Sirene Client

Client TypeScript pour vérifier un établissement par son SIRET et récupérer, lorsqu’il est accessible, son avis de situation Sirene en PDF.

Extrait du module utilisé dans Carezy. Cette première publication ne contient ni Firebase, ni données de comptes, ni clé API. Aucune dépendance à l’exécution.

## Démarrer

Node.js 22.18 ou plus récent et Bun pour les outils de développement.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run test
```

Le paquet n’est pas publié sur npm. Pour l’utiliser, construire ce dépôt puis importer son fichier compilé, ou installer une archive créée avec `npm pack` après construction.

```ts
import { normalizeSiret, retrieveSireneNotice } from './dist/index.js';

const siret = normalizeSiret(process.env.SIRET);
try {
  const { verification, pdf } = await retrieveSireneNotice(siret);
  console.log(verification.status);
  // pdf est un Buffer optionnel
} catch (error) {
  console.error('Source de vérification indisponible', error);
}
```

## Fonctions

- `normalizeSiret(value)` retire les espaces et renvoie une chaîne vide pour une valeur non textuelle
- `isSiretFormat(value)` vérifie uniquement la présence de 14 chiffres, sans contrôle de clé Luhn
- `parseSireneIdentification(siret, data)` analyse une réponse d’identification et vérifie l’établissement exact
- `retrieveSireneNotice(siret, fetcher?)` effectue la vérification et tente de récupérer le PDF

Les statuts retournés par la récupération sont `verified`, `inactive`, `not_found`, `manual_review` ou `invalid`. Le type partagé conserve aussi `pending`, `unavailable` et `missing` pour les applications qui gèrent leur propre suivi.

Les erreurs réseau, réponses inattendues et indisponibilités sont levées. Le client ne réessaie pas automatiquement. L’absence de PDF n’annule pas un résultat de vérification obtenu.

## Sources et limites

Le client utilise l’API des avis de situation Sirene de l’Insee, avec un repli vers l’[API Recherche d’entreprises](https://recherche-entreprises.api.gouv.fr/docs/) dans certains cas d’accès restreint. Le délai maximal est de 20 secondes par requête et la limite de lecture est de 5 Mio par réponse.

Ces services externes peuvent changer ou imposer des restrictions. Les tests utilisent des réponses simulées et des identifiants de démonstration ; leur succès ne garantit pas la disponibilité des services en production. Ce projet n’est pas affilié à l’Insee.

Un état administratif ne prouve ni l’identité d’un utilisateur, ni ses qualifications, ni ses droits d’exercer.

## Contribuer

```sh
bun run lint
bun run typecheck
bun run test
bun run build
```

Une correction doit inclure un test reproduisant le comportement concerné, sans donnée personnelle ni secret. Les changements de schéma des fournisseurs et les limites de lecture sont des sujets de contribution utiles.

## Licence

MIT, voir [LICENSE](LICENSE).
