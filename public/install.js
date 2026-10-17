// Aviso de instalación (web y celular). Chrome/Edge/Android: botón que abre el cuadro nativo.
// iPhone/iPad: instrucciones de "Agregar a pantalla de inicio". No se muestra si la app ya está instalada.
(function () {
  var KEY = 'lmh-install-dismissed', DAYS = 7, DELAY = 2500;
  var evt = null, banner = null;
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isFirefoxDesktop = /Firefox/.test(ua) && !/Android/.test(ua);   // Firefox de escritorio no instala apps web
  function installed() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function dismissedRecently() {
    try { var t = Number(localStorage.getItem(KEY)); return t && Date.now() - t < DAYS * 86400000; } catch (e) { return false; }
  }
  function remember() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }
  function notify() { window.dispatchEvent(new Event('lmh-install-change')); }

  window.lmhInstall = {
    canPrompt: function () { return !!evt; },
    prompt: function () {
      if (!evt) return;
      var e = evt; evt = null; hide(); notify();
      e.prompt();
      if (e.userChoice) e.userChoice.then(function (c) { if (c && c.outcome === 'accepted') remember(); });
    },
  };

  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); evt = e; notify(); if (banner) fill(); });
  window.addEventListener('appinstalled', function () { evt = null; remember(); hide(); notify(); });

  function hide() { if (banner) { banner.remove(); banner = null; document.body.classList.remove('has-install'); } }
  function text() {
    if (evt) return ['Instalá LMH Empleo', 'Abrila como una app, con acceso directo y sin la barra del navegador.'];
    if (isIOS) return ['Instalá LMH Empleo en tu iPhone', 'Tocá el botón Compartir (el cuadrado con la flecha hacia arriba) y elegí «Agregar a pantalla de inicio».'];
    return ['Instalá LMH Empleo', 'Desde el menú del navegador (⋮ o el ícono de instalar en la barra de direcciones) elegí «Instalar app» o «Agregar a pantalla de inicio».'];
  }
  function fill() {
    var t = text();
    banner.querySelector('strong').textContent = t[0];
    banner.querySelector('p').textContent = t[1];
    banner.querySelector('[data-act="install"]').hidden = !evt;
  }
  function show() {
    if (banner || installed() || dismissedRecently() || isFirefoxDesktop || !document.body) return;
    banner = document.createElement('div');
    banner.className = 'install-banner'; banner.setAttribute('role', 'region'); banner.setAttribute('aria-label', 'Instalar la aplicación');
    banner.innerHTML = '<img src="/icons/icon-192.png" alt="" width="44" height="44"><div class="txt"><strong></strong><p></p></div>' +
      '<div class="act"><button type="button" class="primary" data-act="install">Instalar</button><button type="button" class="link" data-act="later">Ahora no</button></div>';
    banner.querySelector('[data-act="install"]').addEventListener('click', function () { window.lmhInstall.prompt(); });
    banner.querySelector('[data-act="later"]').addEventListener('click', function () { remember(); hide(); });
    document.body.appendChild(banner);
    document.body.classList.add('has-install');
    fill();
  }
  function start() { setTimeout(show, DELAY); }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
