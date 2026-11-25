// Genera public/index.html a partir de client/brisa.html (la misma interfaz publicada en claude.ai),
// envolviéndola en un documento completo y cargando el adaptador local (public/shim.js) antes que todo.
import { readFile, writeFile } from 'node:fs/promises';

const src = await readFile(new URL('../client/brisa.html', import.meta.url), 'utf8');

// Textos que en claude.ai hablan del conector de Gmail; aquí el correo llega por IMAP/SMTP.
const swaps = [
  ['Gmail conectado', 'Correo conectado'],
  ['Tu bandeja real, con tus permisos.', 'Tu servidor IMAP/SMTP.'],
  ['Conecta tu Gmail para trabajar con tu bandeja real.', 'Conecta tu servidor de correo para ver tu bandeja real.'],
  ['Conectar Gmail', 'Conectar correo'],
  ['No se pudo cargar Gmail', 'No se pudo cargar el correo'],
  ['Cargando tu bandeja de Gmail…', 'Cargando tu bandeja…'],
  ['Buscando en Gmail…', 'Buscando…'],
  ['Tu sesión de Gmail venció. Reconéctala en claude.ai › Configuración › Conectores.', 'El servidor rechazó el usuario o la contraseña. Revisa IMAP_USER e IMAP_PASS en .env.local.'],
  ['Gmail no respondió. Intenta de nuevo en un momento.', 'No se pudo conectar con el servidor de correo. Revisa IMAP_HOST y tu conexión.'],
  ['Gmail rechazó la acción.', 'El servidor de correo rechazó la acción.'],
  ['No se pudo completar la acción en Gmail.', 'No se pudo completar la acción en el servidor de correo.'],
  ['La IA no está disponible en esta página.', 'La IA no está disponible. Revisa ANTHROPIC_API_KEY en .env.local.'],
  ['El dictado no está disponible aquí. Funciona en Chrome o en la app de escritorio de Claude.', 'El dictado no está disponible en este navegador. Usa Chrome o Edge.'],
  ['El dictado está desactivado para esta página. Puedes activarlo en el menú Permisos.', 'El navegador bloqueó el micrófono. Permítelo en la configuración del sitio.'],
  ['El dictado por voz funciona en Chrome o en la app de escritorio de Claude.', 'El dictado por voz funciona en Chrome o Edge.'],
  ['Abre esta página en claude.ai para conectar Gmail.', 'Configura IMAP y SMTP en .env.local.'],
  ['Abre esta página en la app de escritorio de Claude para instalarla.', 'Usa el menú del navegador: Instalar app o Agregar a pantalla de inicio.'],
  ['No se pudo instalar la app. Intenta desde el menú del artefacto.', 'No se pudo instalar. Usa el menú del navegador: Instalar app.'],
  ['Vuelve a iniciar sesión en claude.ai.', 'Recarga la página e inicia sesión de nuevo.'],
  ["(se revisa cada 30 segundos)", '(al instante)'],
  ['Para recibir avisos del sistema, instala Brisa como app.', 'Para recibir avisos del sistema, instala Brisa como app o actívalos en Firma, plantillas y avisos.'],
];
let body = src;
for (const [a, b] of swaps) body = body.split(a).join(b);

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='12' fill='%231D74F5'/%3E%3Cpath d='M6 9l6 4 6-4' stroke='white' stroke-width='2' fill='none'/%3E%3C/svg%3E">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:0}html,body{height:100%}body{margin:0;font:14px/1.4 system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<meta name="theme-color" content="#F2F3F6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111316" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Brisa">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>Brisa Mail</title>
<script src="/shim.js"></script>
</head><body>
${body}
</body></html>
`;
await writeFile(new URL('../public/index.html', import.meta.url), html);
console.log('public/index.html generado');
