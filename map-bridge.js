/**
 * map-bridge.js
 * 
 * הוסף את זה לתחתית map.html, לפני </body>:
 *   <script src="map-bridge.js"></script>
 *
 * הקובץ הזה מוסיף ממשק postMessage שמאפשר ל-app.html
 * לשלוט במפה ולקבל ממנה נתונים, בלי לשנות את שאר הקוד.
 *
 * הודעות שapp.html שולח למפה (window.postMessage → iframe):
 *   { type: 'SET_MODE', mode: 'pan'|'free'|'snap' }
 *   { type: 'CLEAR_ROUTE' }
 *   { type: 'UNDO' }
 *   { type: 'GET_ROUTE' }         → המפה עונה עם ROUTE_DATA
 *   { type: 'FLY_TO', lat, lng, zoom }
 *   { type: 'SHOW_TRIP', coords: [{lat,lng},...] }
 *   { type: 'CLEAR_DISPLAY_TRIPS' }
 *   { type: 'IMPORT_GPX_DATA', coords: [{lat,lng},...] }
 *
 * הודעות שהמפה שולחת לapp.html (parent.postMessage):
 *   { type: 'ROUTE_DATA', coords: [{lat,lng},...], distanceKm: 4.3, pointCount: 87 }
 *   { type: 'MODE_CHANGED', mode: 'pan'|'free'|'snap' }
 *   { type: 'ROUTE_UPDATED', distanceKm: 2.1, pointCount: 40 }
 *   { type: 'MAP_CLICK', lat, lng }
 *   { type: 'SNAP_STATUS', msg: '...' }
 *   { type: 'STATUS', msg: '...' }
 *   { type: 'MAP_READY' }
 */

(function() {
  'use strict';

  // ── שמירת רפרנסים לפונקציות המקוריות מ-map.html ────────
  // כל הפונקציות מוגדרות ב-window scope בmap.html, אז פשוט קוראים להן.

  // layer לשמירת מסלולי טיולים שמוצגים על המפה (קריאה בלבד)
  const displayLayers = [];

  // ── שליחת הודעה לparent (app.html) ────────────────────────
  function sendToApp(msg) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
  }

  // ── האזנה להודעות מ-app.html ───────────────────────────────
  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {

      case 'SET_MODE':
        if (typeof setMode === 'function') {
          setMode(msg.mode);
          sendToApp({ type: 'MODE_CHANGED', mode: msg.mode });
        }
        break;

      case 'CLEAR_ROUTE':
        if (typeof clearRoute === 'function') clearRoute();
        break;

      case 'UNDO':
        if (typeof undoLast === 'function') undoLast();
        break;

      case 'GET_ROUTE':
        sendRouteToApp();
        break;

      case 'FLY_TO':
        if (typeof map !== 'undefined' && map) {
          map.setView([msg.lat, msg.lng], msg.zoom || 13, { animate: true });
        }
        break;

      case 'SHOW_TRIP':
        // הצג מסלול שמור על המפה (קו כחול, לא ניתן לעריכה)
        if (msg.coords && msg.coords.length > 1 && typeof map !== 'undefined') {
          const line = L.polyline(
            msg.coords.map(c => [c.lat, c.lng]),
            { color: '#3b82f6', weight: 4, opacity: 0.7, dashArray: '8,4', interactive: false }
          ).addTo(map);
          displayLayers.push(line);
          map.fitBounds(line.getBounds(), { padding: [30, 30] });
        }
        break;

      case 'CLEAR_DISPLAY_TRIPS':
        displayLayers.forEach(l => { if (typeof map !== 'undefined') map.removeLayer(l); });
        displayLayers.length = 0;
        break;

      case 'IMPORT_GPX_DATA':
        // ייבוא נקודות GPX ישירות (ללא קריאת קובץ)
        if (msg.coords && msg.coords.length > 1 && typeof map !== 'undefined') {
          if (typeof clearRoute === 'function') clearRoute();
          const lls = msg.coords.map(c => L.latLng(c.lat, c.lng));
          // freePolyline מוגדר ב-map.html
          window.freePolyline = L.polyline(lls, {
            color: '#3b82f6', weight: 4, opacity: 0.9,
            lineJoin: 'round', lineCap: 'round'
          }).addTo(map);
          map.fitBounds(window.freePolyline.getBounds(), { padding: [30, 30] });
          if (typeof updateRP === 'function') updateRP();
          sendToApp({ type: 'STATUS', msg: `✓ ${lls.length} נקודות יובאו` });
        }
        break;
    }
  });

  // ── שליחת נתוני מסלול לapp ─────────────────────────────────
  function sendRouteToApp() {
    let coords = [];
    let totalDist = 0;

    // נסה לאסוף נקודות מfreePolyline
    if (typeof freePolyline !== 'undefined' && freePolyline) {
      const lls = freePolyline.getLatLngs();
      coords = lls.map(ll => ({ lat: ll.lat, lng: ll.lng }));
      for (let i = 1; i < lls.length; i++) totalDist += lls[i-1].distanceTo(lls[i]);
    }
    // או מsnapSegs
    else if (typeof snapSegs !== 'undefined' && snapSegs.length) {
      let allPts = [];
      for (const seg of snapSegs) {
        const lls = seg.getLatLngs();
        if (!allPts.length) allPts.push(lls[0]);
        allPts.push(...lls.slice(1));
      }
      coords = allPts.map(ll => ({ lat: ll.lat, lng: ll.lng }));
      for (let i = 1; i < allPts.length; i++) totalDist += allPts[i-1].distanceTo(allPts[i]);
    }

    sendToApp({
      type: 'ROUTE_DATA',
      coords,
      distanceKm: parseFloat((totalDist / 1000).toFixed(2)),
      pointCount: coords.length,
      startLatLng: coords.length ? [coords[0].lat, coords[0].lng] : null,
    });
  }

  // ── Monkey-patch לפונקציות קיימות: שלח עדכון כשהמסלול משתנה ──
  // עוטף את updateRP כדי להודיע לapp על כל שינוי
  const _origUpdateRP = window.updateRP;
  window.updateRP = function() {
    if (_origUpdateRP) _origUpdateRP.apply(this, arguments);
    // שלח עדכון קצר לapp
    setTimeout(() => {
      let dist = 0;
      let pts = 0;
      if (typeof freePolyline !== 'undefined' && freePolyline) {
        const lls = freePolyline.getLatLngs();
        pts = lls.length;
        for (let i = 1; i < lls.length; i++) dist += lls[i-1].distanceTo(lls[i]);
      } else if (typeof snapSegs !== 'undefined') {
        for (const seg of snapSegs) {
          const lls = seg.getLatLngs();
          pts += lls.length;
          for (let i = 1; i < lls.length; i++) dist += lls[i-1].distanceTo(lls[i]);
        }
      }
      sendToApp({
        type: 'ROUTE_UPDATED',
        distanceKm: parseFloat((dist / 1000).toFixed(2)),
        pointCount: pts,
      });
    }, 50);
  };

  // עוטף את setMode כדי להודיע לapp
  const _origSetMode = window.setMode;
  window.setMode = function(m) {
    if (_origSetMode) _origSetMode.apply(this, arguments);
    sendToApp({ type: 'MODE_CHANGED', mode: m });
  };

  // עוטף את setStatus
  const _origSetStatus = window.setStatus;
  window.setStatus = function(msg) {
    if (_origSetStatus) _origSetStatus.apply(this, arguments);
    sendToApp({ type: 'STATUS', msg });
  };

  // עוטף את setSnapMsg
  const _origSetSnapMsg = window.setSnapMsg;
  window.setSnapMsg = function(msg) {
    if (_origSetSnapMsg) _origSetSnapMsg.apply(this, arguments);
    sendToApp({ type: 'SNAP_STATUS', msg });
  };

  // ── הודע לapp שהמפה מוכנה ─────────────────────────────────
  // נחכה שinitMap יסיים
  const _origInitMap = window.initMap;
  if (_origInitMap) {
    window.initMap = function() {
      _origInitMap.apply(this, arguments);
      // המפה אתחלה — שלח MAP_READY
      setTimeout(() => sendToApp({ type: 'MAP_READY' }), 200);
    };
  } else {
    // initMap כבר רץ לפני הטעינה שלנו
    setTimeout(() => sendToApp({ type: 'MAP_READY' }), 500);
  }

  console.log('[map-bridge] loaded ✓');
})();
