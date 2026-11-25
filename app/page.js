import { redirect } from 'next/navigation';
// La interfaz vive en public/index.html (generada desde client/brisa.html).
export default function Home() { redirect('/index.html'); }
