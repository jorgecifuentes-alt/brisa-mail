// Arranca la conexión IMAP en vivo junto con el servidor, para que los avisos push
// funcionen aunque nadie tenga la app abierta.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureStarted } = await import('./lib/live.js');
    ensureStarted();
    const { startJobs } = await import('./lib/jobs.js');
    startJobs();
  }
}
