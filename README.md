# Bybit Spaghetti

Spaghetti chart temps réel des perpétuels USDT de Bybit dont le volume 24h dépasse 5 M$.

**Page web :** https://keujaa-png.github.io/bybit-spaghetti/

- Données en direct (API REST + WebSocket publics de Bybit), historique chargé à l'ouverture
- Fenêtre 15 min → 24 h, courbes ancrées à 0 au début de la fenêtre
- Filtre « bullish uniquement » et perf minimum
- Plafond d'échelle pour le coin trop en avance (sa vraie valeur reste dans le label, marquée ⤒)
- Colonnes **Accél** (gain récent vs rythme moyen) et **Rang** (places gagnées ou perdues) pour repérer les coins qui accélèrent
- Option pour masquer les perps d'actions et de métaux

**TradingView :** `bybit_spaghetti.pine` est la version indicateur (Pine v6, 40 coins max). À coller dans l'éditeur Pine puis « Ajouter au graphique ».

Outil d'analyse uniquement, pas un conseil financier.
