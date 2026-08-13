
const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "subscriptions.json");
const KEYS = path.join(__dirname, "vapid.json");

app.use(express.json({limit:"1mb"}));
app.use(express.static(__dirname));

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

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

app.listen(PORT,()=>console.log(`現場ポータル: http://localhost:${PORT}`));
