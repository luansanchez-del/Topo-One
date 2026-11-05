// API do TOPO ONE — Cloudflare Pages Functions (Workers) + D1.
// Toda rota exige login, exceto /api/entrar e /api/setup.
import {
  agoraISO, tokenAleatorio, sha256, gerarHashSenha, conferirSenha,
  assinarHmac, senhaProvisoria, senhaFraca,
} from '../../lib/seguranca.js';
import {
  COLECOES, PERFIS, PERFIS_LOGIN, MODULO_COLECOES,
  permissoesDoPerfil, filtrarLeitura, protegerEscrita,
} from '../../lib/permissoes.js';

const COOKIE = '__Host-topo_sessao';
const SESSAO_HORAS = 12;
const MAX_FALHAS_EMAIL = 5, MAX_FALHAS_IP = 20, JANELA_MIN = 15;
const LOTE_MAX = 15;               // registros por requisição (limite de consultas do plano grátis)
const TAM_MAX_REGISTRO = 400_000;  // bytes de JSON por registro
const SEP = '\u001f';

class Erro extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const json = (dados, status = 200, extra = {}) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

export async function onRequest(ctx) {
  const { request, env } = ctx;
  try {
    if (!env.DB) throw new Erro(500, 'Banco de dados D1 não configurado (binding DB).');
    const url = new URL(request.url);
    const rota = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
    const metodo = request.method;

    if (metodo !== 'GET' && metodo !== 'HEAD') verificarOrigem(request, url);

    // Rotas públicas
    if (rota === 'entrar' && metodo === 'POST') return await entrar(request, env);
    if (rota === 'setup' && metodo === 'POST') return await setup(request, env);
    if (rota === 'setup' && metodo === 'GET') return json({ disponivel: await setupDisponivel(env) });

    // Daqui em diante, só com sessão válida
    const s = await sessaoAtual(request, env);
    if (!s) throw new Erro(401, 'Faça login para continuar.');

    if (rota === 'eu' && metodo === 'GET') return json(perfilResposta(s.usuario));
    if (rota === 'sair' && metodo === 'POST') return await sair(s, env);
    if (rota === 'senha' && metodo === 'POST') return await trocarSenha(request, env, s);

    if (s.usuario.trocar_senha) throw new Erro(403, 'Troque a senha provisória para continuar.');

    const perms = permissoesDoPerfil(s.usuario.perfil);
    if (rota === 'dados' && metodo === 'GET') return await lerTudo(env, perms);
    if (rota === 'mudancas' && metodo === 'GET') return await lerMudancas(env, perms, url.searchParams.get('desde'));
    if (rota === 'sincronizar' && metodo === 'POST') return await sincronizar(request, env, s, perms);
    if (rota === 'automacoes/entregar' && metodo === 'POST') return await entregarAutomacao(request, env, perms);

    const cfg = PERFIS[s.usuario.perfil] || {};
    if (rota.startsWith('admin/')) {
      if (rota === 'admin/usuarios' && metodo === 'GET') return await listarAcessos(env, cfg);
      if (rota === 'admin/usuarios' && metodo === 'POST') return await criarAcesso(request, env, s, cfg);
      const m = rota.match(/^admin\/usuarios\/(\d+)$/);
      if (m && metodo === 'POST') return await alterarAcesso(request, env, s, cfg, Number(m[1]));
      if (rota === 'admin/importar' && metodo === 'POST') return await importar(request, env, s, cfg);
      if (rota === 'admin/auditoria' && metodo === 'GET') return await lerAuditoria(env, cfg, url);
    }
    throw new Erro(404, 'Rota não encontrada.');
  } catch (e) {
    if (e instanceof Erro) return json({ erro: e.message }, e.status);
    console.error('erro interno', e && e.stack || e);
    return json({ erro: 'Erro interno. Tente novamente.' }, 500);
  }
}

/* ---------------- utilitários ---------------- */

function verificarOrigem(request, url) {
  // Proteção contra requisições forjadas por outros sites (CSRF).
  if (request.headers.get('x-topo') !== '1') throw new Erro(403, 'Requisição não autorizada.');
  const origem = request.headers.get('origin');
  if (origem && origem !== url.origin) throw new Erro(403, 'Origem não autorizada.');
}

async function lerCorpo(request, max = 1_000_000) {
  const tam = Number(request.headers.get('content-length') || 0);
  if (tam > max) throw new Erro(413, 'Envio grande demais.');
  const texto = await request.text();
  if (texto.length > max) throw new Erro(413, 'Envio grande demais.');
  try { return JSON.parse(texto || '{}'); } catch { throw new Erro(400, 'JSON inválido.'); }
}

const ipDe = (request) => request.headers.get('cf-connecting-ip') || '';
const iter = (env) => Math.min(100000, Math.max(10000, Number(env.PBKDF2_ITER) || 100000));
const somaHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();

function cookieSessao(token, horas) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.round(horas * 3600)}`;
}

function perfilResposta(u) {
  const perms = permissoesDoPerfil(u.perfil);
  const cfg = PERFIS[u.perfil] || {};
  const modulos = Object.entries(MODULO_COLECOES).filter(([, cs]) => cs.some((c) => perms[c])).map(([m]) => m);
  return {
    usuario: { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, trocarSenha: !!u.trocar_senha },
    permissoes: perms, modulos,
    gerenciarAcessos: !!cfg.gerenciarAcessos, importar: !!cfg.importar,
    perfis: PERFIS_LOGIN,
  };
}

function auditar(env, dados) {
  return env.DB.prepare(
    'INSERT INTO auditoria (em, usuario_id, acao, colecao, registro_id, antes, versao, ip) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(agoraISO(), dados.usuario ?? null, dados.acao, dados.colecao ?? null, dados.id ?? null,
    dados.antes ?? null, dados.versao ?? null, dados.ip ?? null);
}

/* ---------------- sessão e login ---------------- */

async function sessaoAtual(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[-]/g, '\\-')}=([A-Za-z0-9_-]{20,})`));
  if (!m) return null;
  const th = await sha256(m[1]);
  const r = await env.DB.prepare(
    `SELECT s.token_hash, s.expira_em, u.id, u.email, u.nome, u.perfil, u.trocar_senha, u.ativo
       FROM sessoes s JOIN usuarios_acesso u ON u.id = s.usuario_id WHERE s.token_hash = ?`
  ).bind(th).first();
  if (!r || !r.ativo || r.expira_em < agoraISO()) return null;
  // Renova a sessão quando passou da metade do prazo (evita gravações a cada acesso).
  if (r.expira_em < somaHoras(SESSAO_HORAS / 2)) {
    await env.DB.prepare('UPDATE sessoes SET expira_em = ? WHERE token_hash = ?').bind(somaHoras(SESSAO_HORAS), th).run();
  }
  return { tokenHash: th, usuario: r };
}

async function bloqueado(env, chave) {
  const r = await env.DB.prepare('SELECT bloqueado_ate FROM tentativas_login WHERE chave = ?').bind(chave).first();
  return r && r.bloqueado_ate && r.bloqueado_ate > agoraISO();
}

async function registrarFalha(env, chave, limite) {
  const agora = agoraISO();
  const r = await env.DB.prepare('SELECT falhas, primeira_em FROM tentativas_login WHERE chave = ?').bind(chave).first();
  const janelaInicio = new Date(Date.now() - JANELA_MIN * 60e3).toISOString();
  let falhas = 1, primeira = agora;
  if (r && r.primeira_em > janelaInicio) { falhas = r.falhas + 1; primeira = r.primeira_em; }
  const bloq = falhas >= limite ? new Date(Date.now() + JANELA_MIN * 60e3).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO tentativas_login (chave, falhas, primeira_em, bloqueado_ate) VALUES (?,?,?,?)
     ON CONFLICT(chave) DO UPDATE SET falhas = excluded.falhas, primeira_em = excluded.primeira_em, bloqueado_ate = excluded.bloqueado_ate`
  ).bind(chave, falhas, primeira, bloq).run();
}

async function entrar(request, env) {
  const { email, senha } = await lerCorpo(request, 10_000);
  const em = String(email || '').trim().toLowerCase();
  const ip = ipDe(request);
  if (!em || !senha) throw new Erro(400, 'Informe e-mail e senha.');
  const kEmail = 'email:' + em, kIp = 'ip:' + ip;
  if (await bloqueado(env, kEmail) || (ip && await bloqueado(env, kIp)))
    throw new Erro(429, `Muitas tentativas. Aguarde ${JANELA_MIN} minutos.`);

  const u = await env.DB.prepare('SELECT * FROM usuarios_acesso WHERE email = ?').bind(em).first();
  const ok = u && u.ativo && await conferirSenha(String(senha), u.senha_hash);
  if (!ok) {
    await registrarFalha(env, kEmail, MAX_FALHAS_EMAIL);
    if (ip) await registrarFalha(env, kIp, MAX_FALHAS_IP);
    await auditar(env, { usuario: u?.id, acao: 'login_falhou', ip }).run();
    throw new Erro(401, 'E-mail ou senha incorretos.');
  }
  const token = tokenAleatorio();
  const agora = agoraISO();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em, ip, agente) VALUES (?,?,?,?,?,?)')
      .bind(await sha256(token), u.id, agora, somaHoras(SESSAO_HORAS), ip, (request.headers.get('user-agent') || '').slice(0, 200)),
    env.DB.prepare('UPDATE usuarios_acesso SET ultimo_login = ? WHERE id = ?').bind(agora, u.id),
    env.DB.prepare('DELETE FROM tentativas_login WHERE chave = ?').bind(kEmail),
    env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora),
    await auditar(env, { usuario: u.id, acao: 'login', ip }),
  ]);
  return json(perfilResposta(u), 200, { 'set-cookie': cookieSessao(token, SESSAO_HORAS) });
}

async function sair(s, env) {
  await env.DB.prepare('DELETE FROM sessoes WHERE token_hash = ?').bind(s.tokenHash).run();
  return json({ ok: true }, 200, { 'set-cookie': cookieSessao('', 0) });
}

async function trocarSenha(request, env, s) {
  const { atual, nova } = await lerCorpo(request, 10_000);
  const u = await env.DB.prepare('SELECT senha_hash FROM usuarios_acesso WHERE id = ?').bind(s.usuario.id).first();
  if (!u || !await conferirSenha(String(atual || ''), u.senha_hash)) throw new Erro(400, 'Senha atual incorreta.');
  const fraca = senhaFraca(nova);
  if (fraca) throw new Erro(400, fraca);
  if (nova === atual) throw new Erro(400, 'A nova senha precisa ser diferente da atual.');
  await env.DB.batch([
    env.DB.prepare('UPDATE usuarios_acesso SET senha_hash = ?, trocar_senha = 0 WHERE id = ?')
      .bind(await gerarHashSenha(String(nova), iter(env)), s.usuario.id),
    // Encerra as outras sessões deste usuário.
    env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ? AND token_hash <> ?').bind(s.usuario.id, s.tokenHash),
    await auditar(env, { usuario: s.usuario.id, acao: 'senha_trocada', ip: ipDe(request) }),
  ]);
  return json(perfilResposta({ ...s.usuario, trocar_senha: 0 }));
}

async function setupDisponivel(env) {
  if (!env.SETUP_TOKEN) return false;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM usuarios_acesso').first();
  return r.n === 0;
}

// Cria o primeiro administrador. Só funciona com o banco sem usuários e com o SETUP_TOKEN correto.
async function setup(request, env) {
  const { token, email, nome, senha } = await lerCorpo(request, 10_000);
  if (!await setupDisponivel(env)) throw new Erro(403, 'Configuração inicial indisponível.');
  if (!token || token !== env.SETUP_TOKEN) throw new Erro(403, 'Código de configuração inválido.');
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new Erro(400, 'E-mail inválido.');
  const fraca = senhaFraca(senha);
  if (fraca) throw new Erro(400, fraca);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO usuarios_acesso (email, nome, perfil, senha_hash, trocar_senha, criado_em) VALUES (?,?,?,?,0,?)')
      .bind(em, String(nome || 'Administrador').trim().slice(0, 80), 'Superadministrador técnico',
        await gerarHashSenha(String(senha), iter(env)), agoraISO()),
    await auditar(env, { acao: 'setup_admin', ip: ipDe(request) }),
  ]);
  return json({ ok: true });
}

/* ---------------- dados ---------------- */

const colecoesLiveis = (perms) => COLECOES.filter((c) => perms[c]);

function montarRegistro(perms, r) {
  const dados = filtrarLeitura(r.colecao, JSON.parse(r.dados), perms);
  return dados == null ? null : dados;
}

async function lerTudo(env, perms) {
  const agora = agoraISO();
  const cols = colecoesLiveis(perms);
  const { results } = await env.DB.prepare(
    'SELECT colecao, id, dados, versao FROM registros WHERE excluido = 0 AND colecao IN (SELECT value FROM json_each(?))'
  ).bind(JSON.stringify(cols)).all();
  const dados = Object.fromEntries(cols.map((c) => [c, []]));
  const versoes = Object.fromEntries(cols.map((c) => [c, {}]));
  for (const r of results) {
    const d = montarRegistro(perms, r);
    if (d == null) continue;
    dados[r.colecao].push(d);
    versoes[r.colecao][r.id] = r.versao;
  }
  // Mantém a ordem natural de cada coleção (eventos: mais recentes primeiro).
  for (const c of cols) {
    dados[c].sort((a, b) => (c === 'eventos' ? String(b.em).localeCompare(String(a.em)) : (Number(a.id) || 0) - (Number(b.id) || 0)));
  }
  const meta = await lerMeta(env);
  return json({ dados, versoes, meta, agora });
}

async function lerMeta(env) {
  const { results } = await env.DB.prepare('SELECT chave, valor FROM meta').all();
  return Object.fromEntries(results.map((r) => [r.chave, JSON.parse(r.valor)]));
}

async function lerMudancas(env, perms, desde) {
  if (!desde || isNaN(Date.parse(desde))) throw new Erro(400, 'Parâmetro "desde" inválido.');
  const agora = agoraISO();
  const { results } = await env.DB.prepare(
    `SELECT colecao, id, dados, versao, excluido FROM registros
      WHERE atualizado_em > ? AND colecao IN (SELECT value FROM json_each(?)) ORDER BY atualizado_em LIMIT 500`
  ).bind(desde, JSON.stringify(colecoesLiveis(perms))).all();
  const mudancas = [];
  for (const r of results) {
    const d = r.excluido ? null : montarRegistro(perms, r);
    if (!r.excluido && d == null) continue;
    mudancas.push({ colecao: r.colecao, id: r.id, versao: r.versao, excluido: !!r.excluido, dados: d });
  }
  return json({ mudancas, agora, completo: results.length < 500 });
}

const chaveReg = (c, id) => c + SEP + id;
const iguais = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function buscarAtuais(env, itens) {
  const chaves = itens.map((m) => chaveReg(m.colecao, m.id));
  const { results } = await env.DB.prepare(
    `SELECT colecao, id, dados, versao, excluido FROM registros
      WHERE colecao || char(31) || id IN (SELECT value FROM json_each(?))`
  ).bind(JSON.stringify(chaves)).all();
  return new Map(results.map((r) => [chaveReg(r.colecao, r.id), r]));
}

function validarItem(m) {
  if (!m || typeof m !== 'object') throw new Erro(400, 'Mudança inválida.');
  if (!COLECOES.includes(m.colecao)) throw new Erro(400, `Coleção desconhecida: ${m.colecao}`);
  m.id = String(m.id ?? '');
  if (!m.id || m.id.length > 100) throw new Erro(400, 'Identificador inválido.');
  if (m.dados != null) {
    if (typeof m.dados !== 'object' || Array.isArray(m.dados)) throw new Erro(400, 'Registro inválido.');
    if (JSON.stringify(m.dados).length > TAM_MAX_REGISTRO) throw new Erro(413, 'Registro grande demais.');
  }
}

function upsert(env, c, id, dados, versao, excluido, usuarioId, versaoEsperada) {
  const agora = agoraISO();
  // A condição em versao evita sobrescrever uma gravação simultânea de outra pessoa.
  return env.DB.prepare(
    `INSERT INTO registros (colecao, id, dados, versao, excluido, criado_em, atualizado_em, atualizado_por)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(colecao, id) DO UPDATE SET dados = excluded.dados, versao = excluded.versao, excluido = excluded.excluido,
       atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por
     WHERE registros.versao = ?`
  ).bind(c, id, JSON.stringify(dados), versao, excluido ? 1 : 0, agora, agora, usuarioId, versaoEsperada);
}

async function gravarMeta(env, meta, stmts) {
  if (!meta || typeof meta !== 'object') return;
  const entradas = Object.entries(meta).slice(0, 20);
  for (const [k, v] of entradas) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) continue;
    const s = JSON.stringify(v ?? null);
    if (s.length > 10_000) continue;
    stmts.push(env.DB.prepare(
      'INSERT INTO meta (chave, valor, atualizado_em) VALUES (?,?,?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em'
    ).bind(k, s, agoraISO()));
  }
}

async function sincronizar(request, env, s, perms) {
  const corpo = await lerCorpo(request);
  const itens = Array.isArray(corpo.mudancas) ? corpo.mudancas : [];
  if (itens.length > LOTE_MAX) throw new Erro(400, `Envie no máximo ${LOTE_MAX} registros por vez.`);
  itens.forEach(validarItem);

  const ok = [], conflitos = [], negados = [];
  const stmts = [];
  const permitidos = itens.filter((m) => {
    if (perms[m.colecao] === 'w') return true;
    negados.push({ colecao: m.colecao, id: m.id });
    return false;
  });
  const atuais = permitidos.length ? await buscarAtuais(env, permitidos) : new Map();
  const ip = ipDe(request);

  for (const m of permitidos) {
    const cur = atuais.get(chaveReg(m.colecao, m.id));
    const base = m.base == null ? null : Number(m.base);
    const curDados = cur ? JSON.parse(cur.dados) : null;

    if (m.dados == null) { // exclusão
      if (!cur || cur.excluido) { ok.push({ colecao: m.colecao, id: m.id, versao: cur?.versao ?? 0 }); continue; }
      if (base !== cur.versao) { conflitos.push(conflito(m, cur, perms)); continue; }
      const v = cur.versao + 1;
      stmts.push(upsert(env, m.colecao, m.id, curDados, v, true, s.usuario.id, cur.versao));
      stmts.push(await auditar(env, { usuario: s.usuario.id, acao: 'excluir', colecao: m.colecao, id: m.id, antes: cur.dados, versao: v, ip }));
      ok.push({ colecao: m.colecao, id: m.id, versao: v });
      continue;
    }

    const dados = protegerEscrita(m.colecao, m.dados, curDados, perms);
    if (!cur) {
      stmts.push(upsert(env, m.colecao, m.id, dados, 1, false, s.usuario.id, 0));
      stmts.push(await auditar(env, { usuario: s.usuario.id, acao: 'criar', colecao: m.colecao, id: m.id, versao: 1, ip }));
      ok.push({ colecao: m.colecao, id: m.id, versao: 1 });
      continue;
    }
    if (!cur.excluido && iguais(curDados, dados)) { ok.push({ colecao: m.colecao, id: m.id, versao: cur.versao }); continue; }
    const podeGravar = cur.excluido ? (base == null || base === cur.versao) : base === cur.versao;
    if (!podeGravar) { conflitos.push(conflito(m, cur, perms)); continue; }
    const v = cur.versao + 1;
    stmts.push(upsert(env, m.colecao, m.id, dados, v, false, s.usuario.id, cur.versao));
    stmts.push(await auditar(env, { usuario: s.usuario.id, acao: cur.excluido ? 'recriar' : 'editar', colecao: m.colecao, id: m.id, antes: cur.dados, versao: v, ip }));
    ok.push({ colecao: m.colecao, id: m.id, versao: v });
  }

  if (Object.values(perms).includes('w')) await gravarMeta(env, corpo.meta, stmts);
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok, conflitos, negados });
}

function conflito(m, cur, perms) {
  return {
    colecao: m.colecao, id: m.id, versao: cur.versao, excluido: !!cur.excluido,
    dados: cur.excluido ? null : filtrarLeitura(m.colecao, JSON.parse(cur.dados), perms),
  };
}

/* ---------------- automações (webhooks) ---------------- */

async function entregarAutomacao(request, env, perms) {
  if (!Object.values(perms).includes('w')) throw new Erro(403, 'Sem permissão.');
  const { automacao_id, evento } = await lerCorpo(request, 200_000);
  const r = await env.DB.prepare("SELECT dados FROM registros WHERE colecao = 'automacoes' AND id = ? AND excluido = 0")
    .bind(String(automacao_id)).first();
  if (!r) throw new Erro(404, 'Automação não encontrada.');
  const a = JSON.parse(r.dados);
  if (!a.ativa) return json({ status: 'inativa' });
  if (!evento || !Array.isArray(a.eventos) || !a.eventos.includes(evento.tipo)) throw new Erro(400, 'Evento não inscrito nesta automação.');
  let destino;
  try { destino = new URL(a.url); } catch { throw new Erro(400, 'Link inválido.'); }
  if (destino.protocol !== 'https:') throw new Erro(400, 'O link precisa ser HTTPS.');
  if (destino.host === new URL(request.url).host) throw new Erro(400, 'Link não permitido.');

  const corpo = JSON.stringify({ evento: evento.tipo, id: evento.id, ocorrido_em: evento.em, origem: 'TOPO ONE', dados: evento.dados });
  const headers = { 'content-type': 'application/json', 'x-topo-evento': String(evento.tipo) };
  if (env.WEBHOOK_SECRET) headers['x-topo-assinatura'] = 'sha256=' + await assinarHmac(env.WEBHOOK_SECRET, corpo);
  try {
    const resp = await fetch(destino.toString(), { method: 'POST', headers, body: corpo, signal: AbortSignal.timeout(8000), redirect: 'manual' });
    return json({ status: resp.ok ? 'enviado' : 'falhou', http: resp.status });
  } catch (e) {
    return json({ status: 'falhou', motivo: 'O destino não respondeu.' });
  }
}

/* ---------------- administração ---------------- */

function exigir(cfg, chave) { if (!cfg[chave]) throw new Erro(403, 'Sem permissão para esta ação.'); }

async function listarAcessos(env, cfg) {
  exigir(cfg, 'gerenciarAcessos');
  const { results } = await env.DB.prepare(
    'SELECT id, email, nome, perfil, ativo, trocar_senha, criado_em, ultimo_login FROM usuarios_acesso ORDER BY nome'
  ).all();
  return json({ usuarios: results, perfis: PERFIS_LOGIN });
}

async function criarAcesso(request, env, s, cfg) {
  exigir(cfg, 'gerenciarAcessos');
  const { email, nome, perfil } = await lerCorpo(request, 10_000);
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new Erro(400, 'E-mail inválido.');
  if (!PERFIS[perfil]) throw new Erro(400, 'Perfil inválido.');
  if (perfil === 'Superadministrador técnico' && !cfg.importar) throw new Erro(403, 'Só o superadministrador cria outro superadministrador.');
  const existe = await env.DB.prepare('SELECT id FROM usuarios_acesso WHERE email = ?').bind(em).first();
  if (existe) throw new Erro(409, 'Já existe um acesso com este e-mail.');
  const prov = senhaProvisoria();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO usuarios_acesso (email, nome, perfil, senha_hash, trocar_senha, criado_em) VALUES (?,?,?,?,1,?)')
      .bind(em, String(nome || em).trim().slice(0, 80), perfil, await gerarHashSenha(prov, iter(env)), agoraISO()),
    await auditar(env, { usuario: s.usuario.id, acao: 'acesso_criado', registro_id: em, id: em, ip: ipDe(request) }),
  ]);
  return json({ ok: true, senhaProvisoria: prov });
}

async function alterarAcesso(request, env, s, cfg, id) {
  exigir(cfg, 'gerenciarAcessos');
  const { perfil, ativo, redefinirSenha } = await lerCorpo(request, 10_000);
  const u = await env.DB.prepare('SELECT * FROM usuarios_acesso WHERE id = ?').bind(id).first();
  if (!u) throw new Erro(404, 'Acesso não encontrado.');
  if (u.perfil === 'Superadministrador técnico' && !cfg.importar) throw new Erro(403, 'Só o superadministrador altera este acesso.');
  if (id === s.usuario.id && (ativo === false || (perfil && perfil !== u.perfil))) throw new Erro(400, 'Você não pode desativar nem trocar o próprio perfil.');
  const stmts = [];
  let prov = null;
  if (perfil !== undefined) {
    if (!PERFIS[perfil]) throw new Erro(400, 'Perfil inválido.');
    if (perfil === 'Superadministrador técnico' && !cfg.importar) throw new Erro(403, 'Sem permissão.');
    stmts.push(env.DB.prepare('UPDATE usuarios_acesso SET perfil = ? WHERE id = ?').bind(perfil, id));
  }
  if (ativo !== undefined) stmts.push(env.DB.prepare('UPDATE usuarios_acesso SET ativo = ? WHERE id = ?').bind(ativo ? 1 : 0, id));
  if (redefinirSenha) {
    prov = senhaProvisoria();
    stmts.push(env.DB.prepare('UPDATE usuarios_acesso SET senha_hash = ?, trocar_senha = 1 WHERE id = ?').bind(await gerarHashSenha(prov, iter(env)), id));
  }
  if (!stmts.length) throw new Erro(400, 'Nada para alterar.');
  if (ativo === false || redefinirSenha || perfil !== undefined) stmts.push(env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(id));
  stmts.push(await auditar(env, { usuario: s.usuario.id, acao: 'acesso_alterado', id: String(id), antes: JSON.stringify({ perfil: u.perfil, ativo: u.ativo }), ip: ipDe(request) }));
  await env.DB.batch(stmts);
  return json({ ok: true, senhaProvisoria: prov });
}

// Importa registros de um backup (em lotes). modo "novos" só cria o que não existe; "substituir" sobrescreve.
async function importar(request, env, s, cfg) {
  exigir(cfg, 'importar');
  const corpo = await lerCorpo(request);
  const itens = Array.isArray(corpo.registros) ? corpo.registros : [];
  const modo = corpo.modo === 'substituir' ? 'substituir' : 'novos';
  if (itens.length > LOTE_MAX) throw new Erro(400, `Envie no máximo ${LOTE_MAX} registros por vez.`);
  itens.forEach((m) => { validarItem(m); if (m.dados == null) throw new Erro(400, 'Registro vazio no backup.'); });
  const atuais = itens.length ? await buscarAtuais(env, itens) : new Map();
  const stmts = [];
  let criados = 0, substituidos = 0, ignorados = 0;
  const ip = ipDe(request);
  for (const m of itens) {
    const cur = atuais.get(chaveReg(m.colecao, m.id));
    if (cur && !cur.excluido && modo === 'novos') { ignorados++; continue; }
    const v = cur ? cur.versao + 1 : 1;
    stmts.push(upsert(env, m.colecao, m.id, m.dados, v, false, s.usuario.id, cur ? cur.versao : 0));
    stmts.push(await auditar(env, { usuario: s.usuario.id, acao: 'importar', colecao: m.colecao, id: m.id, antes: cur?.dados ?? null, versao: v, ip }));
    cur ? substituidos++ : criados++;
  }
  await gravarMeta(env, corpo.meta, stmts);
  if (stmts.length) await env.DB.batch(stmts);
  return json({ criados, substituidos, ignorados });
}

async function lerAuditoria(env, cfg, url) {
  exigir(cfg, 'gerenciarAcessos');
  const limite = Math.min(500, Number(url.searchParams.get('limite')) || 100);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.em, a.acao, a.colecao, a.registro_id, a.versao, u.nome AS usuario
       FROM auditoria a LEFT JOIN usuarios_acesso u ON u.id = a.usuario_id ORDER BY a.id DESC LIMIT ?`
  ).bind(limite).all();
  return json({ registros: results });
}
