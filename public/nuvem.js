/* TOPO ONE — camada de nuvem (login, sincronização com o D1, acessos e importação de backup).
 * Carregado antes do script principal. O script principal continua igual: ele lê e altera o objeto DB
 * e chama saveDB(); aqui essas alterações viram gravações registro a registro na API.
 */
(function () {
  'use strict';
  const COLECOES = ['leiloes', 'lotes', 'processos', 'tarefas', 'leads', 'campanhas', 'receber', 'contas', 'extratos', 'despesas', 'usuarios', 'automacoes', 'eventos'];
  const SEMPRE_VISIVEIS = ['inicio', 'documentos', 'relatorios', 'agentes', 'configuracoes'];
  const LOTE = 15, INTERVALO_MUDANCAS = 45000;

  const estado = {
    eu: null,            // resposta de /api/eu
    snap: {},            // colecao -> Map(id -> {json, versao}) : o que o servidor tem
    metaSnap: {},        // chave -> json
    ultimo: null,        // horário do servidor da última leitura
    sincronizando: false, pendente: false, tentativa: 0, timer: null,
  };

  /* ---------------- HTTP ---------------- */
  async function api(caminho, opcoes = {}) {
    const op = { method: 'GET', credentials: 'same-origin', headers: {}, ...opcoes };
    if (op.body !== undefined) { op.method = op.method === 'GET' ? 'POST' : op.method; op.headers['content-type'] = 'application/json'; op.body = JSON.stringify(op.body); }
    if (op.method !== 'GET') op.headers['x-topo'] = '1';
    let r;
    try { r = await fetch('/api/' + caminho, op); }
    catch (e) { const err = new Error('Sem conexão com o servidor.'); err.rede = true; throw err; }
    let dados = null;
    try { dados = await r.json(); } catch (e) { dados = null; }
    if (!r.ok) {
      const err = new Error((dados && dados.erro) || ('Erro ' + r.status));
      err.status = r.status;
      if (r.status === 401 && caminho !== 'entrar') sessaoExpirou();
      throw err;
    }
    return dados;
  }

  /* ---------------- tela de login ---------------- */
  const logo = () => document.querySelector('.mobile-logo')?.getAttribute('src') || '';
  function tela(html) {
    let el = document.getElementById('nuvemTela');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nuvemTela';
      el.className = 'nuvem-tela';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="nuvem-caixa"><img class="nuvem-logo" src="${logo()}" alt="Topo Leilões">${html}</div>`;
    el.hidden = false;
    document.querySelector('.app')?.setAttribute('aria-hidden', 'true');
    return el;
  }
  function fecharTela() {
    const el = document.getElementById('nuvemTela');
    if (el) { el.hidden = true; el.innerHTML = ''; }
    document.querySelector('.app')?.removeAttribute('aria-hidden');
  }
  const campo = (rotulo, nome, tipo = 'text', extra = '') =>
    `<label class="field">${rotulo}<input class="input" name="${nome}" type="${tipo}" required ${extra}></label>`;

  function pedirLogin(msg = '') {
    return new Promise((resolve) => {
      const el = tela(`<h1>Entrar no TOPO ONE</h1><p class="nuvem-sub">Central Inteligente de Operações</p>
        <form id="nvLogin" class="nuvem-form" autocomplete="on">
          ${campo('E-mail', 'email', 'email', 'autocomplete="username" inputmode="email"')}
          ${campo('Senha', 'senha', 'password', 'autocomplete="current-password"')}
          <button class="btn btn-primary" type="submit">Entrar</button>
          <p class="nuvem-msg" id="nvMsg" aria-live="polite">${msg}</p>
        </form>`);
      el.querySelector('input').focus();
      el.querySelector('#nvLogin').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const b = e.target.querySelector('button'); b.disabled = true;
        el.querySelector('#nvMsg').textContent = 'Entrando…';
        try { resolve(await api('entrar', { body: f })); }
        catch (err) { el.querySelector('#nvMsg').textContent = err.message; b.disabled = false; }
      };
    });
  }

  function pedirTrocaSenha(obrigatoria) {
    return new Promise((resolve, reject) => {
      const el = tela(`<h1>${obrigatoria ? 'Crie sua senha' : 'Trocar senha'}</h1>
        <p class="nuvem-sub">${obrigatoria ? 'Você entrou com uma senha provisória. Crie uma senha pessoal para continuar.' : 'Mínimo de 10 caracteres, com letras e números.'}</p>
        <form id="nvSenha" class="nuvem-form">
          ${campo(obrigatoria ? 'Senha provisória' : 'Senha atual', 'atual', 'password', 'autocomplete="current-password"')}
          ${campo('Nova senha', 'nova', 'password', 'autocomplete="new-password" minlength="10"')}
          ${campo('Repita a nova senha', 'nova2', 'password', 'autocomplete="new-password" minlength="10"')}
          <button class="btn btn-primary" type="submit">Salvar senha</button>
          ${obrigatoria ? '' : '<button class="btn btn-ghost" type="button" id="nvCancelar">Cancelar</button>'}
          <p class="nuvem-msg" id="nvMsg" aria-live="polite"></p>
        </form>`);
      el.querySelector('input').focus();
      const c = el.querySelector('#nvCancelar'); if (c) c.onclick = () => { fecharTela(); reject(new Error('cancelado')); };
      el.querySelector('#nvSenha').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        const m = el.querySelector('#nvMsg');
        if (f.nova !== f.nova2) { m.textContent = 'As senhas novas não são iguais.'; return; }
        try { resolve(await api('senha', { body: { atual: f.atual, nova: f.nova } })); }
        catch (err) { m.textContent = err.message; }
      };
    });
  }

  function pedirSetup() {
    return new Promise((resolve) => {
      const el = tela(`<h1>Primeiro acesso</h1><p class="nuvem-sub">Crie o superadministrador. Use o código de configuração definido na Cloudflare (SETUP_TOKEN).</p>
        <form id="nvSetup" class="nuvem-form">
          ${campo('Código de configuração', 'token', 'password', 'autocomplete="off"')}
          ${campo('Seu nome', 'nome')}
          ${campo('E-mail', 'email', 'email', 'autocomplete="username"')}
          ${campo('Senha', 'senha', 'password', 'autocomplete="new-password" minlength="10"')}
          <button class="btn btn-primary" type="submit">Criar administrador</button>
          <p class="nuvem-msg" id="nvMsg" aria-live="polite"></p>
        </form>`);
      el.querySelector('input').focus();
      el.querySelector('#nvSetup').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try { await api('setup', { body: f }); resolve(); }
        catch (err) { el.querySelector('#nvMsg').textContent = err.message; }
      };
    });
  }

  let reentrando = null;
  function sessaoExpirou() {
    if (reentrando || !estado.eu) return;
    reentrando = pedirLogin('Sua sessão expirou. Entre novamente.').then((eu) => {
      fecharTela(); reentrando = null;
      if (eu.usuario.id !== estado.eu.usuario.id) { location.reload(); return; }
      estado.eu = eu; agendar(0);
    });
  }

  /* ---------------- carga e sincronização ---------------- */
  const chaveId = (r) => String(r && r.id);

  function tirarFoto(dados, versoes, meta) {
    estado.snap = {};
    for (const c of COLECOES) {
      const m = new Map();
      for (const r of dados[c] || []) m.set(chaveId(r), { json: JSON.stringify(r), versao: (versoes[c] || {})[chaveId(r)] || 1 });
      estado.snap[c] = m;
    }
    estado.metaSnap = {};
    for (const [k, v] of Object.entries(meta || {})) estado.metaSnap[k] = JSON.stringify(v);
  }

  function metaLocal() {
    const out = {};
    for (const [k, v] of Object.entries(DB)) if (!Array.isArray(v) && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) out[k] = v;
    return out;
  }

  function calcularMudancas() {
    const mudancas = [];
    for (const c of COLECOES) {
      if (!estado.eu.permissoes[c]) continue;
      const snap = estado.snap[c] || new Map();
      const vistos = new Set();
      for (const r of DB[c] || []) {
        const id = chaveId(r);
        if (vistos.has(id)) { console.warn('[TOPO ONE] id repetido em', c, id); continue; }
        vistos.add(id);
        const s = snap.get(id), j = JSON.stringify(r);
        if (!s || s.json !== j) mudancas.push({ colecao: c, id, base: s ? s.versao : null, dados: r, _json: j });
      }
      for (const [id, s] of snap) if (!vistos.has(id)) mudancas.push({ colecao: c, id, base: s.versao, dados: null });
    }
    const meta = {};
    for (const [k, v] of Object.entries(metaLocal())) { const j = JSON.stringify(v); if (estado.metaSnap[k] !== j) meta[k] = v; }
    return { mudancas, meta };
  }

  function substituirLocal(c, id, dados) {
    const lista = DB[c] || (DB[c] = []);
    const i = lista.findIndex((r) => chaveId(r) === id);
    if (dados == null) { if (i >= 0) lista.splice(i, 1); }
    else if (i >= 0) lista[i] = dados;
    else if (c === 'eventos') lista.unshift(dados); else lista.push(dados);
  }

  function status(texto, tipo = '') {
    document.querySelectorAll('.nuvem-status').forEach((el) => { el.textContent = texto; el.dataset.tipo = tipo; });
    // Erro de gravação aparece também como aviso (o status fica escondido em telas pequenas).
    if (tipo === 'erro' && !estado.avisouErro) { estado.avisouErro = true; avisar(texto + '. Suas alterações continuam nesta tela; não feche a página.'); }
    if (tipo === 'ok') estado.avisouErro = false;
  }

  function agendar(ms = 600) {
    clearTimeout(estado.timer);
    estado.timer = setTimeout(sincronizar, ms);
    status('Salvando…');
  }

  async function sincronizar() {
    if (!estado.eu) return;
    if (estado.sincronizando) { estado.pendente = true; return; }
    estado.sincronizando = true; estado.pendente = false;
    let conflitos = 0;
    try {
      const { mudancas, meta } = calcularMudancas();
      if (!mudancas.length && !Object.keys(meta).length) { status('Tudo salvo', 'ok'); return; }
      for (let i = 0; i < Math.max(1, mudancas.length); i += LOTE) {
        const lote = mudancas.slice(i, i + LOTE);
        const resp = await api('sincronizar', { body: { mudancas: lote.map(({ _json, ...m }) => m), meta: i === 0 ? meta : undefined } });
        const porChave = new Map(lote.map((m) => [m.colecao + '\u001f' + m.id, m]));
        for (const o of resp.ok) {
          const m = porChave.get(o.colecao + '\u001f' + o.id);
          if (!m) continue;
          if (m.dados == null) estado.snap[o.colecao].delete(o.id);
          else estado.snap[o.colecao].set(o.id, { json: m._json, versao: o.versao });
        }
        for (const x of resp.conflitos) {
          conflitos++;
          substituirLocal(x.colecao, x.id, x.dados);
          if (x.dados == null) estado.snap[x.colecao].delete(x.id);
          else estado.snap[x.colecao].set(x.id, { json: JSON.stringify(x.dados), versao: x.versao });
        }
        for (const x of resp.negados) {
          const s = estado.snap[x.colecao]?.get(x.id);
          substituirLocal(x.colecao, x.id, s ? JSON.parse(s.json) : null);
        }
        if (i === 0) for (const [k, v] of Object.entries(meta)) estado.metaSnap[k] = JSON.stringify(v);
      }
      estado.tentativa = 0;
      status('Tudo salvo', 'ok');
      if (conflitos) {
        avisar(`${conflitos === 1 ? 'Um registro foi alterado' : conflitos + ' registros foram alterados'} por outra pessoa ao mesmo tempo. Mantive a versão já salva: confira e refaça sua alteração.`);
        try { App.refresh(); } catch (e) {}
      }
    } catch (e) {
      if (e.status === 401) { status('Entre novamente para salvar', 'erro'); }
      else {
        estado.tentativa++;
        const espera = Math.min(60000, 3000 * 2 ** (estado.tentativa - 1));
        status(e.rede ? 'Sem conexão · tentando de novo' : 'Erro ao salvar · tentando de novo', 'erro');
        console.error('[TOPO ONE] sincronização', e);
        estado.timer = setTimeout(sincronizar, espera);
      }
    } finally {
      estado.sincronizando = false;
      if (estado.pendente) agendar(200);
    }
  }

  function temPendencias() {
    if (!estado.eu || estado.eu.usuario.trocarSenha) return false;
    const { mudancas, meta } = calcularMudancas();
    return mudancas.length > 0 || Object.keys(meta).length > 0;
  }

  async function buscarMudancas() {
    if (!estado.eu || document.hidden || estado.sincronizando || !estado.ultimo) return;
    try {
      const desde = new Date(Date.parse(estado.ultimo) - 5000).toISOString();
      const r = await api('mudancas?desde=' + encodeURIComponent(desde));
      let mudou = false;
      for (const m of r.mudancas) {
        const snap = estado.snap[m.colecao]; if (!snap) continue;
        const s = snap.get(m.id);
        if (s && s.versao >= m.versao) continue;
        const local = (DB[m.colecao] || []).find((x) => chaveId(x) === m.id);
        // Se há edição local ainda não salva deste registro, a gravação resolve o conflito.
        if (local && s && JSON.stringify(local) !== s.json) continue;
        substituirLocal(m.colecao, m.id, m.excluido ? null : m.dados);
        if (m.excluido) snap.delete(m.id); else snap.set(m.id, { json: JSON.stringify(m.dados), versao: m.versao });
        mudou = true;
      }
      estado.ultimo = r.agora;
      const foco = document.activeElement;
      const editando = foco && /INPUT|TEXTAREA|SELECT/.test(foco.tagName) && !foco.closest('.search');
      if (mudou && !editando && !document.querySelector('.ai-modal.open')) { try { App.refresh(); } catch (e) {} }
    } catch (e) { /* tenta na próxima rodada */ }
  }

  function avisar(texto) {
    let el = document.getElementById('nuvemAviso');
    if (!el) { el = document.createElement('div'); el.id = 'nuvemAviso'; el.className = 'nuvem-aviso'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = texto; el.hidden = false;
    clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 9000);
  }

  /* ---------------- permissões na interface ---------------- */
  function aplicarPermissoes() {
    const liberados = new Set([...SEMPRE_VISIVEIS, ...estado.eu.modulos]);
    for (let i = MODULES.length - 1; i >= 0; i--) if (!liberados.has(MODULES[i].id)) MODULES.splice(i, 1);
    for (let i = ORDER.length - 1; i >= 0; i--) if (!liberados.has(ORDER[i])) ORDER.splice(i, 1);
    for (let i = RING.length - 1; i >= 0; i--) if (!liberados.has(RING[i][0])) RING.splice(i, 1);
  }

  function montarPerfil() {
    const u = estado.eu.usuario;
    const ini = (u.nome || u.email).split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'TO';
    const p = document.querySelector('.profile');
    if (!p) return;
    p.innerHTML = `<span class="avatar">${esc(ini)}</span><div><b>${esc(u.nome)}</b><small>${esc(u.perfil)} · <span class="nuvem-status" id="nuvemStatus">Tudo salvo</span></small></div>
      <button class="btn btn-ghost nuvem-sair" type="button" title="Sair">Sair</button>`;
    const foot = document.querySelector('.side-foot');
    if (foot) foot.innerHTML = `<div class="nuvem-conta"><b>${esc(u.nome)}</b><small>${esc(u.perfil)}</small><small class="nuvem-status">Tudo salvo</small>
      <button class="btn nuvem-sair-lateral nuvem-sair" type="button">Sair</button></div>
      <b>TOPO ONE v0.17</b><br>Central Inteligente de Operações<br>Dados na nuvem · acesso com login`;
    document.querySelectorAll('.nuvem-sair').forEach((b) => (b.onclick = sair));
  }

  async function sair() {
    if (temPendencias()) { await sincronizar(); if (temPendencias() && !confirm('Há alterações ainda não salvas. Sair mesmo assim?')) return; }
    try { await api('sair', { method: 'POST' }); } catch (e) {}
    location.reload();
  }

  /* ---------------- painéis extras: acessos e importação ---------------- */
  function painelAcessos() {
    return `<div class="panel" id="acessosPanel" style="margin-top:16px"><div class="panel-head"><h2>Acessos ao sistema (login)</h2><span class="status ok">Ativo</span></div>
      <p style="margin:0 0 10px">Cada pessoa entra com o próprio e-mail e senha. O perfil define o que ela vê e altera.</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th></th></tr></thead><tbody id="acTb"><tr><td colspan="5">Carregando…</td></tr></tbody></table></div>
      <form id="acNovo" style="margin-top:14px"><div class="form-grid">
        <label class="field">Nome<input class="input" name="nome" required></label>
        <label class="field">E-mail<input class="input" name="email" type="email" required></label>
        <label class="field">Perfil<select class="select" name="perfil">${estado.eu.perfis.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
      </div><div class="form-actions" style="justify-content:flex-start"><button class="btn btn-primary" type="submit">Criar acesso</button></div></form>
      <p id="acMsg" class="nuvem-msg" aria-live="polite"></p></div>`;
  }

  async function ligarAcessos() {
    const tb = document.getElementById('acTb'), msg = (t) => { document.getElementById('acMsg').textContent = t; };
    const mostrarSenha = (nome, s) => msg(`Senha provisória de ${nome}: ${s} — envie por um canal seguro. Ela só aparece agora; no primeiro acesso a pessoa cria a própria senha.`);
    async function carregar() {
      try {
        const r = await api('admin/usuarios');
        tb.innerHTML = r.usuarios.map((u) => `<tr><td><b>${esc(u.nome)}</b></td><td>${esc(u.email)}</td>
          <td><select class="select" data-perfil="${u.id}" ${u.id === estado.eu.usuario.id ? 'disabled' : ''}>${r.perfis.map((p) => `<option ${p === u.perfil ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></td>
          <td><span class="status ${u.ativo ? 'ok' : 'muted'}">${u.ativo ? (u.trocar_senha ? 'Aguardando 1º acesso' : 'Ativo') : 'Desativado'}</span></td>
          <td style="white-space:nowrap">${u.id === estado.eu.usuario.id ? '<small>Você</small>' : `<button class="btn btn-ghost" data-reset="${u.id}" data-nome="${esc(u.nome)}" type="button">Nova senha</button>
            <button class="btn btn-ghost" data-ativo="${u.id}" data-v="${u.ativo ? 0 : 1}" type="button">${u.ativo ? 'Desativar' : 'Reativar'}</button>`}</td></tr>`).join('') || '<tr><td colspan="5">Nenhum acesso.</td></tr>';
        tb.querySelectorAll('[data-perfil]').forEach((s) => s.onchange = async () => { try { await api('admin/usuarios/' + s.dataset.perfil, { body: { perfil: s.value } }); msg('Perfil atualizado.'); } catch (e) { msg(e.message); } carregar(); });
        tb.querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => { try { const r2 = await api('admin/usuarios/' + b.dataset.reset, { body: { redefinirSenha: true } }); mostrarSenha(b.dataset.nome, r2.senhaProvisoria); } catch (e) { msg(e.message); } carregar(); });
        tb.querySelectorAll('[data-ativo]').forEach((b) => b.onclick = async () => { try { await api('admin/usuarios/' + b.dataset.ativo, { body: { ativo: b.dataset.v === '1' } }); } catch (e) { msg(e.message); } carregar(); });
      } catch (e) { tb.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; }
    }
    document.getElementById('acNovo').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { const r = await api('admin/usuarios', { body: f }); e.target.reset(); mostrarSenha(f.nome, r.senhaProvisoria); carregar(); }
      catch (err) { msg(err.message); }
    };
    carregar();
  }

  function painelImportar() {
    return `<div class="panel" id="importPanel" style="margin-bottom:16px"><div class="panel-head"><h2>Importar backup</h2><span class="status warn">Superadministrador</span></div>
      <p style="margin:0 0 10px">Envia para o servidor um backup exportado pelo TOPO ONE. Por padrão só cria o que ainda não existe; nada é apagado.</p>
      <div class="form-grid"><label class="field">Arquivo de backup (.json)<input class="input" type="file" id="impArq" accept=".json,application/json"></label>
      <label class="field">Modo<select class="select" id="impModo"><option value="novos">Só registros novos (seguro)</option><option value="substituir">Substituir registros existentes</option></select></label></div>
      <div class="form-actions" style="justify-content:flex-start"><button class="btn btn-primary" type="button" id="impBtn">Conferir e importar</button></div>
      <p id="impMsg" class="nuvem-msg" aria-live="polite"></p></div>`;
  }

  function ligarImportar() {
    const msg = (t) => { document.getElementById('impMsg').textContent = t; };
    document.getElementById('impBtn').onclick = async () => {
      const arq = document.getElementById('impArq').files[0];
      if (!arq) { msg('Escolha o arquivo de backup.'); return; }
      let b;
      try { b = JSON.parse(await arq.text()); } catch (e) { msg('Arquivo inválido: não é um JSON.'); return; }
      if (b.formato !== 'topo-one-backup-v1' || !b.dados) { msg('Este arquivo não é um backup do TOPO ONE.'); return; }
      const registros = [];
      for (const c of COLECOES) for (const r of (Array.isArray(b.dados[c]) ? b.dados[c] : [])) if (r && r.id != null) registros.push({ colecao: c, id: String(r.id), dados: r });
      const meta = {};
      for (const [k, v] of Object.entries(b.dados)) if (!Array.isArray(v)) meta[k] = v;
      const resumo = Object.entries(b.contagem || {}).filter(([, n]) => n).map(([k, n]) => `${k}: ${n}`).join(', ');
      const modo = document.getElementById('impModo').value;
      if (!confirm(`Backup de ${b.exportado_em}\n${resumo}\n\nTotal: ${registros.length} registros. Modo: ${modo === 'novos' ? 'só novos' : 'substituir existentes'}.\n\nImportar agora?`)) return;
      let criados = 0, substituidos = 0, ignorados = 0;
      try {
        for (let i = 0; i < registros.length; i += LOTE) {
          msg(`Importando… ${Math.min(i + LOTE, registros.length)} de ${registros.length}`);
          const r = await api('admin/importar', { body: { registros: registros.slice(i, i + LOTE), modo, meta: i === 0 ? meta : undefined } });
          criados += r.criados; substituidos += r.substituidos; ignorados += r.ignorados;
        }
        msg(`Importação concluída: ${criados} criados, ${substituidos} substituídos, ${ignorados} já existiam. Recarregando…`);
        setTimeout(() => location.reload(), 2500);
      } catch (e) { msg(`Parou com erro: ${e.message}. ${criados + substituidos} registros já foram gravados; repetir a importação no modo "só novos" é seguro.`); }
    };
  }

  function ligarPaineis() {
    const origP = RENDER.pessoas;
    if (origP && estado.eu.gerenciarAcessos) RENDER.pessoas = () => { origP(); body('pessoas').insertAdjacentHTML('beforeend', painelAcessos()); ligarAcessos(); };
    const origC = RENDER.configuracoes;
    RENDER.configuracoes = () => {
      origC();
      const alvo = body('configuracoes');
      alvo.insertAdjacentHTML('afterbegin', `<div class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>Minha conta</h2></div>
        <p style="margin:0 0 10px"><b>${esc(estado.eu.usuario.nome)}</b> · ${esc(estado.eu.usuario.email)} · ${esc(estado.eu.usuario.perfil)}</p>
        <div class="form-actions" style="justify-content:flex-start"><button class="btn btn-ghost" type="button" id="nvTrocar">Trocar senha</button></div></div>`);
      document.getElementById('nvTrocar').onclick = () => pedirTrocaSenha(false).then((eu) => { estado.eu = eu; fecharTela(); avisar('Senha alterada.'); }).catch(() => {});
      if (estado.eu.importar) {
        document.getElementById('backupPanel')?.insertAdjacentHTML('afterend', painelImportar());
        ligarImportar();
      }
    };
  }

  /* ---------------- início ---------------- */
  async function iniciar(iniciarApp) {
    tela('<p class="nuvem-sub">Conectando…</p>');
    let eu = null;
    try { eu = await api('eu'); }
    catch (e) {
      if (e.status !== 401) { tela(`<h1>Sem conexão</h1><p class="nuvem-sub">${esc(e.message)}</p><button class="btn btn-primary" onclick="location.reload()">Tentar de novo</button>`); return; }
      try { const s = await api('setup'); if (s.disponivel) await pedirSetup(); } catch (e2) {}
      eu = await pedirLogin();
    }
    if (eu.usuario.trocarSenha) eu = await pedirTrocaSenha(true);
    estado.eu = eu;
    tela('<p class="nuvem-sub">Carregando dados…</p>');
    let r;
    try { r = await api('dados'); }
    catch (e) { tela(`<h1>Não foi possível carregar</h1><p class="nuvem-sub">${esc(e.message)}</p><button class="btn btn-primary" onclick="location.reload()">Tentar de novo</button>`); return; }
    tirarFoto(r.dados, r.versoes, r.meta);
    estado.ultimo = r.agora;

    // Mesma preparação que o sistema fazia ao abrir, agora sobre os dados do servidor.
    let db = { ...structuredClone(SEED), ...r.meta };
    // Coleção vazia no servidor fica como no primeiro uso local (ex.: contas padrão de Guilherme e Fernanda).
    for (const c of COLECOES) if (r.dados[c] && r.dados[c].length) db[c] = r.dados[c];
    db = initReceber(normalizeDB(mesclarSite(db)));
    DB = db;

    aplicarPermissoes();
    ligarPaineis();
    fecharTela();
    iniciarApp();
    montarPerfil();
    agendar(300); // grava o que a preparação acrescentou (ex.: leitura do site), se houver
    setInterval(buscarMudancas, INTERVALO_MUDANCAS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) buscarMudancas(); });
    window.addEventListener('beforeunload', (e) => { if (temPendencias()) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function entregarAutomacao(a, evento) {
    try {
      // A automação precisa estar salva no servidor antes do envio.
      await sincronizar();
      const r = await api('automacoes/entregar', { body: { automacao_id: a.id, evento: { id: evento.id, tipo: evento.tipo, em: evento.em, dados: evento.dados } } });
      return { automacao: a.id, nome: a.nome, status: r.status === 'enviado' ? 'enviado' : 'falhou', motivo: r.motivo || (r.http ? 'Resposta HTTP ' + r.http : '') };
    } catch (e) {
      return { automacao: a.id, nome: a.nome, status: 'falhou', motivo: e.message };
    }
  }

  window.Nuvem = { iniciar, agendar, entregarAutomacao, api };
})();
