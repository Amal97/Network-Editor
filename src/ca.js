'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const tls = require('tls');
const forge = require('node-forge');

const pki = forge.pki;

const CA_SUBJECT = [
  { name: 'commonName', value: 'Network Modifier Root CA' },
  { name: 'organizationName', value: 'Network Modifier' },
  { shortName: 'OU', value: 'Debugging Proxy' }
];

function defaultDataDir() {
  return process.env.NETMOD_HOME || path.join(os.homedir(), '.network-modifier');
}

class CertificateAuthority {
  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir;
    this.certsDir = path.join(dataDir, 'certs');
    this.caCertPath = path.join(dataDir, 'netmod-ca.crt');
    this.caKeyPath = path.join(dataDir, 'netmod-ca.key');
    this.contextCache = new Map();
    this.caCert = null;
    this.caKey = null;
  }

  init() {
    fs.mkdirSync(this.certsDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      this.caCert = pki.certificateFromPem(fs.readFileSync(this.caCertPath, 'utf8'));
      this.caKey = pki.privateKeyFromPem(fs.readFileSync(this.caKeyPath, 'utf8'));
      if (this.caCert.validity.notAfter.getTime() > Date.now()) return this;
    }
    this.generateRoot();
    return this;
  }

  generateRoot() {
    const keys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
    cert.setSubject(CA_SUBJECT);
    cert.setIssuer(CA_SUBJECT);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    this.caCert = cert;
    this.caKey = keys.privateKey;

    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.caCertPath, pki.certificateToPem(cert), { mode: 0o644 });
    fs.writeFileSync(this.caKeyPath, pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    // Any previously issued leaf certificate is now signed by a dead root.
    for (const file of safeReaddir(this.certsDir)) {
      fs.rmSync(path.join(this.certsDir, file), { force: true });
    }
    this.contextCache.clear();
    return cert;
  }

  get caCertPem() {
    return pki.certificateToPem(this.caCert);
  }

  info() {
    const cert = this.caCert;
    return {
      path: this.caCertPath,
      subject: cert.subject.getField('CN').value,
      validFrom: cert.validity.notBefore.toISOString(),
      validTo: cert.validity.notAfter.toISOString(),
      fingerprintSha256: fingerprint(cert)
    };
  }

  /** Returns a tls.SecureContext for the given hostname, generating a leaf cert on demand. */
  secureContextFor(hostname) {
    const key = normalizeHost(hostname);
    let ctx = this.contextCache.get(key);
    if (ctx) return ctx;
    const pair = this.leafFor(key);
    ctx = tls.createSecureContext({
      key: pair.key,
      cert: pair.cert + '\n' + this.caCertPem
    });
    this.contextCache.set(key, ctx);
    return ctx;
  }

  leafFor(hostname) {
    const file = path.join(this.certsDir, safeFileName(hostname) + '.json');
    if (fs.existsSync(file)) {
      try {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cached.issuer === fingerprint(this.caCert) && new Date(cached.notAfter) > new Date()) {
          return cached;
        }
      } catch { /* regenerate below */ }
    }
    const pair = this.issueLeaf(hostname);
    fs.writeFileSync(file, JSON.stringify(pair), { mode: 0o600 });
    return pair;
  }

  issueLeaf(hostname) {
    const keys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600 * 1000);
    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(this.caCert.subject.attributes);

    const altNames = isIp(hostname)
      ? [{ type: 7, ip: hostname }]
      : [{ type: 2, value: hostname }];

    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames },
      { name: 'subjectKeyIdentifier' }
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());

    return {
      host: hostname,
      key: pki.privateKeyToPem(keys.privateKey),
      cert: pki.certificateToPem(cert),
      notAfter: cert.validity.notAfter.toISOString(),
      issuer: fingerprint(this.caCert)
    };
  }
}

function normalizeHost(hostname) {
  const host = String(hostname || 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  if (isIp(host)) return host;
  const parts = host.split('.');
  // Wildcard-free: one leaf certificate per exact host keeps SAN validation simple.
  return parts.join('.');
}

function isIp(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

function safeFileName(name) {
  return name.replace(/[^a-z0-9.\-_]/gi, '_');
}

function randomSerial() {
  return '00' + forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function fingerprint(cert) {
  const der = forge.asn1.toDer(pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex().replace(/(.{2})(?=.)/g, '$1:').toUpperCase();
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

module.exports = { CertificateAuthority, defaultDataDir };
