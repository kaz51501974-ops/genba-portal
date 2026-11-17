"use strict";

const express = require("express");
const webpush = require("web-push");
const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "music10212026@gmail.com";
const PROJECT_ID = "genba-portal";
const DATA = path.join(__dirname, "subscriptions.json");
const KEYS = path.join(__dirname, "vapid.json");

const ROLES = Object.freeze({
  manager: "管理職",
  employee: "社員",
  part: "パート",
  trainee: "研修生"
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/* Firebaseの秘密鍵はRenderの環境変数から読む */
let firebaseApp;
let serviceAccount;
let firebaseReady = false;

try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("missing configuration");

  serviceAccount = JSON.parse(raw);

  if (
    serviceAccount.type !== "service_account" ||
    serviceAccount.project_id !== PROJECT_ID ||
    typeof serviceAccount.private_key !== "string" ||
    typeof serviceAccount.client_email !== "string"
  ) {
    throw new Error("invalid configuration");
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: PROJECT_ID
  });

  firebaseReady = true;
} catch {
  // 秘密鍵やJSON本文はログに出さない
  console.error("Firebase接続設定を確認してください。");
}

function getAuth() {
  if (!firebaseReady) throw new Error("Firebase configuration unavailable");
  return admin.auth(firebaseApp);
}

function getDb() {
  if (!firebaseReady) throw new Error("Firebase configuration unavailable");
  return admin.firestore(firebaseApp);
}

function timestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

/* 日本時間の月と、翌月1日0時 */
function monthInfo(now = Date.now()) {
  const japan = new Date(now + 9 * 60 * 60 * 1000);
  const year = japan.getUTCFullYear();
  const month = japan.getUTCMonth();

  return {
    month: `${year}-${String(month + 1).padStart(2, "0")}`,
    expiresAt: Date.UTC(year, month + 1, 1) - 9 * 60 * 60 * 1000
  };
}

function sameText(left, right) {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

/*
 * 初期設定はFirestoreへ保存。
 * Renderの再起動で初期月や生成用秘密値が失われない。
 * portalPrivateは、ブラウザから読めないルールにする。
 */
async function accessConfig() {
  const db = getDb();
  const ref = db.collection("portalPrivate").doc("roleAccess");
  const candidate = {
    initialMonth: monthInfo().month,
    secret: crypto.randomBytes(48).toString("hex"),
    createdAt: timestamp()
  };

  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);

    if (snapshot.exists) {
      const data = snapshot.data();

      if (
        typeof data.initialMonth !== "string" ||
        !/^\d{4}-\d{2}$/.test(data.initialMonth) ||
        typeof data.secret !== "string" ||
        data.secret.length < 64
      ) {
        throw new Error("Invalid role configuration");
      }

      return data;
    }

    transaction.set(ref, candidate);
    return candidate;
  });
}

/* 初期月は1111。翌月から区分ごとに異なるパスワード */
function rolePassword(config, role, month) {
  if (!Object.prototype.hasOwnProperty.call(ROLES, role)) {
    throw new Error("Invalid role");
  }

  if (month === config.initialMonth) return "1111";

  return crypto
    .createHmac("sha256", config.secret)
    .update(`genba-portal:${month}:${role}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
}

async function readIdentity(req) {
  const authorization = req.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    const error = new Error("ログインしてください。");
    error.status = 401;
    throw error;
  }

  try {
    return await getAuth().verifyIdToken(match[1], true);
  } catch {
    const error = new Error("ログインし直してください。");
    error.status = 401;
    throw error;
  }
}

function isAdmin(identity) {
  return (
    identity.email === ADMIN_EMAIL &&
    identity.email_verified === true &&
    identity.firebase?.sign_in_provider === "google.com"
  );
}

async function requireAdmin(req, res, next) {
  try {
    req.identity = await readIdentity(req);

    if (!isAdmin(req.identity)) {
      return res.status(403).json({
        ok: false,
        error: "管理者のGoogleアカウントが必要です。"
      });
    }

    next();
  } catch (error) {
    res.status(error.status || 503).json({
      ok: false,
      error: error.status
        ? error.message
        : "Firebaseの接続設定を確認してください。"
    });
  }
}

async function requireViewer(req, res, next) {
  try {
    const identity = await readIdentity(req);
    let allowed = isAdmin(identity);

    if (!allowed) {
      const info = monthInfo();

      allowed =
        identity.firebase?.sign_in_provider === "custom" &&
        Object.prototype.hasOwnProperty.call(
          ROLES,
          identity.portalRole
        ) &&
        identity.portalMonth === info.month &&
        identity.portalExpiresAt === info.expiresAt &&
        Date.now() < identity.portalExpiresAt;
    }

    // 従来のGoogle閲覧者登録も維持
    if (
      !allowed &&
      identity.email_verified === true &&
      identity.firebase?.sign_in_provider === "google.com" &&
      typeof identity.email === "string"
    ) {
      const member = await getDb()
        .collection("members")
        .doc(identity.email)
        .get();

      allowed = member.exists;
    }

    if (!allowed) {
      return res.status(403).json({
        ok: false,
        error: "閲覧権限がないか、パスワードの有効期限が切れています。"
      });
    }

    req.identity = identity;
    next();
  } catch (error) {
    res.status(error.status || 503).json({
      ok: false,
      error: error.status
        ? error.message
        : "接続設定を確認してください。"
    });
  }
}

/* ログイン試行回数を再起動後も制限 */
async function consumeLoginAttempt(req, role) {
  const windowMs = 15 * 60 * 1000;
  const windowNumber = Math.floor(Date.now() / windowMs);
  const id = crypto
    .createHash("sha256")
    .update(`${req.ip}:${role}:${windowNumber}`)
    .digest("hex");

  const db = getDb();
  const ref = db
    .collection("portalPrivate")
    .doc("roleAccess")
    .collection("attempts")
    .doc(id);

  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const count = snapshot.exists
      ? Number(snapshot.data().count || 0)
      : 0;

    if (count >= 10) return false;

    transaction.set(ref, {
      count: count + 1,
      expiresAt: admin.firestore.Timestamp.fromMillis(
        (windowNumber + 1) * windowMs
      )
    });

    return true;
  });
}

/* 区分＋パスワードでログイン */
app.post("/api/auth/role", async (req, res) => {
  const { role, password } = req.body || {};

  if (
    typeof role !== "string" ||
    !Object.prototype.hasOwnProperty.call(ROLES, role) ||
    typeof password !== "string" ||
    password.length > 128
  ) {
    return res.status(400).json({
      ok: false,
      error: "区分とパスワードを確認してください。"
    });
  }

  try {
    if (!(await consumeLoginAttempt(req, role))) {
      res.set("Retry-After", "900");

      return res.status(429).json({
        ok: false,
        error: "試行回数が多いため、15分ほど待って再試行してください。"
      });
    }

    const config = await accessConfig();
    const info = monthInfo();

    if (
      !sameText(
        password,
        rolePassword(config, role, info.month)
      )
    ) {
      return res.status(401).json({
        ok: false,
        error: "区分またはパスワードが違います。"
      });
    }

    const customToken = await getAuth().createCustomToken(
      `portal-${role}-${info.month}`,
      {
        portalRole: role,
        portalMonth: info.month,
        portalExpiresAt: info.expiresAt
      }
    );

    res.json({
      ok: true,
      customToken,
      roleName: ROLES[role],
      expiresAt: info.expiresAt
    });
  } catch {
    res.status(503).json({
      ok: false,
      error: "ログインを準備できませんでした。管理者が接続設定を確認してください。"
    });
  }
});

/* 管理者だけが当月・翌月のパスワードを確認できる */
app.get(
  "/api/admin/role-passwords",
  requireAdmin,
  async (req, res) => {
    try {
      const config = await accessConfig();
      const current = monthInfo();
      const next = monthInfo(current.expiresAt);

      const rows = Object.entries(ROLES).map(
        ([role, name]) => ({
          role,
          name,
          currentPassword: rolePassword(
            config,
            role,
            current.month
          ),
          nextPassword: rolePassword(
            config,
            role,
            next.month
          )
        })
      );

      res.json({
        ok: true,
        month: current.month,
        nextMonth: next.month,
        changesAt: current.expiresAt,
        rows
      });
    } catch {
      res.status(503).json({
        ok: false,
        error: "パスワードの設定を取得できませんでした。"
      });
    }
  }
);

/* 鍵の存在だけでなく、実際のFirebase接続も確認 */
app.get(
  "/api/admin/firebase-check",
  requireAdmin,
  async (req, res) => {
    try {
      await getAuth().getUser(req.identity.uid);
      await getDb().collection("posts").limit(1).get();

      res.json({
        ok: true,
        projectId: PROJECT_ID,
        keyIdPrefix: serviceAccount.private_key_id
          ? serviceAccount.private_key_id.slice(0, 8)
          : "",
        checkedAt: new Date().toISOString()
      });
    } catch {
      res.status(503).json({
        ok: false,
        error: "Firebaseへの接続に失敗しました。秘密鍵と権限を確認してください。"
      });
    }
  }
);

/* 従来の通知設定 */
function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

let vapid = loadJSON(KEYS, null);

if (!vapid) {
  vapid = webpush.generateVAPIDKeys();
  saveJSON(KEYS, vapid);
  console.log("VAPID keys generated.");
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  vapid.publicKey,
  vapid.privateKey
);

app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: vapid.publicKey });
});

app.post("/api/subscribe", requireViewer, (req, res) => {
  const { subscription, lang = "ja" } = req.body || {};

  if (
    !subscription ||
    typeof subscription.endpoint !== "string" ||
    subscription.endpoint.length > 2000
  ) {
    return res.status(400).json({
      ok: false,
      error: "通知の登録情報を確認してください。"
    });
  }

  let endpoint;

  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    return res.status(400).json({
      ok: false,
      error: "通知先が不正です。"
    });
  }

  const host = endpoint.hostname;
  const knownPushHost =
    host === "fcm.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host === "web.push.apple.com" ||
    host.endsWith(".notify.windows.com");

  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    !knownPushHost
  ) {
    return res.status(400).json({
      ok: false,
      error: "この通知先には対応していません。"
    });
  }

  try {
    const list = loadJSON(DATA, []);
    const found = list.find(
      item =>
        item.subscription?.endpoint === subscription.endpoint
    );

    if (found) {
      found.subscription = subscription;
      found.lang = lang === "vi" ? "vi" : "ja";
    } else {
      list.push({
        subscription,
        lang: lang === "vi" ? "vi" : "ja",
        createdAt: new Date().toISOString()
      });
    }

    saveJSON(DATA, list);
    res.json({ ok: true, count: list.length });
  } catch {
    res.status(500).json({
      ok: false,
      error: "通知登録を保存できませんでした。"
    });
  }
});

let notifying = false;

app.post("/api/notify", requireAdmin, async (req, res) => {
  if (notifying) {
    return res.status(429).json({
      ok: false,
      error: "通知送信中です。"
    });
  }

  const {
    title = "現場ポータル",
    body = "新しい掲示があります。",
    url = "/#bulletin"
  } = req.body || {};

  if (
    typeof title !== "string" ||
    typeof body !== "string" ||
    typeof url !== "string" ||
    title.length > 150 ||
    body.length > 10000 ||
    !url.startsWith("/") ||
    url.startsWith("//")
  ) {
    return res.status(400).json({
      ok: false,
      error: "通知内容を確認してください。"
    });
  }

  notifying = true;

  try {
    const list = loadJSON(DATA, []);
    const keep = [];
    let sent = 0;
    let removed = 0;

    for (const item of list) {
      try {
        await webpush.sendNotification(
          item.subscription,
          JSON.stringify({ title, body, url }),
          { timeout: 10000 }
        );
        sent++;
        keep.push(item);
      } catch (error) {
        if (
          error.statusCode === 404 ||
          error.statusCode === 410
        ) {
          removed++;
        } else {
          keep.push(item);
          console.error("push error", error.statusCode || "");
        }
      }
    }

    if (removed) saveJSON(DATA, keep);
    res.json({ ok: true, sent, removed });
  } catch {
    res.status(500).json({
      ok: false,
      error: "通知処理に失敗しました。"
    });
  } finally {
    notifying = false;
  }
});

/* 管理者専用の翻訳 */
let translationBusy = false;
let lastTranslationAt = 0;

app.post(
  "/api/translate",
  requireAdmin,
  async (req, res) => {
    const { title = "", body = "" } = req.body || {};

    if (
      typeof title !== "string" ||
      typeof body !== "string" ||
      title.length > 150 ||
      body.length > 10000 ||
      (!title.trim() && !body.trim())
    ) {
      return res.status(400).json({
        error: "翻訳するタイトルと本文を確認してください。"
      });
    }

    const url = process.env.TRANSLATE_URL;
    const secret = process.env.TRANSLATE_SECRET;

    if (!url || !secret) {
      return res.status(503).json({
        error: "翻訳の接続設定がありません。"
      });
    }

    if (
      translationBusy ||
      Date.now() - lastTranslationAt < 3000
    ) {
      return res.status(429).json({
        error: "少し待ってから翻訳してください。"
      });
    }

    translationBusy = true;
    lastTranslationAt = Date.now();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, title, body }),
        signal: AbortSignal.timeout(45000)
      });

      const result = await response.json();

      if (
        !response.ok ||
        result.ok !== true ||
        typeof result.titleVi !== "string" ||
        typeof result.bodyVi !== "string" ||
        result.titleVi.length > 150 ||
        result.bodyVi.length > 10000
      ) {
        throw new Error("Translation failed");
      }

      res.json({
        ok: true,
        titleVi: result.titleVi,
        bodyVi: result.bodyVi
      });
    } catch {
      res.status(502).json({
        error: "翻訳できませんでした。時間をおいて再試行してください。"
      });
    } finally {
      translationBusy = false;
    }
  }
);

/* JSONファイルや秘密情報を公開しない */
const publicFiles = [
  "/index.html",
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.json",
  "/manifest.webmanifest"
];

for (const file of publicFiles) {
  app.get(file, (req, res) => {
    res.sendFile(path.join(__dirname, file));
  });
}

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "APIが見つかりません。"
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`現場ポータル: http://localhost:${PORT}`);
});
