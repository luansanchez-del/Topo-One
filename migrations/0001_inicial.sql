-- TOPO ONE — estrutura inicial do banco (Cloudflare D1 / SQLite)
-- Cada registro das coleções do sistema (leilões, lotes, títulos a receber...) é guardado
-- como JSON, preservando exatamente o formato que o frontend já usa.

CREATE TABLE IF NOT EXISTS registros (
  colecao        TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  dados          TEXT    NOT NULL,             -- objeto JSON completo do registro
  versao         INTEGER NOT NULL DEFAULT 1,   -- controle de edição simultânea
  excluido       INTEGER NOT NULL DEFAULT 0,   -- exclusão lógica (permite recuperar)
  criado_em      TEXT    NOT NULL,
  atualizado_em  TEXT    NOT NULL,
  atualizado_por INTEGER,
  PRIMARY KEY (colecao, id)
);
CREATE INDEX IF NOT EXISTS idx_registros_atualizado ON registros (atualizado_em);

-- Valores avulsos do sistema (ex.: data da última leitura do site).
CREATE TABLE IF NOT EXISTS meta (
  chave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

-- Contas de acesso (login). Diferente da lista "Pessoas" do sistema.
CREATE TABLE IF NOT EXISTS usuarios_acesso (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  nome         TEXT    NOT NULL,
  perfil       TEXT    NOT NULL,
  senha_hash   TEXT    NOT NULL,               -- PBKDF2-SHA256 com sal; nunca a senha
  trocar_senha INTEGER NOT NULL DEFAULT 1,     -- obriga trocar a senha provisória
  ativo        INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT    NOT NULL,
  ultimo_login TEXT
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT    PRIMARY KEY,              -- SHA-256 do token; o token só fica no cookie
  usuario_id INTEGER NOT NULL REFERENCES usuarios_acesso(id),
  criado_em  TEXT    NOT NULL,
  expira_em  TEXT    NOT NULL,
  ip         TEXT,
  agente     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes (usuario_id);

-- Bloqueio de tentativas de login (por e-mail e por IP).
CREATE TABLE IF NOT EXISTS tentativas_login (
  chave         TEXT PRIMARY KEY,
  falhas        INTEGER NOT NULL,
  primeira_em   TEXT    NOT NULL,
  bloqueado_ate TEXT
);

-- Trilha de auditoria: quem mudou o quê, quando, e o conteúdo anterior (para recuperação).
CREATE TABLE IF NOT EXISTS auditoria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  em          TEXT    NOT NULL,
  usuario_id  INTEGER,
  acao        TEXT    NOT NULL,
  colecao     TEXT,
  registro_id TEXT,
  antes       TEXT,
  versao      INTEGER,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditoria_em ON auditoria (em);
