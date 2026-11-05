# TOPO ONE — Central Inteligente de Operações

Sistema da Topo Leilões publicado na Cloudflare, usando somente planos gratuitos (sem cartão).

| Parte | Onde roda | Pasta |
|---|---|---|
| Frontend (os 14 módulos) | Cloudflare Pages | `public/` |
| API (login, permissões, gravação, automações) | Pages Functions (Workers) | `functions/api/`, `lib/` |
| Banco de dados | Cloudflare D1 | `migrations/` |

O frontend é o mesmo da versão 0.16; as mudanças estão concentradas em `public/nuvem.js`
(login e sincronização) e em poucas linhas do `index.html` (`loadDB`, `saveDB`, `entregar`, início).

## Segurança

- Toda a API exige login; cada pessoa tem e-mail e senha próprios.
- Senhas guardadas com PBKDF2-SHA256 + sal; sessão em cookie `HttpOnly`, `Secure`, `SameSite=Strict`, válida por 12 h.
- Bloqueio após 5 senhas erradas (15 min); proteção contra requisições de outros sites (CSRF).
- Perfis aplicados no servidor (`lib/permissoes.js`): quem não acessa o Financeiro não recebe títulos, contas,
  despesas nem a comissão dos leilões, e não consegue alterá-los.
- Edição simultânea: cada registro tem versão; uma gravação nunca apaga a de outra pessoa sem aviso.
- Exclusão lógica + trilha de auditoria com o conteúdo anterior de cada alteração.
- Nenhuma senha, token ou dado no repositório (`.gitignore` bloqueia `.dev.vars`, `.env`, backups e bancos).
- HTTPS obrigatório (HSTS) e cabeçalhos de segurança em `public/_headers`.

## Publicar (tudo pelo navegador)

1. **GitHub**: crie um repositório **privado** `topo-one` e envie este código.
2. **D1**: no painel da Cloudflare → *Storage & Databases* → *D1* → *Create* → nome `topo-one`.
   Copie o *Database ID* para `database_id` no `wrangler.toml`.
   Na aba *Console* do banco, cole e execute o conteúdo de `migrations/0001_inicial.sql`.
3. **Pages**: *Workers & Pages* → *Create* → *Pages* → *Connect to Git* → repositório `topo-one`.
   Framework: *None* · Build command: (vazio) · Output directory: `public`.
4. **Segredos**: no projeto → *Settings* → *Variables and Secrets* → adicione como **Secret**:
   `SETUP_TOKEN` (código longo, só para o 1º acesso) e `WEBHOOK_SECRET`. Faça um novo deploy.
5. Abra `https://topo-one.pages.dev`, crie o superadministrador com o `SETUP_TOKEN` e depois **apague esse segredo**.
6. Teste com dados fictícios. Só então importe o backup real em *Configurações → Importar backup*.

Cada `git push` na branch `main` publica sozinho. Recomendado: em *Settings → Builds → Preview*,
desativar deploys de outras branches (eles usariam o mesmo banco).

## Testar localmente (opcional)

```bash
npm install
cp .dev.vars.example .dev.vars      # edite os códigos
npm run db:migrar:local
npm run dev                          # http://127.0.0.1:8788
npm test                             # em outro terminal, com banco local limpo
```

## Backups e recuperação

- **D1 Time Travel**: volta o banco a qualquer minuto dos últimos 7 dias (plano grátis):
  `npx wrangler d1 time-travel restore topo-one --timestamp=<data ISO>`.
- **Exportação manual**: *Configurações → Exportar backup (JSON)*. Guarde fora do GitHub.
- **Auditoria**: a tabela `auditoria` guarda o conteúdo anterior de cada registro alterado ou excluído.

## Limites do plano gratuito (conferir na documentação antes de publicar)

- Workers/Functions: ~100 mil requisições/dia e ~10 ms de CPU por requisição.
- D1: 500 MB por banco, ~5 milhões de linhas lidas e ~100 mil gravadas por dia; Time Travel de 7 dias.
- Pages: ~500 deploys/mês.
- Sem garantia contratual de disponibilidade. Se um limite diário estourar, a API para até o dia seguinte, sem cobrança.

## Pendências conhecidas

- **TOPO AI**: fora do Claude funciona no "Modo simples" (respostas por regras).
- **Automações**: o envio é feito pelo servidor, com assinatura `x-topo-assinatura` (HMAC-SHA256).
  Ainda não há nova tentativa automática quando o destino falha.
- **Documentos/anexos**: não há armazenamento de arquivos (o R2 exige cartão para ativar).
- **Hash de senha**: confirmar no ambiente real se o login cabe no limite de CPU; se não, reduzir `PBKDF2_ITER`.
