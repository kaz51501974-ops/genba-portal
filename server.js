
const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "subscriptions.json");
const KEYS = path.join(__dirname, "vapid.json");

app.use(express.json({limit:"1mb"}));
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

function loadJSON(file, fallback){
  try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch(e){ return fallback; }
}
function saveJSON(file, value){ fs.writeFileSync(file, JSON.stringify(value,null,2)); }

let vapid = loadJSON(KEYS, null);
if(!vapid){
  vapid = webpush.generateVAPIDKeys();
  saveJSON(KEYS, vapid);
  console.log("VAPID keys generated.");
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  vapid.publicKey,
  vapid.privateKey
);

app.get("/api/vapid-public-key",(req,res)=>res.json({publicKey:vapid.publicKey}));

app.post("/api/subscribe",(req,res)=>{
  const {subscription,lang="ja"} = req.body || {};
  if(!subscription?.endpoint) return res.status(400).json({error:"subscription required"});
  const list=loadJSON(DATA,[]);
  const found=list.find(x=>x.subscription?.endpoint===subscription.endpoint);
  if(found){ found.subscription=subscription; found.lang=lang; }
  else list.push({subscription,lang,createdAt:new Date().toISOString()});
  saveJSON(DATA,list);
  res.json({ok:true,count:list.length});
});

app.post("/api/notify",async(req,res)=>{
  const {title="現場ポータル",body="新しい掲示があります。",url="/#bulletin"}=req.body||{};
  let list=loadJSON(DATA,[]);
  let sent=0, removed=0;
  const keep=[];
  for(const item of list){
    try{
      await webpush.sendNotification(item.subscription, JSON.stringify({title,body,url}));
      sent++; keep.push(item);
    }catch(e){
      if(e.statusCode===404 || e.statusCode===410){ removed++; }
      else { keep.push(item); console.error("push error",e.statusCode,e.body||e.message); }
    }
  }
  if(removed) saveJSON(DATA,keep);
  res.json({ok:true,sent,removed});
});
// 管理者専用の翻訳
let translationBusy = false;
let lastTranslationAt = 0;

app.post("/api/translate", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const idToken = (req.get("Authorization") || "")
    .replace(/^Bearer\s+/i, "");

  if (!idToken) {
    return res.status(401).json({
      error: "ログインし直してください。"
    });
  }

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

  let locked = false;

  try {
    const authResponse = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup" +
      "?key=AIzaSyAooAgoxNflTxzMK2wyYNs6IMPdZ32zNxo",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const accountData = await authResponse.json();
    const account = accountData.users?.[0];

    if (
      !authResponse.ok ||
      account?.email !== "music10212026@gmail.com" ||
      account?.emailVerified !== true ||
      account?.disabled === true
    ) {
      return res.status(403).json({
        error: "会社用の管理者アカウントでログインしてください。"
      });
    }

    if (translationBusy || Date.now() - lastTranslationAt < 3000) {
      return res.status(429).json({
        error: "少し待ってから翻訳してください。"
      });
    }

    translationBusy = true;
    locked = true;
    lastTranslationAt = Date.now();

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
      typeof result.bodyVi !== "string"
    ) {
      throw new Error("Translation failed");
    }

    res.json({
      ok: true,
      titleVi: result.titleVi,
      bodyVi: result.bodyVi
    });
  } catch (error) {
    res.status(502).json({
      error: "翻訳できませんでした。時間をおいて再試行してください。"
    });
  } finally {
    if (locked) translationBusy = false;
  }
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

app.listen(PORT,()=>console.log(`現場ポータル: http://localhost:${PORT}`));
