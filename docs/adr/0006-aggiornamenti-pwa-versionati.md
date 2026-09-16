# 0006. Versionare ogni build della PWA e aggiornare senza perdere lavoro

**Status**: Proposed
**Date**: 2026-09-16
**Deciders**: Andrea Margiovanni (Claude come redattore)

## Context

La PWA gira offline con un service worker. Senza versioni esplicite i browser possono restare su una copia vecchia per giorni. Ricaricare la pagina in automatico, però, cancellerebbe le foto di una segnalazione in compilazione.

## Decision

Ogni build ha una versione (data e commit) inserita in app, `sw.js`, `index.html` e nel Worker (header `x-app-version`). Gli asset hanno nomi con hash e cache immutabile; `index.html` e `sw.js` sono `no-cache`. Il nuovo service worker resta in attesa: l'app mostra un avviso e lo attiva su richiesta, o da sola quando va in background e non c'è lavoro in corso.

## Alternatives considered

- **`skipWaiting` immediato con ricarica** — rischia di perdere foto non ancora salvate in coda.
- **Nessun service worker** — niente funzionamento offline sui sentieri.

## Consequences

**Positive:**
- Ogni deploy arriva ai browser; le cache vecchie vengono eliminate.

**Negative / obligations created:**
- Si deploya sempre con `npm run deploy`, che imposta la versione anche sul Worker.
