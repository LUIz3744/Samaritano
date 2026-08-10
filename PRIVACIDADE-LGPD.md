# Privacidade e LGPD

Esta versão usa o projeto Samaritano de Tiago Rocha como base e adota privacidade por padrão.

## O que fica no computador

- fatos que o próprio usuário manda memorizar;
- histórico de conversa, com retenção padrão de 30 dias;
- estado das sessões;
- chaves de API configuradas localmente.
- vetores matemáticos do rosto autorizado e hash do PIN de recuperação, quando a proteção facial é cadastrada.

O banco local fica em `data/samaritano.db`. Mensagens enviadas a um provedor de IA seguem a política desse provedor; para processamento totalmente local, use Ollama.

O cadastro facial fica em `data/auth/luiz-face.json`. As imagens da câmera são processadas no navegador e descartadas; o arquivo contém apenas descritores numéricos, salt e hash do PIN. Os modelos de reconhecimento são baixados do projeto aberto FaceAPI quando houver internet.

## Proteções implementadas

- acesso administrativo limitado ao computador local;
- CORS restrito à mesma origem;
- redação automática de CPF, cartão, senha e chave de API no histórico;
- bloqueio desses dados na memória de fatos, salvo configuração expressa em contrário;
- retenção automática e limite máximo de registros;
- consulta em `GET /api/privacy`;
- exportação em `GET /api/privacy/export`;
- exclusão confirmada em `POST /api/privacy/delete`.
- autenticação facial antes de conversa, voz, ferramentas e configurações;
- cookie de sessão HttpOnly, SameSite=Strict e Secure no HTTPS;
- prova de presença por piscada, limite de tentativas e PIN local de recuperação;
- exclusão do cadastro facial em `POST /api/auth/reset` ou pelo painel de privacidade.

Exemplo de exclusão total:

```bash
curl -X POST http://127.0.0.1:5070/api/privacy/delete \
  -H "Content-Type: application/json" \
  -d '{"scope":"all","confirm":true}'
```

## Uso de dados reais

Dados reais podem ser tratados quando houver finalidade definida e uma base legal aplicável. A biometria deste projeto é limitada ao próprio operador Luiz, mediante consentimento explícito, para controle de acesso local. Não importe biometria ou perfis de terceiros, listas vazadas, saúde, documentos ou localização precisa sem avaliação jurídica e controles adicionais. Dados publicados na internet continuam sujeitos aos princípios e direitos da LGPD.

Antes de disponibilizar o sistema a terceiros, defina controlador, finalidade, base legal, canal do titular, fornecedores que recebem dados, prazo de retenção e processo de incidentes. Este documento é orientação técnica, não parecer jurídico.
