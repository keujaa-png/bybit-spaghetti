# Bybit Spaghetti

Spaghetti chart temps réel des perpétuels USDT de Bybit, complété par les perps Hyperliquid absents de Bybit, dont le volume 24h dépasse 5 M$.

**Page web :** https://keujaa-png.github.io/bybit-spaghetti/

## Graphique
- Données en direct (API REST + WebSocket publics de Bybit et Hyperliquid), historique chargé à l'ouverture
- Hyperliquid sans doublon : un coin déjà listé sur Bybit n'est pas repris (PEPE = kPEPE = 1000PEPE, PUMP = PUMPFUN), badge HL sinon
- Fenêtre 15 min → 24 h, courbes ancrées à 0 au début de la fenêtre
- Filtres : bullish uniquement, perf minimum (ex. fenêtre 4 h + perf min 5 %), masquer actions/métaux
- Plafond d'échelle pour le coin trop en avance (valeur réelle dans le label, marquée ⤒)
- Épaisseur des courbes proportionnelle au volume 24h

## Colonnes (clic sur l'en-tête pour trier)
| Colonne | Sens |
|---|---|
| Score | 0–100 : accélération 40 %, places gagnées 30 %, volume relatif 30 % ; −8 si funding ≥ 0,03 %, −20 si ≥ 0,08 % |
| Accél | gain du dernier 1/6 de la fenêtre moins le rythme moyen d'avant |
| Rang | places gagnées ou perdues sur la même durée |
| Vol× | volume des 15 dernières minutes ÷ moyenne des 4 h |
| Funding | funding ramené sur 8 h (Hyperliquid : horaire × 8) ; orange ≥ 0,03 %, rouge ≥ 0,08 % |

## Outils
- ★ épingle un coin (toujours affiché, en tête de liste)
- ↗ ouvre le coin sur TradingView (ou sur Hyperliquid pour les coins HL)
- Badge NEW pour les coins qui viennent de passer le seuil de volume
- Alertes (notification + son) si un coin gagne N places ou atteint un score donné, 1 par coin toutes les 15 min
- Réglages mémorisés dans le navigateur

**TradingView :** `bybit_spaghetti.pine` est la version indicateur (Pine v6, 40 coins max).

Outil d'analyse uniquement, pas un conseil financier.
