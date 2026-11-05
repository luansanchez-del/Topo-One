# TOPO ONE — Protótipo visual navegável v0.3

## Como abrir
Extraia a pasta e abra `index.html` no Chrome ou Edge. Para recursos de microfone, use um servidor local, como `python -m http.server 8000` dentro da pasta e abra `http://localhost:8000`.

## O que funciona
- Tela inicial redesenhada no formato aprovado: menu azul-marinho, módulos circulares, TOPO AI central e painéis laterais.
- Clique nos módulos ou menu para navegar.
- Cadastre e edite leilões demonstrativos; marque e crie tarefas; cadastre perfis de exemplo.
- Clique no rosto central para abrir a conversa; respostas textuais simples e leitura de voz pelo navegador, quando disponíveis.

## Limitações
Sem servidor, login real, controle de permissões no backend, dados ao vivo ou integrações. Indicadores e barras são demonstrativos. A TOPO AI ainda não é um agente conectado a modelo de linguagem, e a voz utiliza recursos do navegador.

## Identidade
Paleta oficial: #0F1837 e #598DDC; marca oficial e fonte Montserrat fornecidas pela Topo. Ilustração do rosto digital baseada na referência fornecida para este projeto.

## Alterações v0.3
- Órbita da tela inicial corrigida: os 10 módulos agora ficam distribuídos a cada 36° no anel externo, sem sobreposição. Antes, "Pessoas" ficava escondido atrás de "Agentes IA" e "Jurídico" atrás de "Comercial".
- O tamanho dos módulos acompanha o tamanho da órbita, e o layout funciona no desktop, no tablet 3:4 e no celular.
- Se o logo não carregar, aparece o texto "TOPO LEILÕES" no lugar da imagem quebrada.

## Pendente: pasta `assets/`
A pasta `assets/` não está no repositório. Sem ela, o rosto da TOPO AI, o logo e a fonte Montserrat não carregam. Envie para `assets/`:
- `logo-topo-white.png`
- `topo-ai-face.png`
- `montserrat-variable.woff2`
