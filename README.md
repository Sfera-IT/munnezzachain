# Munnezzachain

Web app installabile (PWA) per segnalare problemi ambientali — rifiuti abbandonati, scarichi, emissioni, suoli contaminati — con foto la cui **posizione, ora e integrità** restano verificabili fino al rapporto legale.

Nasce da un problema concreto: le foto mandate per email o chat perdono il GPS, e l'EXIF che sopravvive è comunque modificabile. Qui non ci si fida del file che arriva: la foto si scatta nell'app, che registra la posizione del telefono e sigilla il file con un'impronta prima dell'invio.

## Come funziona

- **Scatto in app**: fotocamera e GPS del telefono letti nello stesso istante, EXIF scritto dall'app, SHA-256 calcolato sul dispositivo.
- **Invio verificato**: il server ricalcola l'impronta e rifiuta file alterati in transito. Senza rete, la segnalazione resta in coda e parte da sola.
- **Catena di impronte**: ogni segnalazione è un anello legato al precedente; una modifica a posteriori rompe la catena.
- **Marca temporale RFC 3161** sull'impronta di ogni anello, verificabile con `openssl`.
- **Moderazione**: le segnalazioni del pubblico restano in quarantena finché un amministratore non le accetta; quelle rifiutate vengono distrutte, lasciando solo l'impronta.
- **Archivio non modificabile** (R2 bucket lock) per il materiale accettato, con dati in UE.
- **Pannello operatori**: mappa, avvisi di incongruenza, stato di lavorazione, registro accessi, export GeoJSON/CSV e pacchetto probatorio ZIP con istruzioni di verifica.
- **Verifica pubblica**: chiunque può controllare se un file è registrato, calcolando l'impronta sul proprio dispositivo.

Il pubblico può solo scattare con l'app; gli operatori possono anche caricare dalla galleria, con avvisi sulla provenienza.

## Documentazione

- [La catena di custodia e come verificarla](docs/catena.md)
- [Deploy e configurazione](docs/deploy.md)
- [Decisioni architetturali](docs/adr/README.md)

## Struttura

```
src/shared/   EXIF, impronte, modello dati e catena (usati da browser e Worker)
src/worker/   API su Cloudflare Workers (Hono), D1, R2, marca temporale
src/web/      PWA senza framework, service worker, viste
migrations/   schema D1 con trigger che impediscono modifiche ai dati probatori
scripts/      build, icone, creazione amministratore, smoke test end-to-end
test/         test unitari (vitest)
```

## Comandi

```sh
npm run dev         # build di sviluppo + wrangler dev
npm test            # test unitari
npm run typecheck   # tipi di Worker, PWA e service worker
npm run deploy      # controlli, build versionata e deploy
```

## Limiti

La catena dimostra che nulla è stato alterato dallo scatto in poi e quando la segnalazione è stata registrata. Non può dimostrare che il telefono non fosse manomesso. Per una perizia certificata esistono servizi di acquisizione forense dedicati.
