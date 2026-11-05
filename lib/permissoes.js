// Permissões do TOPO ONE, aplicadas no servidor.
// Baseado na "Matriz de permissões" (rascunho) do módulo Pessoas.
// 'w' = ler e gravar · 'r' = só ler · ausente = sem acesso.

// Coleções de dados de cada módulo do sistema.
export const MODULO_COLECOES = {
  leiloes:     ['leiloes'],
  lotes:       ['lotes'],
  processos:   ['processos'],
  tarefas:     ['tarefas'],
  comercial:   ['leads'],
  marketing:   ['campanhas'],
  financeiro:  ['receber', 'contas', 'extratos', 'despesas'],
  pessoas:     ['usuarios'],
  integracoes: ['automacoes'],
};
export const COLECOES = [...Object.values(MODULO_COLECOES).flat(), 'eventos'];

const TUDO = (n) => Object.fromEntries(Object.keys(MODULO_COLECOES).map((m) => [m, n]));

// Escopo de cada perfil por módulo. Ajuste aqui quando a matriz for aprovada.
export const PERFIS = {
  'Superadministrador técnico': { modulos: TUDO('w'), gerenciarAcessos: true, importar: true },
  'Diretoria':           { modulos: TUDO('w'), gerenciarAcessos: true },
  'Leiloeiro oficial':   { modulos: TUDO('w') },
  'Gerente operacional': { modulos: TUDO('w') },
  'Coordenador de setor':{ modulos: { ...TUDO('w'), financeiro: 'r', pessoas: 'r', integracoes: 'r' } },
  'Operacional':         { modulos: { leiloes: 'w', lotes: 'w', tarefas: 'w', processos: 'r' } },
  'Jurídico':            { modulos: { processos: 'w', tarefas: 'w', leiloes: 'r', lotes: 'r' } },
  'Comercial':           { modulos: { comercial: 'w', tarefas: 'w', leiloes: 'r', lotes: 'r' } },
  'Marketing':           { modulos: { marketing: 'w', tarefas: 'w', leiloes: 'r', lotes: 'r' } },
  'Financeiro':          { modulos: { financeiro: 'w', leiloes: 'w', tarefas: 'w', lotes: 'r' } },
  'Contábil':            { modulos: { financeiro: 'r', leiloes: 'r', lotes: 'r' } },
  'Auditoria':           { modulos: TUDO('r') },
  'Parceiro / Comitente':{ modulos: { leiloes: 'r', lotes: 'r' } },
};
export const PERFIS_LOGIN = Object.keys(PERFIS);

// Permissão por coleção para um perfil.
export function permissoesDoPerfil(perfil) {
  const p = PERFIS[perfil];
  const out = {};
  if (!p) return out;
  for (const [mod, nivel] of Object.entries(p.modulos)) {
    for (const c of MODULO_COLECOES[mod] || []) out[c] = nivel;
  }
  // Eventos (histórico de automações): todos leem; quem grava em algum módulo também registra eventos.
  out.eventos = Object.values(p.modulos).includes('w') ? 'w' : 'r';
  return out;
}

export const veFinanceiro = (perms) => !!perms.receber;

// Campos financeiros dentro de um leilão: só aparecem para quem acessa o Financeiro.
const CAMPOS_FIN_LEILAO = ['fin', 'comissaoPct'];

// Remove dados financeiros de um registro para quem não pode vê-los.
export function filtrarLeitura(colecao, dados, perms) {
  if (veFinanceiro(perms)) return dados;
  if (colecao === 'leiloes') {
    const d = { ...dados };
    for (const k of CAMPOS_FIN_LEILAO) delete d[k];
    return d;
  }
  if (colecao === 'eventos' && dados && dados.modulo === 'financeiro') return null;
  return dados;
}

// Ao gravar, quem não vê o Financeiro não pode alterar os campos financeiros do leilão.
export function protegerEscrita(colecao, novo, atual, perms) {
  if (veFinanceiro(perms) || colecao !== 'leiloes' || !novo) return novo;
  const d = { ...novo };
  for (const k of CAMPOS_FIN_LEILAO) {
    if (atual && k in atual) d[k] = atual[k];
    else delete d[k];
  }
  return d;
}
