# Sicurezza e robustezza

Cosa protegge il servizio, con quali controlli, e cosa resta scoperto. Per l'integrità delle prove vedi [La catena di custodia](catena.md); per la configurazione, [Deploy e configurazione](deploy.md).

## Chi usa il servizio

| Ruolo | Accesso | Può |
|---|---|---|
| Pubblico | nessun account | scattare foto nell'app e inviare segnalazioni (in quarantena), verificare un'impronta |
| Operatore | account creato dall'admin | vedere e lavorare le segnalazioni accettate, inviare segnalazioni anche da galleria, esportare |
| Amministratore | account creato dall'admin | tutto quello dell'operatore, più moderare, gestire gli utenti, verificare la catena |

## Controlli

### Abusi e invii automatici
- **Cloudflare Turnstile** su ogni login e su ogni invio di chi non è un operatore attivo ([ADR 0007](adr/0007-turnstile-su-login-e-segnalazioni-pubbliche.md)). Il token è verificato dal Worker prima di controllare la password o di leggere le foto.
- **Limiti per indirizzo IP**: 5 invii pubblici e 10 tentativi di login al minuto.
- **Dimensione**: al massimo 10 foto, 20 MB ciascuna e 60 MB in tutto. Il limite complessivo è controllato sull'header `Content-Length` prima di leggere il corpo, perché un Worker ha 128 MB di memoria.
- **Solo scatto in app per il pubblico**, solo JPEG, GPS obbligatorio, eventualmente limitato a un'area (`PUBLIC_AREA_BBOX`).

### Contenuti illeciti
- Le segnalazioni del pubblico restano in quarantena, in un prefisso di R2 senza blocco, finché un amministratore non decide ([ADR 0004](adr/0004-quarantena-e-moderazione-delle-segnalazioni-pubbliche.md)). Le immagini in moderazione sono sfocate.
- **La moderazione è atomica.** L'accettazione registra prima la decisione nel database e solo dopo copia i file nell'archivio bloccato. Se nello stesso istante un altro amministratore rifiuta, vince chi arriva primo: un contenuto rifiutato non finisce mai in un prefisso non cancellabile.
- Il rifiuto cancella file, testo, posizione, recapito, browser e paese; restano le impronte nella catena.

### Accesso e sessioni
- Password PBKDF2-SHA256 (100.000 iterazioni, il massimo dei Workers), almeno 12 caratteri. Le password provvisorie generate dall'admin vanno cambiate prima di vedere qualsiasi dato.
- Sessioni con token casuale da 256 bit, conservato nel database solo come impronta SHA-256. Cookie `HttpOnly`, `Secure`, `SameSite=Strict`, durata 30 giorni. Cambiare password chiude le altre sessioni; disattivare un utente le chiude tutte.
- Il login ha lo stesso costo per email esistenti, inesistenti e disattivate, così il tempo di risposta non rivela quali account esistono. Il registro accessi non conserva le email digitate che non corrispondono a un account.
- Le richieste che modificano dati da un'altra origine sono rifiutate (controllo dell'header `Origin`, oltre a `SameSite`).
- Gli operatori non vedono le segnalazioni in quarantena né il browser di chi ha segnalato.

### Browser
- Content Security Policy restrittiva: script solo dal sito e da `challenges.cloudflare.com`, nessun frame altrui salvo Turnstile, `frame-ancestors 'none'`.
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` limitata a fotocamera e posizione.
- L'interfaccia costruisce il DOM con nodi di testo: descrizioni ed EXIF inviati dal pubblico non vengono mai interpretati come HTML.
- L'export CSV neutralizza le celle che un foglio di calcolo eseguirebbe come formule.

### Integrità e conservazione
- Trigger del database impediscono modifiche e cancellazioni di catena, foto, dati probatori e registro accessi.
- Blocco di conservazione R2 di 10 anni su `originals/`, `derived/`, `manifests/`, `tsa/`.
- Marca temporale RFC 3161 su ogni anello. Ogni tentativo scrive un file suo (il prefisso bloccato non si sovrascrive) e una marca già ottenuta non viene mai sostituita.

### Operazioni interrotte
Il cron, ogni 10 minuti:
- riprova le marche temporali in errore o rimaste in attesa da più di 5 minuti;
- completa lo spostamento in archivio delle segnalazioni accettate se la richiesta si era interrotta;
- svuota la quarantena delle segnalazioni rifiutate;
- cancella i file di invii mai arrivati nel database, trascorsa un'ora;
- elimina le sessioni scadute.

## Cosa non è coperto

- **Dispositivo manomesso.** Un telefono compromesso può falsificare posizione e ora del browser. La catena dimostra che nulla è cambiato dopo lo scatto, non che la scena fosse autentica.
- **Chi gestisce il servizio.** Chi ha accesso all'account Cloudflare può riscrivere l'intera catena. Contromisura: pubblicare periodicamente l'impronta dell'ultimo anello fuori dal sistema ([catena](catena.md#8-ancoraggio-esterno)).
- **Secondo fattore.** Gli account non hanno autenticazione a due fattori. Per gli amministratori è consigliabile mettere l'area operatori dietro Cloudflare Access.
- **Piano Cloudflare.** Sul piano gratuito un Worker può fare 50 chiamate a servizi per richiesta: un'accettazione con 10 foto o un pacchetto ZIP completo ci si avvicinano.
- **Volumi.** La pulizia della quarantena esamina fino a 1000 segnalazioni per esecuzione; la verifica completa della catena procede a lotti di 25 anelli.

## Segnalare una vulnerabilità

Scrivere al titolare del trattamento indicato nell'informativa, senza aprire una issue pubblica.
