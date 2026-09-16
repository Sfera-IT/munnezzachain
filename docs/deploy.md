# Deploy e configurazione

## Risorse Cloudflare

| Risorsa | Nome | Note |
|---|---|---|
| Worker | `munnezzachain` | serve PWA e API |
| D1 | `munnezzachain` | giurisdizione `eu` |
| R2 | `munnezzachain-evidence` | giurisdizione `eu` |

## Primo deploy

```sh
npm install
npm run db:migrate:remote
npm run deploy
node scripts/create-admin.ts tua@email.it "Nome Cognome"
```

`npm run deploy` esegue controllo dei tipi, test e build, poi pubblica il Worker con `APP_VERSION` uguale alla versione della PWA.

## Blocco di conservazione (R2 bucket lock)

L'archivio probatorio non è modificabile solo se queste regole esistono. **Non** va mai bloccato il prefisso `quarantena/`: lì i contenuti illeciti devono poter essere cancellati.

```sh
for p in originals/ derived/ manifests/ tsa/; do
  npx wrangler r2 bucket lock add munnezzachain-evidence "conserva-${p%/}" "$p" --retention-days 3650 -J eu -y
done
npx wrangler r2 bucket lock list munnezzachain-evidence -J eu
```

La durata (10 anni in questo esempio) è una decisione del titolare del trattamento: deve coprire i tempi dei procedimenti ed essere scritta nell'informativa.

## Configurazione

Variabili in `wrangler.jsonc` → `vars`:

| Variabile | Uso |
|---|---|
| `TSA_URL` | Time Stamping Authority RFC 3161. `https://freetsa.org/tsr` per il pilota. |
| `PUBLIC_AREA_BBOX` | `minLon,minLat,maxLon,maxLat`: rifiuta segnalazioni pubbliche fuori area. Vuoto = ovunque. |
| `PRIVACY_CONTACT` | Titolare e contatti mostrati nell'informativa. |
| `TURNSTILE_SITE_KEY` | Chiave pubblica Cloudflare Turnstile (anti-spam). Vuoto = disattivato. |

Segreti (`npx wrangler secret put NOME`):

| Segreto | Uso |
|---|---|
| `TSA_USERNAME`, `TSA_PASSWORD` | Credenziali di una TSA qualificata eIDAS (InfoCert, Aruba, Namirial…). |
| `TURNSTILE_SECRET_KEY` | Chiave segreta Turnstile. |

## Prima dell'apertura al pubblico

- [ ] Informativa privacy completata dal titolare (`src/web/views/privacy.ts`) e `PRIVACY_CONTACT` impostato.
- [ ] Regole di bucket lock attive (vedi sopra).
- [ ] TSA qualificata al posto di FreeTSA, se serve valore legale pieno.
- [ ] Turnstile attivato.
- [ ] `PUBLIC_AREA_BBOX` impostato sull'area del cliente.
- [ ] Procedura interna per il materiale illecito trovato in moderazione.
- [ ] Almeno un amministratore che moderi con continuità.
- [ ] Dominio personalizzato al posto di `workers.dev`.

## Sviluppo locale

```sh
npm run db:migrate:local
node scripts/create-admin.ts admin@example.test "Admin Locale" --local
npm run dev                       # http://localhost:8787
node scripts/smoke.ts http://localhost:8787 admin@example.test <password>
```

La fotocamera e la posizione richiedono HTTPS o `localhost`.
