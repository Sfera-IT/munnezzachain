# 0003. Garantire l'integrità con scatto in app, catena di impronte e marca temporale RFC 3161

**Status**: Proposed
**Date**: 2026-09-16
**Deciders**: Andrea Margiovanni (Claude come redattore)

## Context

Le foto devono documentare posizione e ora per rapporti con valore legale. Gmail, Outlook e i selettori foto di iOS/Android rimuovono il GPS dall'EXIF; e l'EXIF, anche quando arriva, è modificabile a mano. Il problema non è la conservazione ma la catena dal sensore all'archivio.

## Decision

Non ci fideremo dell'EXIF in arrivo. La PWA scatta la foto, legge il GPS del dispositivo in quel momento, scrive EXIF e calcola lo SHA-256 prima dell'invio; il server rifiuta file la cui impronta non coincide. Ogni segnalazione ha un manifest (JSON canonico) incatenato alla precedente tramite hash, e l'impronta dell'anello riceve una marca temporale RFC 3161 da una TSA terza.

## Alternatives considered

- **Chiedere agli utenti di inviare i file "come allegato"** — dipende dal client di posta, fallisce silenziosamente, ed è comunque manipolabile.
- **Cartella condivisa (Drive/OneDrive/Nextcloud)** — preserva i byte ma non prova né quando né dove è stata fatta la foto.
- **Blockchain pubblica** — costo e complessità senza risolvere il vero punto debole (il dispositivo); la marca temporale RFC 3161 dà una data certa opponibile con strumenti standard.
- **Prodotto certificato (es. TrueScreen)** — valore legale maggiore, ma costo e dipendenza; resta l'opzione se serve una perizia certificata.

## Consequences

**Positive:**
- Qualsiasi alterazione dopo lo scatto è rilevabile; la verifica usa solo `shasum` e `openssl ts -verify`.
- Le incongruenze (GPS impreciso, orologio avanti, foto da galleria, software di fotoritocco) sono segnalate all'operatore invece di essere nascoste.

**Negative / obligations created:**
- Non prova in assoluto il luogo: un telefono manomesso può falsificare la posizione del browser.
- FreeTSA va bene per il pilota; per il valore legale serve una TSA qualificata eIDAS (a pagamento).
- La formula dell'anello (`docs/catena.md`) non si cambia senza una nuova versione della catena.
