// Service worker de positions.html : sert uniquement a afficher les notifications sur telephone
// et a rouvrir la page quand on touche une notification. Aucun cache, aucune requete interceptee.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const tid = (e.notification.data && e.notification.data.tid) || "";
  e.waitUntil(self.clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    const c = list.find(x => x.url.includes("positions.html"));
    if (c) { c.postMessage({tid}); return c.focus(); }
    return self.clients.openWindow("positions.html" + (tid ? "#t-" + tid : ""));
  }));
});
