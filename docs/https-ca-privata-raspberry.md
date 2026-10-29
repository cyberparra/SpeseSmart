# HTTPS con CA privata

Eseguire l'emissione su un computer fidato, fuori dal repository. La chiave CA
rimane cifrata su quel computer; sul server vanno solo `ca.crt`, `server.crt` e
`server.key`. Impostare il proprio IP stabile e scegliere una directory nuova:

```sh
umask 077
IP_LAN=192.168.1.50
PKI_DIR="$HOME/spesesmart-pki"
mkdir -m 0700 "$PKI_DIR"
cd "$PKI_DIR"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc -out ca.key
openssl req -new -x509 -key ca.key -sha256 -days 3650 -subj '/CN=SpeseSmart private root' -out ca.crt \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' -addext 'subjectKeyIdentifier=hash'
openssl req -new -newkey rsa:3072 -noenc -keyout server.key -out server.csr -subj '/CN=SpeseSmart server'
cat > leaf.cnf <<EOF_TLS
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$IP_LAN
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF_TLS
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 90 -sha256 -extfile leaf.cnf -out server.crt
openssl verify -CAfile ca.crt -x509_strict -purpose sslserver -verify_ip "$IP_LAN" server.crt
openssl x509 -in ca.crt -noout -fingerprint -sha256
chmod 0600 ca.crt server.crt server.key
scp ca.crt server.crt server.key "spesesmart@$IP_LAN:"
```

Conservare l'impronta completa in `caSHA256` di `/etc/spesesmart/pi.json`,
confrontandola tramite un canale fidato. Dal terminale del server, come utente
`spesesmart` (directory `/srv/spesesmart/tls` già predisposta dal README):

```sh
umask 077
mkdir -m 0700 /srv/spesesmart/tls/current
install -m 0600 "$HOME/ca.crt" "$HOME/server.crt" "$HOME/server.key" /srv/spesesmart/tls/current/
cd /srv/spesesmart/app
export SPESESMART_PI_TLS_DIR=/srv/spesesmart/tls/current
# Sostituire con il pin completo osservato sul computer di emissione:
export SPESESMART_PI_TLS_CA_SHA256=IMPRONTA_SHA256_PROPRIA
npm run pi:tls:check -- 192.168.1.50
```

Usare l'IP proprio anche nell'ultimo comando. Il controllo offline verifica
catena diretta, SAN, date, usi, chiave, pin e permessi. La directory deve essere
reale (nessun symlink) e contenere soltanto i tre file previsti. La chiave CA
non deve mai essere copiata sul server. Non viene installata fiducia di sistema.

Distribuire ai client soltanto `ca.crt`, confrontarne l'impronta su un canale
indipendente e importarla nelle autorità attendibili del browser/dispositivo.
Su Android: Sicurezza → Crittografia e credenziali → Installa certificato CA;
i nomi dipendono dalla versione. Non ignorare gli errori TLS.

La leaf scade dopo 90 giorni: prima della scadenza fermare il servizio, generare
una nuova chiave/richiesta e firmarla con la stessa CA. Installare una directory
release nuova con i tre file e aggiornare `tlsDirectory`, verificare TLS e poi
riavviare. Con una nuova CA aggiornare anche il pin e la fiducia dei client.
Il rinnovo è esplicito; non sono previsti retry o rinnovi automatici.
