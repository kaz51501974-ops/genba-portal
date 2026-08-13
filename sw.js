
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  const title = data.title || "現場ポータル";
  const options = {
    body: data.body || "新しい掲示があります。",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/#bulletin" },
    tag: data.tag || "genba-portal"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || "/#bulletin";
  event.waitUntil((async()=>{
    const all = await clients.matchAll({type:"window", includeUncontrolled:true});
    for(const c of all){
      if("focus" in c){
        await c.navigate(target);
        return c.focus();
      }
    }
    if(clients.openWindow) return clients.openWindow(target);
  })());
});
