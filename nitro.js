/*
 * nitro.js - adds a NITRO button to the 3D Car Driving Game.
 * Loaded by nitro.html (which iframes index.html, the game).
 * Patches the game at runtime: injects the nitro button + fuel bar +
 * speed-lines overlay + orange flame glow, and adds nitro boost physics.
 */
(function () {
  function init() {
    var iframe = document.getElementById('gameFrame');
    if (!iframe) return;

    function setup() {
      var w = iframe.contentWindow;
      var d = w ? w.document : null;
      if (!w || !w.carState || !w.update || !w.scene || !w.THREE) {
        setTimeout(setup, 120);
        return;
      }

      /* ---------- CSS ---------- */
      var css = [
        '.pedals-group { position: relative; }',
        '.nitro-control {',
        '  position: absolute; bottom: calc(100% + 14px); right: 0;',
        '  display: flex; flex-direction: column; align-items: center; gap: 5px;',
        '  pointer-events: auto;',
        '}',
        '.nitro-btn {',
        '  width: 74px; height: 74px; border-radius: 50%;',
        '  border: 4px solid #a855f7; background: rgba(168,85,247,0.85);',
        '  color: white; font-size: 26px; font-weight: 800;',
        '  display: flex; flex-direction: column; align-items: center; justify-content: center;',
        '  cursor: pointer; transition: transform 0.08s; user-select: none; -webkit-user-select: none;',
        '  box-shadow: 0 8px 20px rgba(0,0,0,0.5), inset 0 -8px 16px rgba(0,0,0,0.3), 0 0 18px rgba(168,85,247,0.5);',
        '}',
        '.nitro-btn .lbl { font-size: 9px; font-weight: 700; letter-spacing: 1px; margin-top: 1px; text-transform: uppercase; }',
        '.nitro-btn.pressed {',
        '  background: rgba(168,85,247,1); transform: scale(0.92);',
        '  box-shadow: 0 0 30px rgba(168,85,247,0.95), inset 0 -8px 16px rgba(0,0,0,0.3);',
        '}',
        '.nitro-btn.disabled { opacity: 0.35; filter: grayscale(0.7);',
        '  box-shadow: 0 8px 20px rgba(0,0,0,0.5), inset 0 -8px 16px rgba(0,0,0,0.3); }',
        '.nitro-fuel { width: 58px; height: 7px; background: rgba(0,0,0,0.55);',
        '  border-radius: 4px; overflow: hidden; border: 1px solid rgba(255,255,255,0.25); }',
        '.nitro-fuel-fill { height: 100%; background: linear-gradient(90deg,#a855f7,#ec4899);',
        '  width: 100%; transition: width 0.08s linear; }',
        '.speedlines { position: fixed; inset: 0; pointer-events: none; z-index: 9; opacity: 0;',
        '  transition: opacity 0.15s;',
        '  background: repeating-linear-gradient(90deg, transparent 0, transparent 60px, rgba(255,255,255,0.07) 60px, rgba(255,255,255,0.07) 62px),',
        '    radial-gradient(ellipse at center, transparent 30%, rgba(168,85,247,0.14) 100%); }',
        '.speedlines.on { opacity: 1; animation: speedrush 0.4s linear infinite; }',
        '@keyframes speedrush { 0% { background-position: 0 0, 0 0; } 100% { background-position: -120px 0, 0 0; } }',
        '@media (max-width: 400px) { .nitro-btn { width: 60px; height: 60px; font-size: 22px; } .nitro-fuel { width: 48px; } }',
        '@media (min-width: 800px) { .nitro-btn { width: 84px; height: 84px; font-size: 30px; } .nitro-fuel { width: 68px; } }'
      ].join('\n');
      var st = d.createElement('style');
      st.textContent = css;
      d.head.appendChild(st);

      /* ---------- Nitro button ---------- */
      var pedals = d.querySelector('.pedals-group');
      if (!pedals) { setTimeout(setup, 120); return; }
      var ctrl = d.createElement('div');
      ctrl.className = 'nitro-control';
      ctrl.innerHTML =
        '<button class="nitro-btn" id="nitroBtn">🔥<span class="lbl">NITRO</span></button>' +
        '<div class="nitro-fuel"><div class="nitro-fuel-fill" id="nitroFuelFill"></div></div>';
      pedals.appendChild(ctrl);

      var nitroBtn = d.getElementById('nitroBtn');
      var nitroFill = d.getElementById('nitroFuelFill');

      /* ---------- State ---------- */
      w.input.nitro = false;
      w.nitroFuel = 100;
      w.nitroActive = false;

      /* ---------- Pointer binding (multi-touch safe) ---------- */
      var pid = null;
      function ndown(e) {
        if (pid !== null) return;
        e.preventDefault();
        pid = e.pointerId;
        try { nitroBtn.setPointerCapture(pid); } catch (err) {}
        w.input.nitro = true;
        nitroBtn.classList.add('pressed');
      }
      function nup(e) {
        if (e.pointerId !== pid) return;
        e.preventDefault();
        pid = null;
        try { nitroBtn.releasePointerCapture(e.pointerId); } catch (err) {}
        w.input.nitro = false;
        nitroBtn.classList.remove('pressed');
      }
      nitroBtn.addEventListener('pointerdown', ndown);
      nitroBtn.addEventListener('pointerup', nup);
      nitroBtn.addEventListener('pointercancel', nup);

      /* ---------- Keyboard (Shift / N / Space) ---------- */
      function kdown(e) {
        if (e.key === 'Shift' || e.key === 'n' || e.key === 'N' || e.key === ' ') {
          w.input.nitro = true; e.preventDefault();
        }
      }
      function kup(e) {
        if (e.key === 'Shift' || e.key === 'n' || e.key === 'N' || e.key === ' ') w.input.nitro = false;
      }
      w.addEventListener('keydown', kdown);
      w.addEventListener('keyup', kup);

      /* ---------- Nitro flame glow + speed-lines overlay ---------- */
      var nitroLight = new w.THREE.PointLight(0xff6b00, 0, 30, 2);
      w.scene.add(nitroLight);
      var sl = d.createElement('div');
      sl.className = 'speedlines';
      d.body.appendChild(sl);

      /* ---------- Patch applyCar to capture the base maxSpeed ---------- */
      if (w.applyCar && !w.applyCar._nitroPatched) {
        var origApply = w.applyCar;
        w.applyCar = function () {
          origApply.apply(this, arguments);
          w.carState._baseMaxSpeed = w.carState.maxSpeed;
        };
        w.applyCar._nitroPatched = true;
      }
      w.carState._baseMaxSpeed = w.carState.maxSpeed;

      /* ---------- Patch update: nitro boost + visuals ---------- */
      var origUpdate = w.update;
      w.update = function () {
        var base = w.carState._baseMaxSpeed || w.carState.maxSpeed;
        var wantNitro = w.input.nitro && (w.carState.nitroTanks || 0) > 0 &&
                        w.nitroFuel > 0 && w.carState.speed > 0.1;
        w.nitroActive = wantNitro;
        // raise the cap during nitro so the original clamp allows the boost
        w.carState.maxSpeed = wantNitro ? base * 1.6 : base;
        if (wantNitro) {
          w.carState.speed += w.carState.accel * 2.2;
          w.nitroFuel = Math.max(0, w.nitroFuel - 0.7);
        } else {
          w.nitroFuel = Math.min(100, w.nitroFuel + 0.2 + 0.15 * (w.carState.nitroTanks || 0));
        }
        origUpdate.apply(this, arguments);
        w.carState.maxSpeed = base; // restore so other logic sees the real value

        // orange flame glow behind the car (flickers)
        nitroLight.position.set(
          w.carState.x - Math.sin(w.carState.angle) * 2.5,
          1.2,
          w.carState.z - Math.cos(w.carState.angle) * 2.5
        );
        nitroLight.intensity = w.nitroActive ? (3.5 + Math.random() * 2.5) : 0;

        // UI: fuel bar + speed lines + disabled state
        if (nitroFill) nitroFill.style.width = w.nitroFuel + '%';
        sl.classList.toggle('on', w.nitroActive);
        nitroBtn.classList.toggle('disabled', (w.carState.nitroTanks || 0) <= 0);
      };

      // hide the intro hint so it doesn't cover the nitro button
      var hint = d.getElementById('hint');
      if (hint) hint.classList.add('hide');
    }

    iframe.addEventListener('load', setup);
    if (iframe.contentWindow && iframe.contentWindow.carState) setup();
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
})();
