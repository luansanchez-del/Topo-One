// Senhas, tokens e assinaturas usando apenas a Web Crypto nativa do Cloudflare Workers.

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const agoraISO = () => new Date().toISOString();

export function tokenAleatorio(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(texto) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(texto)));
}

// PBKDF2-SHA256. O número de iterações fica gravado no hash, então pode ser ajustado depois.
export async function gerarHashSenha(senha, iteracoes) {
  const sal = new Uint8Array(16);
  crypto.getRandomValues(sal);
  const h = await derivar(senha, sal, iteracoes);
  return `pbkdf2$sha256$${iteracoes}$${b64(sal)}$${b64(h)}`;
}

export async function conferirSenha(senha, armazenado) {
  const [alg, , it, salB64, hashB64] = String(armazenado).split('$');
  if (alg !== 'pbkdf2') return false;
  const h = new Uint8Array(await derivar(senha, deB64(salB64), Number(it)));
  const esperado = deB64(hashB64);
  if (h.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < h.length; i++) dif |= h[i] ^ esperado[i];
  return dif === 0;
}

async function derivar(senha, sal, iteracoes) {
  const chave = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteracoes }, chave, 256);
}

export async function assinarHmac(segredo, texto) {
  const chave = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', chave, enc.encode(texto)));
}

export function senhaProvisoria() {
  // 14 caracteres sem ambíguos (0/O, 1/l).
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(14);
  crypto.getRandomValues(a);
  return [...a].map((n) => alfabeto[n % alfabeto.length]).join('');
}

export function senhaFraca(s) {
  s = String(s || '');
  if (s.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Use letras e números na senha.';
  return '';
}
