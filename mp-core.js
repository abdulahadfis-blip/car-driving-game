/*
 * mp-core.js - the MULTIPLAYER add-on core. RUNS INSIDE THE GAME IFRAME
 * (injected as a <script> by multiplayer.js).   v3
 *
 * v3 fixes:
 *   1. JSON serialization instead of binary -> data packets can no longer
 *      silently vanish between two windows.
 *   2. ANTI-OVERLAP PARKING: both players spawn at the same world spot, so
 *      the friend's car used to be drawn EXACTLY inside your own car
 *      (invisible!). Now a remote car is always nudged to park ~7 units
 *      beside your car when it is too close, so you can SEE it instantly.
 *   3. "Link:" health line in the panel shows whether data really flows.
 *   4. Auto-reconnect for joiners if no data arrives.
 *   5. Brighter beacon pillar + all network handlers wrapped in try/catch
 *      so one error can never kill the whole multiplayer link.
 *
 * How it works (PeerJS, free public signaling server, peer-to-peer):
 *   - Host creates a room with a code -> peer id "acmp-<code>-h"
 *   - Friends JOIN with the same code and connect to the host peer
 *   - Joiners send their car state 10x/sec; the host relays everyone's
 *     state back 10x/sec, so all players see every other car.
 *   - The game world recenters around each player, so every player also
 *     sends their world "origin" offset; remote cars are drawn relative
 *     to the local player's origin so positions always line up.
 *   - PeerJS comes from the parent page (window.parent.Peer); if missing,
 *     this script loads it itself from a CDN fallback.
 */
(function () {
  if (window.__mpLoaded) return;
  var tries = 0;

  (function wait() {
    tries++;
    var ready = (typeof carState !== 'undefined') &&
                (typeof scene !== 'undefined') &&
                (typeof THREE !== 'undefined') &&
                (typeof window.update === 'function');
    if (!ready) { if (tries < 200) setTimeout(wait, 100); return; }

    window.__mpLoaded = true;

    var COLORS = [0xef4444, 0x3b82f6, 0x22c55e, 0xeab308, 0xa855f7, 0xf97316, 0x06b6d4, 0xec4899];

    /* ================= CSS ================= */
    var css = [
      '.mp-panel { position: fixed; top: calc(env(safe-area-inset-top) + 110px); left: 14px;',
      '  width: 250px; background: rgba(15,23,42,0.92); backdrop-filter: blur(10px);',
      '  border: 1px solid rgba(168,85,247,0.5); border-radius: 16px; padding: 12px;',
      '  z-index: 12; color: white; font-family: inherit; }',
      '.mp-panel h3 { margin: 0 0 8px 0; font-size: 14px; letter-spacing: 1px; display: flex; justify-content: space-between; align-items: center; }',
      '.mp-panel h3 .min { cursor: pointer; background: #334155; border: none; color: white;',
      '  width: 22px; height: 22px; border-radius: 6px; font-weight: 800; line-height: 1; }',
      '.mp-panel input { width: 100%; box-sizing: border-box; margin: 4px 0; padding: 7px 9px;',
      '  border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: white; font-size: 13px; outline: none; }',
      '.mp-panel .row { display: flex; gap: 6px; margin-top: 6px; }',
      '.mp-panel button.act { flex: 1; padding: 8px 0; border: none; border-radius: 8px; color: white;',
      '  font-weight: 800; font-size: 12px; cursor: pointer; letter-spacing: 0.5px; }',
      '.mp-btn-create { background: #22c55e; }',
      '.mp-btn-join { background: #3b82f6; }',
      '.mp-btn-leave { background: #ef4444; width: 100%; margin-top: 6px; padding: 6px 0; border: none;',
      '  border-radius: 8px; color: white; font-weight: 800; font-size: 11px; cursor: pointer; }',
      '.mp-status { margin-top: 7px; font-size: 11px; color: #cbd5e1; line-height: 1.4; }',
      '.mp-count { margin-top: 4px; font-size: 11px; color: #a7f3d0; font-weight: 700; }',
      '.mp-link { margin-top: 3px; font-size: 10px; font-weight: 700; }',
      '.mp-panel.min { width: auto; }',
      '.mp-panel.min .mp-body { display: none; }'
    ].join('\n');
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    /* ================= UI ================= */
    var panel = document.createElement('div');
    panel.className = 'mp-panel';
    panel.id = 'mpPanel';
    panel.innerHTML =
      '<h3>🌐 MULTIPLAYER <button class="min">–</button></h3>' +
      '<div class="mp-body">' +
      '<input id="mpName" maxlength="12" placeholder="Your name">' +
      '<input id="mpCode" maxlength="6" placeholder="Room code e.g. 4821">' +
      '<div class="row">' +
      '<button class="act mp-btn-create" id="mpCreate">CREATE</button>' +
      '<button class="act mp-btn-join" id="mpJoin">JOIN</button>' +
      '</div>' +
      '<div class="mp-status" id="mpStatus">Pick a room code. First player CREATEs, friends JOIN.</div>' +
      '<div class="mp-count" id="mpCount"></div>' +
      '<div class="mp-link" id="mpLink"></div>' +
      '<button class="mp-btn-leave" id="mpLeave">LEAVE</button>' +
      '</div>';
    document.body.appendChild(panel);

    var nameEl = document.getElementById('mpName');
    var codeEl = document.getElementById('mpCode');
    var statusEl = document.getElementById('mpStatus');
    var countEl = document.getElementById('mpCount');
    var linkEl = document.getElementById('mpLink');
    try { nameEl.value = localStorage.getItem('mpname') || 'Player'; } catch (e) {}

    function status(msg) { statusEl.textContent = msg; }
    function updateCount(n) {
      countEl.textContent = n ? ('Players online: ' + n) : '';
    }
    panel.querySelector('.min').addEventListener('click', function () {
      panel.classList.toggle('min');
    });

    /* ================= state ================= */
    var myName = nameEl.value || 'Player';
    var myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    var isHost = false;
    var peer = null;
    var conns = [];
    var hostConn = null;
    var myNetId = null;
    var joinerStates = {};
    var players = {};
    var myOrigin = { x: 0, z: 0 };

    // link health + auto-reconnect bookkeeping
    var recvCount = 0;        // packets received
    var lastRecvTime = 0;     // ms timestamp of last received packet
    var joinedAt = 0;         // ms timestamp when we joined/created
    var lastReconnAt = 0;     // ms timestamp of last reconnect attempt
    var reconnectTries = 0;
    var reconGaveUp = false;
    var myJoinCode = null;    // remembered so auto-reconnect can rejoin
    var PeerCtorSaved = null;

    function myState() {
      return { id: myNetId, name: myName, color: myColor,
        x: carState.x, z: carState.z, angle: carState.angle,
        ox: myOrigin.x, oz: myOrigin.z };
    }

    function markRecv() { recvCount++; lastRecvTime = Date.now(); }

    function updateLink() {
      if (!myNetId) { linkEl.textContent = ''; return; }
      if (recvCount > 0) {
        var age = Math.floor((Date.now() - lastRecvTime) / 1000);
        linkEl.textContent = 'Link: OK - ' + recvCount + ' msgs' +
          (age >= 3 ? ' (' + age + 's quiet)' : '');
        linkEl.style.color = age >= 8 ? '#fbbf24' : '#4ade80';
      } else {
        var wait = joinedAt ? Math.floor((Date.now() - joinedAt) / 1000) : 0;
        linkEl.textContent = 'Link: no data yet (' + wait + 's)...';
        linkEl.style.color = '#fbbf24';
      }
    }

    /* ================= PeerJS acquisition ================= */
    function getPeerCtor() {
      try { if (window.parent && window.parent.Peer) return window.parent.Peer; } catch (e) {}
      return window.Peer || null;
    }
    function ensurePeer(then, fail) {
      var P = getPeerCtor();
      if (P) { then(P); return; }
      status('Loading network...');
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = function () {
        var P2 = getPeerCtor();
        if (P2) then(P2); else fail();
      };
      s.onerror = function () {
        var s2 = document.createElement('script');
        s2.src = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
        s2.onload = function () {
          var P3 = getPeerCtor();
          if (P3) then(P3); else fail();
        };
        s2.onerror = fail;
        document.head.appendChild(s2);
      };
      document.head.appendChild(s);
    }

    /* ================= remote cars ================= */
    function makeNameSprite(name) {
      var canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 64;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgba(15,23,42,0.75)';
      ctx.fillRect(28, 6, 200, 52);
      ctx.font = 'bold 30px Arial';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(name).slice(0, 12), 128, 42);
      var tex = new THREE.CanvasTexture(canvas);
      var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
      spr.scale.set(5, 1.25, 1);
      spr.position.y = 3.1;
      return spr;
    }

    function buildRemoteCar(colorHex, name) {
      var g = new THREE.Group();
      var body = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 0.7, 4.2),
        new THREE.MeshPhongMaterial({ color: colorHex }));
      body.position.y = 0.6;
      body.castShadow = true;
      var cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.55, 2.0),
        new THREE.MeshPhongMaterial({ color: 0x1e3a8a }));
      cabin.position.set(0, 1.15, -0.2);
      cabin.castShadow = true;
      g.add(body); g.add(cabin);
      var wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12);
      var wheelMat = new THREE.MeshPhongMaterial({ color: 0x111111 });
      var pos = [[-0.95, 1.4], [0.95, 1.4], [-0.95, -1.5], [0.95, -1.5]];
      for (var i = 0; i < pos.length; i++) {
        var wh = new THREE.Mesh(wheelGeo, wheelMat);
        wh.rotation.z = Math.PI / 2;
        wh.position.set(pos[i][0], 0.42, pos[i][1]);
        g.add(wh);
      }
      try { g.add(makeNameSprite(name)); } catch (eSpr) {}
      // Tall light pillar above the car so friends can spot each other
      // from far away (kids drive in different directions fast!)
      try {
        var beacon = new THREE.Mesh(
          new THREE.CylinderGeometry(0.8, 0.8, 40, 8),
          new THREE.MeshBasicMaterial({ color: colorHex, transparent: true,
            opacity: 0.5, depthWrite: false }));
        beacon.position.y = 20;
        g.add(beacon);
      } catch (eBeacon) {}
      scene.add(g);
      return g;
    }

    function addOrUpdateRemote(p) {
      var r = players[p.id];
      if (!r) {
        r = players[p.id] = {
          group: buildRemoteCar(p.color, p.name),
          tx: p.x, tz: p.z, ta: p.angle,
          cx: p.x, cz: p.z, ca: p.angle
        };
      }
      r.tx = p.x + (p.ox - myOrigin.x);
      r.tz = p.z + (p.oz - myOrigin.z);
      r.ta = p.angle;
    }

    function removeRemote(id) {
      var r = players[id];
      if (r) { scene.remove(r.group); delete players[id]; }
    }

    function clearRemotes() {
      Object.keys(players).forEach(removeRemote);
    }

    /* Move every remote car toward its network target.
       ANTI-OVERLAP: if the remote car would be drawn within 5 units of MY
       car (both players spawn at the same spot!), push its display
       position out to 7 units so the friend's car is always visible
       parked next to yours. True positions are still tracked - this only
       affects the display when cars are very close. */
    function stepRemotes() {
      Object.keys(players).forEach(function (pid) {
        var r = players[pid];
        if (!r || !r.group) return;
        var dx = r.tx - carState.x, dz = r.tz - carState.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        var ox = 0, oz = 0;
        if (d < 5) {
          var want = 7;
          if (d < 0.5) { ox = want; }
          else { ox = (dx / d) * (want - d); oz = (dz / d) * (want - d); }
          // deterministic side flip per player id so two friends never stack
          var flip = 1, s = String(pid);
          for (var q = 0; q < s.length; q++) flip += s.charCodeAt(q);
          if (flip % 2 === 0) { ox = -ox; oz = -oz; }
        }
        r.cx += (r.tx + ox - r.cx) * 0.2;
        r.cz += (r.tz + oz - r.cz) * 0.2;
        var da = r.ta - r.ca;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        r.ca += da * 0.2;
        r.group.position.set(r.cx, 0, r.cz);
        r.group.rotation.y = r.ca;
      });
    }

    /* ================= network reset ================= */
    function resetNet() {
      isHost = false;
      if (peer) { try { peer.destroy(); } catch (e) {} }
      peer = null; conns = []; hostConn = null; myNetId = null;
      joinerStates = {};
      clearRemotes();
      recvCount = 0; lastRecvTime = 0; joinedAt = 0;
      updateCount(0);
      updateLink();
    }

    /* ================= HOST ================= */
    function startHost(code, PeerCtor) {
      resetNet();
      isHost = true;
      status('Connecting...');
      peer = new PeerCtor('acmp-' + code + '-h');
      peer.on('open', function (id) {
        myNetId = id;
        joinedAt = Date.now(); lastRecvTime = joinedAt;
        status('Room ' + code + ' is LIVE! When a friend joins, their car parks right beside yours!');
      });
      peer.on('connection', function (conn) {
        conns.push(conn);
        conn.on('data', function (msg) {
          try {
            if (msg && msg.t === 'me') {
              markRecv();
              joinerStates[conn.peer] = {
                id: conn.peer, name: msg.name, color: msg.color,
                x: msg.x, z: msg.z, angle: msg.angle, ox: msg.ox, oz: msg.oz
              };
              try { addOrUpdateRemote(joinerStates[conn.peer]); } catch (e2) {}
              status('Friend connected! Look beside your car - and up at the glowing pillar!');
            }
          } catch (e) {}
        });
        conn.on('close', function () {
          conns = conns.filter(function (c) { return c !== conn; });
          delete joinerStates[conn.peer];
          removeRemote(conn.peer);
        });
      });
      peer.on('error', function (err) {
        if (err.type === 'unavailable-id') status('Room ' + code + ' already exists — press JOIN instead!');
        else status('Error: ' + err.type);
      });
    }

    /* ================= JOIN ================= */
    function startJoin(code, PeerCtor) {
      resetNet();
      status('Connecting...');
      peer = new PeerCtor();
      peer.on('open', function (id) {
        myNetId = id;
        // JSON serialization: no binary chunking, packets cannot silently
        // vanish. The host side adopts the initiator's serialization.
        hostConn = peer.connect('acmp-' + code + '-h',
          { reliable: true, serialization: 'json' });
        hostConn.on('open', function () {
          joinedAt = Date.now(); lastRecvTime = joinedAt;
          status('Joined room ' + code + '! Friend car parks right NEXT TO your car!');
          hostConn.on('data', function (msg) {
            try {
              if (msg && msg.t === 'all') {
                markRecv();
                var seen = {};
                for (var i = 0; i < msg.players.length; i++) {
                  var p = msg.players[i];
                  seen[p.id] = true;
                  if (p.id !== myNetId) {
                    try { addOrUpdateRemote(p); } catch (e2) {}
                  }
                }
                Object.keys(players).forEach(function (pid) {
                  if (!seen[pid]) removeRemote(pid);
                });
                updateCount(msg.players.length);
              }
            } catch (e) {}
          });
          hostConn.on('close', function () {
            status('Disconnected from host.');
            clearRemotes();
            updateCount(0);
          });
        });
      });
      peer.on('error', function (err) {
        if (err.type === 'peer-unavailable') status('Room ' + code + ' not found. Check the code!');
        else status('Error: ' + err.type);
      });
    }

    /* auto-reconnect: joiner only, if no data at all is coming through */
    function maybeReconnect() {
      if (isHost || !myJoinCode || !PeerCtorSaved || reconGaveUp) return;
      if (reconnectTries >= 5) {
        reconGaveUp = true;
        status('Connection is shaky. Press LEAVE, then JOIN again.');
        return;
      }
      var now = Date.now();
      if (recvCount > 0 && now - lastRecvTime < 15000) return;   // data flowing
      if (recvCount === 0 && joinedAt > 0 && now - joinedAt < 8000) return; // just joined
      if (joinedAt === 0) return;                                // still dialing
      if (now - lastReconnAt < 20000) return;                    // don't spam
      lastReconnAt = now; reconnectTries++;
      status('Reconnecting (try ' + reconnectTries + '/5)...');
      var code = myJoinCode, P = PeerCtorSaved;
      resetNet();
      startJoin(code, P);
    }

    /* ================= 10Hz send loop ================= */
    setInterval(function () {
      try {
        if (myNetId) {
          var s = myState();
          if (isHost) {
            var list = [s];
            Object.keys(joinerStates).forEach(function (k) { list.push(joinerStates[k]); });
            for (var i = 0; i < conns.length; i++) {
              if (conns[i].open) {
                try { conns[i].send({ t: 'all', players: list }); } catch (e) {}
              }
            }
            updateCount(list.length);
          } else if (hostConn && hostConn.open) {
            try {
              hostConn.send({ t: 'me', name: myName, color: myColor,
                x: s.x, z: s.z, angle: s.angle, ox: s.ox, oz: s.oz });
            } catch (e) {}
          }
        }
        try { stepRemotes(); } catch (e2) {}
        try { updateLink(); } catch (e3) {}
        try { maybeReconnect(); } catch (e4) {}
      } catch (e) {}
    }, 100);

    // ================= patch update: remotes + recenter tracking =================
    // The game has TWO kinds of big position jumps and they must be
    // treated differently:
    //   a) WORLD WRAP (drive past 500 units): the game teleports the car
    //      back to (0,0) AND shifts the whole world (ground, roads, trees)
    //      by the same amount. Our origin offset must grow by the jump.
    //   b) RESET (R key / Reset button): the car teleports to (0,0) but
    //      the world does NOT move. Origins must NOT change — the car
    //      really did teleport to a different true-world spot.
    // We tell them apart by watching the ground mesh: on a wrap the
    // ground shifts by the same delta; on a reset it stays put.
    var origUpdate = window.update;
    var groundRef = (typeof ground !== 'undefined') ? ground : null;
    window.update = function () {
      var prevX = carState.x, prevZ = carState.z;
      var g0x = groundRef ? groundRef.position.x : 0;
      var g0z = groundRef ? groundRef.position.z : 0;
      origUpdate.apply(this, arguments);
      try {
        var jumpX = prevX - carState.x;
        var jumpZ = prevZ - carState.z;
        if (Math.abs(jumpX) > 100 || Math.abs(jumpZ) > 100) {
          var worldMoved = groundRef &&
            Math.abs((g0x - groundRef.position.x) - jumpX) < 15 &&
            Math.abs((g0z - groundRef.position.z) - jumpZ) < 15;
          if (worldMoved) {
            // real wrap: shift my origin so remote car positions stay true
            myOrigin.x += jumpX;
            myOrigin.z += jumpZ;
            Object.keys(players).forEach(function (pid) {
              var r = players[pid];
              r.cx -= jumpX; r.cz -= jumpZ;
              r.tx -= jumpX; r.tz -= jumpZ;
            });
          }
          // Reset teleport: do nothing. Origins stay correct and the next
          // network update (10x per second) re-places every remote car.
        }
      } catch (e) {}
      try { stepRemotes(); } catch (e2) {}
    };

    /* ================= buttons ================= */
    function cleanCode() {
      return (codeEl.value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    }
    document.getElementById('mpCreate').addEventListener('click', function () {
      myName = (nameEl.value || 'Player').slice(0, 12);
      try { localStorage.setItem('mpname', myName); } catch (e) {}
      myJoinCode = null; // host path: no auto-reconnect
      var code = cleanCode();
      if (!code) {
        code = String(Math.floor(1000 + Math.random() * 9000));
        codeEl.value = code;
      }
      ensurePeer(function (PeerCtor) { startHost(code, PeerCtor); },
        function () { status('No network for multiplayer 😢'); });
    });
    document.getElementById('mpJoin').addEventListener('click', function () {
      myName = (nameEl.value || 'Player').slice(0, 12);
      try { localStorage.setItem('mpname', myName); } catch (e) {}
      var code = cleanCode();
      if (!code) { status('Type the room code first!'); return; }
      reconnectTries = 0; reconGaveUp = false; lastReconnAt = 0;
      myJoinCode = code;
      ensurePeer(function (PeerCtor) {
        PeerCtorSaved = PeerCtor;
        startJoin(code, PeerCtor);
      }, function () { status('No network for multiplayer 😢'); });
    });
    document.getElementById('mpLeave').addEventListener('click', function () {
      myJoinCode = null; PeerCtorSaved = null;
      reconnectTries = 0; reconGaveUp = false;
      resetNet();
      status('Left the room. Pick a code and CREATE or JOIN.');
    });
  })();
})();
