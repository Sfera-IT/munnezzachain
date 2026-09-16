# 0002. Ospitare su Cloudflare Workers, D1 e R2 con dati nell'Unione Europea

**Status**: Proposed
**Date**: 2026-09-16
**Deciders**: Andrea Margiovanni (Claude come redattore)

## Context

Serve un servizio piccolo, sempre raggiungibile da telefono, senza server da mantenere. Tratta dati personali (posizione di chi segnala, eventuali volti e targhe), quindi la localizzazione dei dati conta ai fini GDPR. Le foto accettate devono essere conservate in modo non modificabile.

## Decision

Useremo un unico Cloudflare Worker che serve la PWA e l'API, D1 per i metadati e la catena, R2 per foto, manifest e marche temporali. Database e bucket sono creati con giurisdizione `eu`.

## Alternatives considered

- **VPS con Laravel/PostgreSQL** — richiede patching, backup e monitoraggio di un server per un servizio a basso traffico.
- **Supabase/Firebase** — localizzazione e blocco WORM dello storage meno diretti; nessun vantaggio sul caso d'uso.
- **Cloudflare senza giurisdizione UE** — i dati potrebbero risiedere fuori dall'UE.

## Consequences

**Positive:**
- Nessun server da gestire; HTTPS, rate limiting e cron inclusi.
- R2 supporta regole di blocco (bucket lock) per la conservazione non modificabile.

**Negative / obligations created:**
- Dipendenza da un fornitore: serve una nomina a responsabile del trattamento (DPA Cloudflare) nel registro del titolare.
- D1 è SQLite: la concorrenza sulla catena è gestita con retry ottimistico, adeguato a volumi bassi.
