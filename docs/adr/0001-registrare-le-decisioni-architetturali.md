# 0001. Registrare le decisioni architetturali

**Status**: Proposed
**Date**: 2026-09-16
**Deciders**: Andrea Margiovanni (Claude come redattore)

## Context

Munnezzachain produce materiale destinato a procedimenti legali. Chi lo contesterà, o chi erediterà il codice, chiederà perché la catena di custodia è fatta così. Le ragioni si perdono se restano in una chat.

## Decision

Registreremo le decisioni significative come ADR in `docs/adr/`. Claude redige le bozze con stato `Proposed`; solo una persona le porta ad `Accepted` o `Rejected`.

## Alternatives considered

- **Nessuna documentazione delle decisioni** — le motivazioni di scelte probatorie vanno ricostruibili.
- **Wiki esterno** — si separa dal codice e non passa dalla revisione.

## Consequences

**Positive:**
- Il perché delle scelte è versionato insieme al codice che le implementa.

**Negative / obligations created:**
- Ogni decisione significativa richiede una bozza e una revisione umana.
