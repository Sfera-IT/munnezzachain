# 0005. Consentire al pubblico solo foto scattate nell'app

**Status**: Proposed
**Date**: 2026-09-16
**Deciders**: Andrea Margiovanni (Claude come redattore)

## Context

Le foto dalla galleria hanno provenienza debole (EXIF spesso rimosso o alterato) e sono il canale più semplice per inviare materiale non pertinente: screenshot, documenti, immagini scaricate.

## Decision

Il pubblico può solo scattare con la fotocamera dell'app, con posizione GPS obbligatoria e solo in formato JPEG. Il caricamento dalla galleria è riservato agli operatori autenticati, e le loro foto sono marcate come "da galleria".

## Alternatives considered

- **Galleria aperta a tutti con avviso** — abbassa il valore probatorio e alza il rischio di abusi.
- **Galleria solo se l'EXIF contiene il GPS** — l'EXIF è falsificabile, e la foto potrebbe essere stata scaricata.

## Consequences

**Positive:**
- Più valore probatorio e meno superficie di abuso.

**Negative / obligations created:**
- Chi ha già scattato con la fotocamera del telefono deve rifare la foto sul posto.
- Serve un browser con `getUserMedia`; in mancanza si usa la fotocamera nativa, con controllo sulla freschezza del file.
