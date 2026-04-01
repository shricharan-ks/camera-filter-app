/**
 * HTTPS static server for LAN + mobile testing.
 * Chrome on Android/iOS requires https:// (or localhost) for camera access.
 */
import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PREFERRED_PORT = Number(process.env.PORT || 8443);
/** If 8443 (etc.) is already taken, try the next ports up to this many attempts. */
const PORT_FALLBACK_ATTEMPTS = 30;
const CERT_DIR = path.join(ROOT, ".dev-certs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webp": "image/webp",
};

function collectLanAltNames() {
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
  ];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a && a.family === "IPv4" && !a.internal) {
          altNames.push({ type: 7, ip: a.address });
        }
      }
    }
  } catch {
    /* Restricted environments (e.g. some sandboxes) — cert still valid for localhost */
  }
  return altNames;
}

function listLanIPv4() {
  const ips = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a && a.family === "IPv4" && !a.internal) ips.push(a.address);
      }
    }
  } catch {
    /* ignore */
  }
  return ips;
}

function loadOrCreateCert() {
  const keyFile = path.join(CERT_DIR, "key.pem");
  const certFile = path.join(CERT_DIR, "cert.pem");

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile),
    };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const altNames = collectLanAltNames();
  const attrs = [{ name: "commonName", value: "camera-filter-dev" }];
  const pems = selfsigned.generate(attrs, {
    days: 825,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames,
      },
    ],
  });

  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);

  return { key: pems.private, cert: pems.cert };
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(ROOT, normalized);
  if (!full.startsWith(ROOT)) return null;
  return full;
}

function serve(req, res) {
  const url = new URL(req.url || "/", "https://local");
  let filePath = safePath(url.pathname === "/" ? "/index.html" : url.pathname);

  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=()");
  fs.createReadStream(filePath).pipe(res);
}

const { key, cert } = loadOrCreateCert();

function printBanner(port) {
  const lan = listLanIPv4();

  console.log(`
  Campaign photo — HTTPS (required for phone camera)

  On this machine:  https://localhost:${port}/
  On your phone:    https://<YOUR_LAN_IP>:${port}/
                    (same Wi‑Fi as this computer)

  LAN IPv4 candidates:`);
  for (const ip of lan) console.log(`    https://${ip}:${port}/`);
  console.log(`
  First visit: browser will warn about the self-signed certificate —
  choose Advanced → Proceed / Continue (safe on your own network).

  If your IP changed, delete ${path.relative(process.cwd(), CERT_DIR)} and restart.
`);
}

/**
 * @returns {Promise<{ server: import("https").Server; port: number }>}
 */
function listenWithPortFallback(startPort) {
  const lastPort = startPort + PORT_FALLBACK_ATTEMPTS;
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > lastPort) {
        reject(
          new Error(
            `No free port from ${startPort} through ${lastPort}. Stop the other process (lsof -i :${startPort}) or set PORT=...`
          )
        );
        return;
      }
      const server = https.createServer({ key, cert }, serve);
      server.once("error", (err) => {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE") {
          if (port === startPort) {
            console.warn(`Port ${port} is already in use; trying ${port + 1}, ${port + 2}, …`);
          }
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, "0.0.0.0", () => {
        if (port !== startPort) {
          console.warn(`Using port ${port} instead of ${startPort}.\n`);
        }
        resolve({ server, port });
      });
    };
    tryPort(startPort);
  });
}

listenWithPortFallback(PREFERRED_PORT)
  .then(({ port }) => {
    printBanner(port);
  })
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
