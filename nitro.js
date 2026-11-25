/*
 * nitro.js - loader for the NITRO add-on (parent page side).
 *
 * WHY A LOADER: the game (index.html) declares its main objects with
 * `const scene`, `const carState`, `const input` ... Top-level const/let
 * bindings live in the global lexical scope and are NOT properties of
 * window, so a parent-page script can never see them through the iframe.
 * The fix: inject nitro-core.js as a <script> INTO the iframe document.
 * Same-document scripts share the lexical scope and see everything.
 */
(function () {
  function inject() {
    var iframe = document.getElementById('gameFrame');
    if (!iframe || !iframe.contentDocument || !iframe.contentDocument.body) {
      setTimeout(inject, 150);
      return;
    }
    var d = iframe.contentDocument;
    if (d.getElementById('nitroCoreScript')) return;   // already injected
    if (d.getElementById('nitroFuelFill')) return;     // core already ran
    var s = d.createElement('script');
    s.id = 'nitroCoreScript';
    s.src = 'nitro-core.js';
    d.body.appendChild(s);
  }

  var iframe = document.getElementById('gameFrame');
  if (iframe) iframe.addEventListener('load', inject);
  if (document.readyState === 'complete') inject();
  else window.addEventListener('load', inject);
})();
