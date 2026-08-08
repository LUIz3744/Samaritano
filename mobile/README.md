# Samaritano Mobile Core

Aplicativo Android independente. Não precisa do servidor Node nem do notebook para conversar.

## Recursos atuais

- interface Samaritano escura e adaptada para celular;
- autenticação pela biometria ou pelo bloqueio seguro do Android;
- histórico SQLite privado no aparelho;
- chave da IA criptografada com Android Keystore;
- Groq e Gemini configuráveis;
- leitura de respostas com Android TTS;
- ditado pelo reconhecimento de voz do Android;
- anexos de imagem, PDF, áudio e vídeos curtos para análise com Gemini;
- busca web com fontes via Groq Compound ou Google Search do Gemini;
- abertura segura do WhatsApp por intenção nativa do Android;
- respostas jurídicas informativas, com limites e sem inventar dados pessoais;
- previsão meteorológica direta e datada via Open-Meteo, sem depender da IA;
- editor local em Markdown para objetivos, regras e limites personalizados;
- exclusão e reabertura de conversas locais.

## Toolchain portátil desta máquina

- Java 17: `C:\Users\rique\Documents\Codex\.jdk17`
- Gradle 8.9: `C:\Users\rique\Documents\Codex\.gradle89`
- Android SDK: `C:\Users\rique\Documents\Codex\.android-sdk`

Para instalar a plataforma Android 35 quando o terminal tiver acesso à internet:

```powershell
.\setup-android-sdk.ps1
```

Para compilar o APK:

```powershell
.\build-apk.ps1
```

O APK de debug será criado em `app/build/outputs/apk/debug/app-debug.apk`.

## Configuração inicial no celular

Abra a engrenagem do Samaritano, selecione Groq ou Gemini, informe o modelo e cole a chave da API. A chave é criptografada no Keystore e nunca é devolvida à interface web interna.

Análises de arquivos usam o Gemini e aceitam até 12 MB por anexo nesta versão. O arquivo é mantido apenas em memória durante o envio e não é salvo no histórico local.

## Próxima fase

- ferramentas nativas Android;
- serviço persistente e inicialização automática;
- descoberta do Samaritano Bridge no computador;
- assinatura de release e atualização local.
