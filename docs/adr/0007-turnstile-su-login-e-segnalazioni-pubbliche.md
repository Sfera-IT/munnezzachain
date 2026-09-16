# 0007. Proteggere login e segnalazioni pubbliche con Cloudflare Turnstile

**Status**: Proposed
**Date**: 2026-09-16
**Deciders**: Andrea Margiovanni (Claude come redattore)

## Context

Le segnalazioni devono poter arrivare da chiunque: escursionisti, turisti, collaboratori senza un account dell'ente. Il canale pubblico quindi resta aperto e senza registrazione, con la quarantena dell'ADR 0004. Un canale anonimo attira però invii automatici, e ogni invio accettato occupa spazio non cancellabile e tempo di moderazione.

Il login degli operatori era protetto solo da un limite di 10 tentativi al minuto per indirizzo IP. Il limitatore di Cloudflare è approssimato e vale per singolo data center: un attacco distribuito su molti indirizzi prova password senza esserne rallentato.

## Decision

Ogni richiesta di login e ogni invio da chi non è un operatore attivo porta un token Cloudflare Turnstile. Il Worker lo verifica prima di controllare la password o di leggere le foto. Il widget è in modalità "managed": invisibile quasi sempre, chiede un clic solo quando Cloudflare ha dubbi.

L'app chiede il token al momento dell'invio vero, non alla compilazione, perché scade dopo pochi minuti e le segnalazioni possono restare in coda offline. Se la verifica fallisce o il widget non si carica per mancanza di rete, la segnalazione resta in coda e si riprova.

Il login resta obbligatorio solo per operatori e amministratori.

## Alternatives considered

- **Login obbligatorio anche per chi segnala** — scartato: esclude turisti e collaboratori esterni, che sono il motivo per cui il servizio esiste.
- **Registrazione con link via email per chi segnala** — identifica chi invia, ma aggiunge attrito sul sentiero, un fornitore di email e un dato personale in più per ogni segnalazione.
- **Solo limite per IP** — non ferma chi distribuisce le richieste; e sulle reti mobili molti utenti legittimi condividono lo stesso IP.
- **CAPTCHA di terze parti (reCAPTCHA, hCaptcha)** — un altro fornitore e un altro trasferimento di dati; Turnstile è già dentro l'infrastruttura Cloudflare scelta con l'ADR 0002.

## Consequences

**Positive:**
- Gli invii automatici e il tentativo distribuito di password vengono fermati prima di toccare database e archivio.
- Nessun account richiesto al pubblico.

**Negative / obligations created:**
- Turnstile tratta l'indirizzo IP e dati tecnici del browser per conto del titolare: va citato nell'informativa e nel registro dei trattamenti.
- Senza rete verso `challenges.cloudflare.com` non si fa login e non partono invii pubblici; le segnalazioni restano in coda.
- Chi usa browser molto restrittivi o automatizzati può essere bloccato.
- La chiave segreta è un secret del Worker (`TURNSTILE_SECRET_KEY`) e va ruotata se esposta. Gli end-to-end usano le chiavi di prova di Cloudflare e hanno bisogno della rete.
