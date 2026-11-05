// Testes da API com DADOS FICTÍCIOS. Rode com o servidor local ligado:
//   npm run db:migrar:local && npm run dev   (em outro terminal)   e depois   npm test
// Use um banco local limpo: os testes criam o primeiro administrador.
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const SETUP = process.env.SETUP_TOKEN || 'teste-setup-123456';
let falhas = 0, ok = 0;
const check = (cond, nome) => { if (cond) { ok++; console.log('  ✓', nome); } else { falhas++; console.log('  ✗', nome); } };

function cliente() {
  let cookie = '';
  return async (caminho, { method = 'GET', body, semCsrf, origem } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) { headers['content-type'] = 'application/json'; method = method === 'GET' ? 'POST' : method; }
    if (method !== 'GET' && !semCsrf) headers['x-topo'] = '1';
    if (origem) headers.origin = origem;
    const r = await fetch(BASE + '/api/' + caminho, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };
}

const admin = cliente();
console.log('Configuração inicial e login');
check((await admin('eu')).status === 401, 'sem login a API recusa');
check((await admin('setup', { body: { token: 'errado', email: 'admin@exemplo.test', nome: 'Admin Teste', senha: 'SenhaForte123' } })).status === 403, 'setup com código errado é recusado');
check((await admin('setup', { body: { token: SETUP, email: 'admin@exemplo.test', nome: 'Admin Teste', senha: 'curta' } })).status === 400, 'senha fraca é recusada');
check((await admin('setup', { body: { token: SETUP, email: 'admin@exemplo.test', nome: 'Admin Teste', senha: 'SenhaForte123' } })).status === 200, 'cria o superadministrador');
check((await admin('setup', { body: { token: SETUP, email: 'outro@exemplo.test', nome: 'X', senha: 'SenhaForte123' } })).status === 403, 'setup não pode ser repetido');
check((await admin('entrar', { body: { email: 'admin@exemplo.test', senha: 'SenhaForte123' }, semCsrf: true })).status === 403, 'login sem cabeçalho anti-CSRF é recusado');
check((await admin('entrar', { body: { email: 'admin@exemplo.test', senha: 'SenhaForte123' }, origem: 'https://site-malicioso.test' })).status === 403, 'login vindo de outro site é recusado');
check((await admin('entrar', { body: { email: 'admin@exemplo.test', senha: 'errada' } })).status === 401, 'senha errada é recusada');
const login = await admin('entrar', { body: { email: 'ADMIN@exemplo.test', senha: 'SenhaForte123' } });
check(login.status === 200 && login.j.importar === true, 'login do administrador funciona (e-mail sem diferenciar maiúsculas)');

console.log('Gravação e leitura');
const leilao = { id: 9001, nome: 'Leilão fictício de teste', cidade: 'Cidade Teste', responsavel: 'Guilherme', status: 'Publicado', valor: 100000, modalidade: 'Judicial', comissaoPct: 5, link: '', fin: { etapa: 'gerada', arrematado: 120000, nota: '', recebidoEm: '', evidencia: '', hist: [] } };
const titulo = { id: 1, leilao: 9001, conta: 'guilherme', tipo: 'Comissão', descricao: 'Comissão fictícia', valor: 6000, status: 'Em aberto' };
let r = await admin('sincronizar', { body: { mudancas: [
  { colecao: 'leiloes', id: '9001', base: null, dados: leilao },
  { colecao: 'receber', id: '1', base: null, dados: titulo },
], meta: { siteLeitura: '2026-11-04', semExemplos: true } } });
check(r.status === 200 && r.j.ok.length === 2, 'cria registros');
r = await admin('dados');
check(r.j.dados.leiloes.length === 1 && r.j.dados.receber.length === 1 && r.j.meta.semExemplos === true, 'lê registros e meta');
const v1 = r.j.versoes.leiloes['9001'];
r = await admin('sincronizar', { body: { mudancas: [{ colecao: 'leiloes', id: '9001', base: v1, dados: { ...leilao, status: 'Em leilão' } }] } });
check(r.j.ok[0].versao === v1 + 1, 'edita com a versão correta');
r = await admin('sincronizar', { body: { mudancas: [{ colecao: 'leiloes', id: '9001', base: v1, dados: { ...leilao, status: 'Encerrado' } }] } });
check(r.j.conflitos.length === 1 && r.j.conflitos[0].dados.status === 'Em leilão', 'edição simultânea vira conflito e não sobrescreve');
r = await admin('sincronizar', { body: { mudancas: [{ colecao: 'colecao_falsa', id: '1', base: null, dados: {} }] } });
check(r.status === 400, 'coleção desconhecida é recusada');
const muitos = Array.from({ length: 16 }, (_, i) => ({ colecao: 'tarefas', id: String(i + 1), base: null, dados: { id: i + 1, texto: 'x' } }));
check((await admin('sincronizar', { body: { mudancas: muitos } })).status === 400, 'lote acima do limite é recusado');

console.log('Acessos e permissões');
r = await admin('admin/usuarios', { body: { nome: 'Marketing Teste', email: 'mkt@exemplo.test', perfil: 'Marketing' } });
check(r.status === 200 && r.j.senhaProvisoria.length >= 12, 'cria acesso com senha provisória');
const prov = r.j.senhaProvisoria;
const mkt = cliente();
r = await mkt('entrar', { body: { email: 'mkt@exemplo.test', senha: prov } });
check(r.status === 200 && r.j.usuario.trocarSenha === true, 'primeiro acesso exige troca de senha');
check((await mkt('dados')).status === 403, 'sem trocar a senha não lê dados');
r = await mkt('senha', { body: { atual: prov, nova: 'MinhaSenha2026' } });
check(r.status === 200, 'troca a senha provisória');
r = await mkt('dados');
check(r.status === 200 && !('receber' in r.j.dados), 'Marketing não recebe o Financeiro');
check(r.j.dados.leiloes[0] && !('fin' in r.j.dados.leiloes[0]) && !('comissaoPct' in r.j.dados.leiloes[0]), 'Marketing não vê comissão nem dados financeiros do leilão');
const vMkt = r.j.versoes.leiloes['9001'];
r = await mkt('sincronizar', { body: { mudancas: [{ colecao: 'leiloes', id: '9001', base: vMkt, dados: { id: 9001, nome: 'x' } }] } });
check(r.j.negados.length === 1, 'Marketing não pode editar leilões (só leitura)');
r = await mkt('sincronizar', { body: { mudancas: [{ colecao: 'receber', id: '2', base: null, dados: { id: 2, valor: 1 } }] } });
check(r.j.negados.length === 1, 'Marketing não grava no Financeiro');
r = await mkt('sincronizar', { body: { mudancas: [{ colecao: 'campanhas', id: '1', base: null, dados: { id: 1, nome: 'Campanha fictícia' } }] } });
check(r.j.ok.length === 1, 'Marketing grava campanhas');
check((await mkt('admin/usuarios')).status === 403, 'Marketing não gerencia acessos');
check((await mkt('admin/importar', { body: { registros: [] } })).status === 403, 'Marketing não importa backup');

// Operacional pode editar leilão, mas não altera os campos financeiros
r = await admin('admin/usuarios', { body: { nome: 'Operacional Teste', email: 'op@exemplo.test', perfil: 'Operacional' } });
const op = cliente();
await op('entrar', { body: { email: 'op@exemplo.test', senha: r.j.senhaProvisoria } });
await op('senha', { body: { atual: r.j.senhaProvisoria, nova: 'Operacional2026' } });
r = await op('dados');
r = await op('sincronizar', { body: { mudancas: [{ colecao: 'leiloes', id: '9001', base: r.j.versoes.leiloes['9001'], dados: { ...r.j.dados.leiloes[0], status: 'Pós-leilão', fin: { etapa: 'recebida', arrematado: 1 }, comissaoPct: 99 } }] } });
check(r.j.ok.length === 1, 'Operacional edita o leilão');
r = await admin('dados');
const l = r.j.dados.leiloes[0];
check(l.status === 'Pós-leilão' && l.comissaoPct === 5 && l.fin.arrematado === 120000, 'campos financeiros ficam protegidos');

console.log('Mudanças, exclusão e importação');
const antes = new Date(Date.now() - 60000).toISOString();
r = await admin('mudancas?desde=' + encodeURIComponent(antes));
check(r.status === 200 && r.j.mudancas.length >= 3, 'lista mudanças recentes');
r = await admin('dados');
r = await admin('sincronizar', { body: { mudancas: [{ colecao: 'receber', id: '1', base: r.j.versoes.receber['1'], dados: null }] } });
check(r.j.ok.length === 1, 'exclui registro (exclusão lógica)');
r = await admin('dados');
check(r.j.dados.receber.length === 0, 'registro excluído some da leitura');
r = await admin('admin/importar', { body: { modo: 'novos', registros: [
  { colecao: 'leiloes', id: '9001', dados: { id: 9001, nome: 'não deve sobrescrever' } },
  { colecao: 'lotes', id: '1', dados: { id: 1, leilao: 9001, descricao: 'Lote fictício' } },
] } });
check(r.j.criados === 1 && r.j.ignorados === 1, 'importação "só novos" não sobrescreve');
r = await admin('admin/auditoria');
check(r.status === 200 && r.j.registros.some((a) => a.acao === 'excluir'), 'auditoria registra as ações');

console.log('Sessão');
await mkt('sair', { method: 'POST' });
check((await mkt('dados')).status === 401, 'após sair a sessão não vale mais');
const bruto = cliente();
for (let i = 0; i < 5; i++) await bruto('entrar', { body: { email: 'op@exemplo.test', senha: 'errada' + i } });
check((await bruto('entrar', { body: { email: 'op@exemplo.test', senha: 'Operacional2026' } })).status === 429, 'bloqueia após 5 senhas erradas');

console.log(`\n${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
