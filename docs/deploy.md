# Deploy e configurazione

## Risorse Cloudflare

| Risorsa | Nome | Note |
|---|---|---|
| Worker | `munnezzachain` | serve PWA e API; cron ogni 10 minuti |
| D1 | `munnezzachain` | giurisdizione `eu` |
| R2 | `munnezzachain-evidence` | giurisdizione `eu`, blocco di conservazione sui prefissi dell'archivio |
| Turnstile | widget `munnezzachain` | modalità managed, domini `munnezzachain.margiovanni.it` e `munnezzachain.soapboxmargio.workers.dev` |
| Rate limiting | `PUBLIC_SUBMIT_LIMITER`, `LOGIN_LIMITER` | 5 invii e 10 login al minuto per IP |

Produzione: https://munnezzachain.margiovanni.it

## Primo deploy

```sh
npm install
npm run db:migrate:remote
npm run deploy
node scripts/create-admin.ts tua@email.it "Nome Cognome"
```

`npm run deploy`:
1. rifiuta modifiche non committate;
2. esegue controllo dei tipi, test unitari e build della PWA;
3. pubblica il Worker con `APP_VERSION` uguale alla versione della PWA.

Gli end-to-end non sono nel deploy: girano su GitHub Actions a ogni push, e conviene aspettarne l'esito. Le migrazioni del database vanno applicate a mano con `npm run db:migrate:remote` **prima** del deploy che le usa.

## Blocco di conservazione (R2 bucket lock)

L'archivio probatorio non è modificabile solo se queste regole esistono. **Non** va mai bloccato il prefisso `quarantena/`: lì i contenuti illeciti devono poter essere cancellati.

```sh
for p in originals/ derived/ manifests/ tsa/; do
  npx wrangler r2 bucket lock add munnezzachain-evidence "conserva-${p%/}" "$p" --retention-days 3650 -J eu -y
done
npx wrangler r2 bucket lock list munnezzachain-evidence -J eu
```

In produzione sono attive tutte e quattro. La durata (10 anni) è una decisione del titolare del trattamento: deve coprire i tempi dei procedimenti ed essere scritta nell'informativa.

Il blocco impedisce anche di **sovrascrivere** un file. Il codice ne tiene conto: gli spostamenti in archivio controllano l'impronta di un file già presente invece di riscriverlo, e ogni marca temporale ha un nome proprio.

## Cloudflare Turnstile

Login e invii pubblici richiedono un token Turnstile ([ADR 0007](adr/0007-turnstile-su-login-e-segnalazioni-pubbliche.md)).

- La chiave pubblica è in `wrangler.jsonc` → `TURNSTILE_SITE_KEY`, ed è esposta all'app da `/api/config`.
- La chiave segreta è un secret del Worker: `npx wrangler secret put TURNSTILE_SECRET_KEY`.
- Senza segreto la verifica è disattivata e l'app non carica il widget: è il caso di `npm run dev` in locale.

**Nuovo dominio.** Aggiungerlo all'elenco dei domini del widget nella dashboard Cloudflare (Turnstile → munnezzachain), altrimenti il widget fallisce su quel dominio.

**Rotazione della chiave segreta.**
1. Dashboard Cloudflare → Turnstile → widget munnezzachain → rotazione della chiave segreta.
2. `npx wrangler secret put TURNSTILE_SECRET_KEY` con il nuovo valore.

Cloudflare lascia valida la chiave vecchia per un breve periodo di transizione: fare il secondo passo subito dopo il primo.

**Attenzione all'ordine.** Se si imposta il segreto su un Worker la cui PWA non ha ancora la chiave pubblica, gli invii pubblici vengono rifiutati finché non si pubblica la nuova versione: impostare prima la chiave pubblica e fare il deploy.

## Configurazione

Variabili in `wrangler.jsonc` → `vars`:

| Variabile | Uso |
|---|---|
| `TSA_URL` | Time Stamping Authority RFC 3161. `https://freetsa.org/tsr` per il pilota. Vuoto = marca temporale disattivata. |
| `PUBLIC_AREA_BBOX` | `minLon,minLat,maxLon,maxLat`: rifiuta segnalazioni pubbliche fuori area. Vuoto = ovunque. |
| `PRIVACY_CONTACT` | Titolare e contatti mostrati nell'informativa. |
| `TURNSTILE_SITE_KEY` | Chiave pubblica Turnstile. |

Segreti (`npx wrangler secret put NOME`):

| Segreto | Uso |
|---|---|
| `TURNSTILE_SECRET_KEY` | Chiave segreta Turnstile. |
| `TSA_USERNAME`, `TSA_PASSWORD` | Credenziali di una TSA qualificata eIDAS (InfoCert, Aruba, Namirial…). |

## Lavori periodici

Il cron (`*/10 * * * *`) riprova le marche temporali, completa gli spostamenti in archivio interrotti, svuota la quarantena delle segnalazioni rifiutate, cancella i file di invii mai registrati e le sessioni scadute. Dettagli in [Sicurezza e robustezza](sicurezza.md#operazioni-interrotte).

In locale il cron non parte da solo:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

## Prima dell'apertura al pubblico

- [ ] Informativa privacy completata dal titolare (`src/web/views/privacy.ts`) e `PRIVACY_CONTACT` impostato.
- [x] Regole di bucket lock attive su `originals/`, `derived/`, `manifests/`, `tsa/`.
- [x] Turnstile attivo su login e invii pubblici.
- [ ] TSA qualificata al posto di FreeTSA, se serve valore legale pieno.
- [ ] `PUBLIC_AREA_BBOX` impostato sull'area del cliente.
- [ ] Procedura interna per il materiale illecito trovato in moderazione.
- [ ] Almeno un amministratore che moderi con continuità.
- [ ] Solo il dominio personalizzato: `workers_dev: false` in `wrangler.jsonc`.
- [ ] Area operatori dietro Cloudflare Access, o comunque un secondo fattore per gli amministratori.
- [ ] Nomina di Cloudflare a responsabile del trattamento (DPA) nel registro del titolare, citando anche Turnstile.

## Sviluppo locale

```sh
npm run db:migrate:local
node scripts/create-admin.ts admin@example.test "Admin Locale" --local
npm run dev                       # http://localhost:8787
```

In locale `TURNSTILE_SECRET_KEY` non è impostato, quindi la verifica è spenta e il widget di produzione, che su `localhost` non funzionerebbe, non viene caricato. Per provarla, crea `.dev.vars` (ignorato da git, e i suoi valori prevalgono su `wrangler.jsonc`) con le chiavi di prova di Cloudflare, che passano sempre:

```sh
TURNSTILE_SITE_KEY=1x00000000000000000000BB
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

La fotocamera e la posizione richiedono HTTPS o `localhost`.

## Test

| Comando | Cosa verifica |
|---|---|
| `npm run typecheck` | tipi di Worker, PWA e service worker |
| `npm test` | EXIF (anche su file scritti da exiftool), impronte, catena, marca temporale RFC 3161 su una risposta reale di FreeTSA verificata con `openssl`, ZIP (anche in streaming), password, validazione degli invii, trigger del database (compresa la gara tra accettazione e rifiuto) |
| `npm run test:e2e` | avvia un'istanza locale isolata e prova API e browser: Turnstile su login e invii, invio con fotocamera e GPS, file alterati, reinvii, limiti di dimensione, permessi, moderazione e decisioni contemporanee, rifiuto, pacchetto probatorio, catena, export, coda offline, app senza rete, aggiornamenti della PWA, accessibilità WCAG 2.2 AA con axe |

Gli end-to-end richiedono Chrome o Chromium (`CHROME_PATH` se non viene trovato) e la rete verso `challenges.cloudflare.com`: il widget Turnstile è quello vero, con le chiavi di prova. La marca temporale invece è disattivata nell'istanza di test ed è coperta dai test unitari.

Su GitHub il workflow `.github/workflows/test.yml` esegue tutto a ogni push su `main` e a ogni pull request.
