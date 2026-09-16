# 0004. Mettere in quarantena e moderare le segnalazioni del pubblico

**Status**: Proposed
**Date**: 2026-09-16
**Deciders**: Andrea Margiovanni (Claude come redattore)

## Context

Chiunque può inviare foto. Qualcuno invierà materiale illecito (anche pedopornografico), documenti o foto di persone estranee. L'archivio probatorio è non modificabile, ma il materiale illecito deve poter essere distrutto.

## Decision

Le segnalazioni del pubblico vanno in un'area di quarantena senza blocco di conservazione, visibile solo agli amministratori con anteprime sfocate. Se un amministratore accetta, i file passano ai prefissi protetti da bucket lock. Se rifiuta, file, testo e posizione vengono cancellati; nella catena restano solo le impronte e il motivo. Le segnalazioni degli operatori autenticati non passano dalla quarantena.

## Alternatives considered

- **Nessuna moderazione, accesso limitato agli operatori** — il materiale illecito resterebbe comunque conservato e non cancellabile.
- **Blocco di conservazione su tutto dall'arrivo** — impedirebbe di distruggere contenuti illeciti.
- **Filtro automatico con modello di classificazione** — non affidabile per decidere; al massimo un aiuto futuro alla moderazione.

## Consequences

**Positive:**
- Il danno da abusi è limitato e la catena resta verificabile anche dopo un rifiuto.
- Il database impedisce con trigger ogni modifica a dati probatori, tranne la cancellazione al momento del rifiuto.

**Negative / obligations created:**
- Serve una persona che moderi con continuità; il backlog va monitorato.
- Serve una procedura interna, concordata con un legale, per segnalare alle autorità il materiale illecito.
- Le regole di bucket lock su R2 vanno configurate sui prefissi `originals/`, `derived/`, `manifests/`, `tsa/` e mai su `quarantena/`.
