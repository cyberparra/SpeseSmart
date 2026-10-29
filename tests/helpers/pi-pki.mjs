// Synthetic PKI only; never use these unencrypted root keys for an installation.
import { execFileSync } from 'node:child_process';
import { writeFile, readFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, X509Certificate } from 'node:crypto';
export async function syntheticPKI(directory) {
  const run = args => execFileSync('openssl', args, { stdio: 'ignore' });
  await writeFile(join(directory, 'request.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=Synthetic SpeseSmart TLS\n');
  run(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '365', '-config', join(directory, 'request.cnf'), '-keyout', join(directory, 'root.key'), '-out', join(directory, 'ca.crt'), '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash']);
  run(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-config', join(directory, 'request.cnf'), '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr')]);
  const ca = await readFile(join(directory, 'ca.crt'), 'utf8');
  const key = await readFile(join(directory, 'server.key'), 'utf8');
  async function issue({ ip = '127.0.0.1', caLeaf = false, eku = 'serverAuth', ku = 'digitalSignature,keyEncipherment', dates, useRootKey = false } = {}) {
    if (useRootKey) run(['req', '-new', '-key', join(directory, 'root.key'), '-config', join(directory, 'request.cnf'), '-out', join(directory, 'key-reused.csr')]);
    const csr = join(directory, useRootKey ? 'key-reused.csr' : 'server.csr');
    const extension = `basicConstraints=critical,CA:${caLeaf ? 'TRUE' : 'FALSE'}\nkeyUsage=critical,${ku}\nextendedKeyUsage=${eku}\nsubjectAltName=IP:${ip}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`;
    await writeFile(join(directory, 'leaf.cnf'), extension);
    if (dates) {
      await writeFile(join(directory, 'index.txt'), ''); await writeFile(join(directory, 'serial'), randomBytes(16).toString('hex') + '\n');
      const config = `[ca]\ndefault_ca=local\n[local]\ndatabase=${directory}/index.txt\nserial=${directory}/serial\nnew_certs_dir=${directory}\ncertificate=${directory}/ca.crt\nprivate_key=${directory}/root.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n`;
      await writeFile(join(directory, 'sign.cnf'), config);
      run(['ca', '-batch', '-notext', '-config', join(directory, 'sign.cnf'), '-startdate', dates[0], '-enddate', dates[1], '-extfile', join(directory, 'leaf.cnf'), '-in', csr, '-out', join(directory, 'server.crt')]);
    } else run(['x509', '-req', '-in', csr, '-CA', join(directory, 'ca.crt'), '-CAkey', join(directory, 'root.key'), '-set_serial', '0x'+randomBytes(16).toString('hex'), '-days', '90', '-sha256', '-extfile', join(directory, 'leaf.cnf'), '-out', join(directory, 'server.crt')]);
    return await readFile(join(directory, 'server.crt'), 'utf8');
  }
  const cert = await issue();
  const pin = new X509Certificate(ca).fingerprint256;
  async function bundle(path, leaf = cert) {
    await mkdir(path, { mode: 0o700 });
    for (const [name, text] of [['server.crt', leaf], ['server.key', key], ['ca.crt', ca]]) { await writeFile(join(path, name), text, { mode: 0o600 }); await chmod(join(path, name), 0o600); }
    return path;
  }
  return { ca, key, cert, pin, issue, bundle };
}
