const encoder = new TextEncoder();
const encode = (text) => encoder.encode(text);

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export function validEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    return url.href === endpoint && url.protocol === "https:" && !url.port &&
      !url.username && !url.password && !url.hash &&
      (host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
       host === "web.push.apple.com" || host.endsWith(".push.apple.com") ||
       host.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}

export async function validKeys(keys) {
  if (!keys || typeof keys.auth !== "string" || typeof keys.p256dh !== "string" ||
      !/^[\w-]{22}$/.test(keys.auth) || !/^[\w-]{87}$/.test(keys.p256dh)) return false;
  try {
    await crypto.subtle.importKey("raw", decode(keys.p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

async function hkdf(secret, salt, info, bits) {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

// RFC 8291 derives a per-message key. RFC 8188 defines the record framing.
async function encrypt(subscription, payload) {
  const receiver = decode(subscription.p256dh);
  const peer = await crypto.subtle.importKey("raw", receiver, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sender = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256);
  const material = await hkdf(shared, decode(subscription.auth), concat(encode("WebPush: info\0"), receiver, sender), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyBytes = await hkdf(material, salt, encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(material, salt, encode("Content-Encoding: nonce\0"), 96);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(encode(JSON.stringify(payload)), Uint8Array.of(2));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  return concat(salt, Uint8Array.of(0, 0, 16, 0, sender.length), sender, new Uint8Array(ciphertext));
}

async function authorization(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64url(encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "https://kansop.github.io/pocket-ai/python-trail/",
  })));
  const unsigned = header + "." + claims;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encode(unsigned));
  return "vapid t=" + unsigned + "." + base64url(new Uint8Array(signature)) + ", k=" + env.VAPID_PUBLIC_KEY;
}

export async function sendPush(env, subscription, payload) {
  if (!validEndpoint(subscription.endpoint)) throw new Error("Invalid Web Push endpoint");
  const [body, auth] = await Promise.all([
    encrypt(subscription, payload),
    authorization(subscription.endpoint, env),
  ]);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
    },
    body,
  });
  await response.body?.cancel();
  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND revision = ?")
      .bind(subscription.endpoint, subscription.revision).run();
    return false;
  }
  if (!response.ok) throw new Error("Push service returned HTTP " + response.status);
  return true;
}
