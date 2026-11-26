import assert from "node:assert/strict";
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import vm from "node:vm";
import worker from "./index.mjs";

test("chat sends an encrypted, signed push only to the recipient's active devices", async () => {
  const db = new DatabaseSync(":memory:");
  const bind = (sql, args) => {
    const statement = db.prepare(sql);
    return {
      bind: (...values) => bind(sql, values),
      run: async () => {
        const result = statement.run(...args);
        return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
      },
      first: async () => statement.get(...args),
      all: async () => ({ results: statement.all(...args) }),
    };
  };
  const vapid = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = vapid.privateKey.export({ format: "jwk" });
  const raw = ({ x, y }) => Buffer.concat([Buffer.of(4), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]);
  const env = {
    DB: {
      prepare: (sql) => bind(sql, []),
      batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
    },
    VAPID_PRIVATE_JWK: JSON.stringify(jwk),
    VAPID_PUBLIC_KEY: raw(jwk).toString("base64url"),
  };
  const background = [];
  const call = async (path, body, token, method = body ? "POST" : "GET") => {
    const response = await worker.fetch(new Request("https://worker.example" + path, {
      method, body: body && JSON.stringify(body),
      headers: token ? { Authorization: "Bearer " + token } : {},
    }), env, { waitUntil: (promise) => background.push(promise) });
    return { status: response.status, data: await response.json() };
  };
  const signup = async (username) => {
    const result = await call("/signup", { username, pin: "239871" });
    assert.equal(result.status, 200);
    return result.data.token;
  };
  const alice = await signup("Alice");
  const bob = await signup("Bob");
  const carol = await signup("Carol");
  assert.equal((await call("/friends", { username: "bob" }, alice)).status, 200);
  assert.equal((await call("/friends/accept", { username: "alice" }, bob)).status, 200);
  assert.equal((await call("/push/key")).status, 401);
  assert.equal((await call("/push/key", undefined, bob)).data.publicKey, env.VAPID_PUBLIC_KEY);

  const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const receiver = raw(device.publicKey.export({ format: "jwk" }));
  const auth = Buffer.alloc(16, 5);
  const keys = { p256dh: receiver.toString("base64url"), auth: auth.toString("base64url") };
  const apple = "https://web.push.apple.com/Qexample";
  const expired = "https://fcm.googleapis.com/fcm/send/expired";
  const other = "https://updates.push.services.mozilla.com/wpush/v2/other";
  const subscribe = (endpoint, token) => call("/push/subscription", { endpoint, keys }, token);
  for (const [endpoint, token] of [[apple, bob], [expired, bob], [other, carol]]) {
    assert.equal((await subscribe(endpoint, token)).status, 200);
  }
  assert.equal((await subscribe("https://web.push.apple.com.example.org/path", bob)).status, 400);
  assert.equal((await call("/push/test", { endpoint: apple }, carol)).status, 404);

  const delivered = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (endpoint, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Content-Encoding"], "aes128gcm");
    const [, unsigned, signature, publicKey] = options.headers.Authorization.match(/^vapid t=(.+)\.([\w-]+), k=([\w-]+)$/);
    assert.equal(publicKey, env.VAPID_PUBLIC_KEY);
    assert(verify("sha256", Buffer.from(unsigned), { key: vapid.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
    const claims = JSON.parse(Buffer.from(unsigned.split(".")[1], "base64url"));
    assert.equal(claims.aud, new URL(endpoint).origin);
    assert(claims.exp > Date.now() / 1000);

    const bytes = Buffer.from(options.body);
    assert.equal(bytes.readUInt32BE(16), 4096);
    const sender = bytes.subarray(21, 21 + bytes[20]);
    const senderKey = createPublicKey({ key: {
      kty: "EC", crv: "P-256",
      x: sender.subarray(1, 33).toString("base64url"),
      y: sender.subarray(33).toString("base64url"),
    }, format: "jwk" });
    const shared = diffieHellman({ privateKey: device.privateKey, publicKey: senderKey });
    const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]);
    const material = hkdfSync("sha256", shared, auth, info, 32);
    const salt = bytes.subarray(0, 16);
    const key = hkdfSync("sha256", material, salt, "Content-Encoding: aes128gcm\0", 16);
    const nonce = hkdfSync("sha256", material, salt, "Content-Encoding: nonce\0", 12);
    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    decipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(86, -16)), decipher.final()]);
    assert.equal(plaintext.at(-1), 2);
    delivered.push([endpoint, JSON.parse(plaintext.subarray(0, -1))]);
    return new Response(null, { status: endpoint === expired ? 410 : 201 });
  };
  try {
    const message = await call("/chats/bob", { text: "Keep this inside the chat" }, alice);
    assert.equal(message.status, 200);
    await Promise.all(background);
    assert.deepEqual(delivered.sort(), [[expired, { sender: "alice", messageId: 1 }], [apple, { sender: "alice", messageId: 1 }]]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 2);
    assert.equal((await call("/push/test", { endpoint: apple }, bob)).status, 200);
    assert.deepEqual(delivered.at(-1), [apple, { test: true }]);
    assert.equal((await call("/logout", {}, bob)).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 3);
    assert.equal(db.prepare("SELECT body FROM messages").get().body, "Keep this inside the chat");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("service worker displays a push with no app window and opens the chat on tap", async () => {
  const handlers = {};
  const notifications = [];
  const opened = [];
  const base = "https://kansop.github.io/pocket-ai/python-trail/";
  vm.runInNewContext(readFileSync(new URL("../push-sw.js", import.meta.url), "utf8"), {
    URL,
    self: {
      registration: { scope: base, showNotification: async (...args) => notifications.push(args) },
      clients: { matchAll: async () => [], openWindow: async (url) => opened.push(url) },
      addEventListener: (name, handler) => { handlers[name] = handler; },
    },
  });
  let pending;
  const waitUntil = (promise) => { pending = promise; };
  handlers.push({ waitUntil, data: { json: () => ({ sender: "alice", messageId: 1 }) } });
  await pending;
  const [title, options] = notifications[0];
  assert.equal(title, "Python Trail");
  assert.equal(options.body, "You have a new chat message.");
  handlers.notificationclick({ waitUntil, notification: { ...options, close() {} } });
  await pending;
  assert.deepEqual(opened, [base + "#chat/alice"]);
});
