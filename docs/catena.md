# La catena di custodia

Questo documento descrive esattamente cosa viene sigillato e come verificarlo senza fidarsi del servizio.
Se lo si cambia, cambia il significato di ogni prova già registrata: serve una nuova versione della catena e un ADR.

## 1. Dallo scatto all'invio (telefono)

1. La PWA scatta la foto con la fotocamera del telefono (`getUserMedia`), non con un file già esistente.
2. Nello stesso istante legge la posizione dal GPS del dispositivo (`watchPosition`, alta precisione, nessuna cache) e scarta fix più vecchi di 60 secondi.
3. Codifica il JPEG e vi scrive l'EXIF: `DateTimeOriginal` e `OffsetTimeOriginal`, blocco GPS (latitudine, longitudine, altitudine, `GPSHPositioningError` = precisione in metri, data e ora UTC del fix), `Software = munnezzachain PWA`.
4. Calcola lo SHA-256 del file finale. Da qui il file non viene più toccato.
5. Segnalazione e foto vengono salvate in IndexedDB **prima** di qualsiasi invio: se la rete manca, partono più tardi.

## 2. Ricezione (server)

1. Il server ricalcola lo SHA-256 di ogni foto e lo confronta con quello dichiarato dal telefono. Se differisce, la segnalazione viene rifiutata.
2. Legge l'EXIF e calcola gli avvisi (posizione imprecisa o assente, fix lontano dallo scatto, GPS dell'EXIF diverso da quello dichiarato, blocco GPS azzerato, software di fotoritocco, orologio avanti, invio ritardato).
3. Costruisce il **manifest**: un JSON con chiavi ordinate e senza spazi (vedi `canonicalJson` in `src/shared/bytes.ts`) che contiene codice, ora di ricezione, canale, categoria, descrizione e, per ogni foto, impronta, dimensione, provenienza, ora di scatto, posizione, EXIF letto, avvisi. Il recapito di chi segnala **non** è nel manifest.
4. Calcola l'impronta del manifest e aggiunge un anello alla catena.

## 3. L'anello

```
entryHash = SHA-256( "munnezzachain/v1|" + seq + "|" + prevHash + "|" + manifestSha256 + "|" + receivedAt )
```

- `seq`: numero progressivo dell'anello, da 1.
- `prevHash`: `entryHash` dell'anello precedente; per il primo, 64 zeri.
- `manifestSha256`: SHA-256 dei byte del manifest.
- `receivedAt`: ora di ricezione del server, ISO 8601 UTC con millisecondi.

Tutti i valori esadecimali sono minuscoli. La stringa è codificata UTF-8, senza a capo finale.

Verifica di un anello:

```sh
printf '%s' 'munnezzachain/v1|1|0000…0000|<manifestSha256>|2026-09-16T11:14:51.000Z' | shasum -a 256
```

Modificare una segnalazione passata cambierebbe il suo `manifestSha256`, quindi il suo `entryHash`, quindi il `prevHash` di tutti gli anelli successivi.

## 4. Marca temporale

Subito dopo la registrazione, `entryHash` viene inviato a una Time Stamping Authority (RFC 3161). La risposta firmata (`.tsr`) è archiviata e attesta che quell'impronta esisteva in quel momento. Se la TSA non risponde, un cron riprova ogni 10 minuti.

```sh
openssl ts -verify -digest <entryHash> -in marca-temporale.tsr -CAfile cacert.pem -untrusted tsa.crt
```

Per FreeTSA i certificati sono su https://freetsa.org/files/cacert.pem e https://freetsa.org/files/tsa.crt.

## 5. Moderazione

Le segnalazioni del pubblico restano in quarantena. Se accettate, la decisione viene registrata per prima e solo dopo i file passano sotto prefissi di R2 protetti da blocco di conservazione: un rifiuto concorrente non può lasciare copie non cancellabili. Uno spostamento interrotto viene completato dal cron, che rimuove anche i file di invii mai arrivati nel database. Se rifiutate, file, testo e posizione vengono distrutti, ma l'anello resta: la catena continua a verificarsi, e il manifest rifiutato risulta "contenuto rimosso".

## 6. Copie con GPS

Se una foto accettata non ha il GPS nell'EXIF (per esempio una foto da galleria posizionata a mano da un operatore), il server genera una **copia** con il GPS scritto, utile per importarla in una mappa. La copia non sostituisce l'originale: nel campo `ImageDescription` riporta l'impronta dell'originale, e la sua impronta è registrata nel manifest.

## 7. Cosa la catena non dimostra

- Che il telefono non fosse manomesso: un dispositivo compromesso può falsificare la posizione del browser.
- Che la scena non fosse allestita.

La catena dimostra che **dal momento dello scatto nell'app, niente è stato alterato**, e quando la segnalazione è stata registrata.

## 8. Ancoraggio esterno

Per rendere evidente anche una riscrittura dell'intera catena da parte di chi gestisce il servizio, pubblicare periodicamente l'impronta dell'ultimo anello (`GET /api/verifica/testa`) fuori dal sistema: sito istituzionale, PEC a sé stessi, protocollo.
