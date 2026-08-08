package com.luiz.samaritano;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.hardware.biometrics.BiometricPrompt;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity implements TextToSpeech.OnInitListener {
    private static final int SPEECH_REQUEST = 4102;
    private static final String SYSTEM_PROMPT = "Você é o SAMARITANO da série Person of Interest. Seu único operador autorizado é Luiz. Responda em PT-BR de forma precisa, fria, calma e breve. Nunca invente fatos pessoais, dívidas, processos, valores, datas ou ações executadas. Só confirme uma ação após resultado real de ferramenta. Perguntas jurídicas sem documento são hipotéticas.";

    private WebView webView;
    private TextToSpeech tts;
    private SamaritanoDb db;
    private SecureStore secureStore;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        db = new SamaritanoDb(this);
        secureStore = new SecureStore(this);
        tts = new TextToSpeech(this, this);

        webView = new WebView(this);
        webView.setBackgroundColor(0xff050505);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setAllowUniversalAccessFromFileURLs(false);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new AndroidCore(), "SamaritanoAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file:///android_asset/")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); } catch (Exception ignored) {}
                return true;
            }
        });
        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS) {
            tts.setLanguage(new Locale("pt", "BR"));
            tts.setSpeechRate(1.0f);
        }
    }

    @Override protected void onDestroy() {
        if (tts != null) { tts.stop(); tts.shutdown(); }
        executor.shutdownNow();
        db.close();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    private void runJs(String expression) {
        runOnUiThread(() -> webView.evaluateJavascript(expression, null));
    }

    private void authenticate() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            runJs("window.SamaritanoNative.onAuthResult(false,'Android sem suporte biométrico compatível')");
            return;
        }
        BiometricPrompt.Builder builder = new BiometricPrompt.Builder(this)
                .setTitle("SAMARITANO")
                .setSubtitle("Autorizar operador Luiz")
                .setDescription("Use a biometria ou o bloqueio seguro do aparelho");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setDeviceCredentialAllowed(true);
        } else {
            builder.setNegativeButton("Cancelar", getMainExecutor(), (dialog, which) ->
                    runJs("window.SamaritanoNative.onAuthResult(false,'Autenticação cancelada')"));
        }
        BiometricPrompt prompt = builder.build();
        prompt.authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                runJs("window.SamaritanoNative.onAuthResult(true,'OPERADOR AUTORIZADO')");
            }

            @Override public void onAuthenticationError(int errorCode, CharSequence errString) {
                runJs("window.SamaritanoNative.onAuthResult(false," + JSONObject.quote(errString.toString()) + ")");
            }
        });
    }

    private void startSpeechInput() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR");
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "Comando para o Samaritano");
        try { startActivityForResult(intent, SPEECH_REQUEST); }
        catch (ActivityNotFoundException error) {
            runJs("window.SamaritanoNative.onSpeechResult(false,'Reconhecimento de voz indisponível')");
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SPEECH_REQUEST) return;
        if (resultCode == RESULT_OK && data != null) {
            ArrayList<String> results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            String text = results == null || results.isEmpty() ? "" : results.get(0);
            runJs("window.SamaritanoNative.onSpeechResult(true," + JSONObject.quote(text) + ")");
        } else {
            runJs("window.SamaritanoNative.onSpeechResult(false,'Escuta cancelada')");
        }
    }

    private void sendChat(String requestId, String requestJson) {
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                JSONObject request = new JSONObject(requestJson);
                String provider = request.optString("provider", secureStore.provider());
                String model = request.optString("model", secureStore.model());
                String apiKey = secureStore.apiKey();
                if (apiKey.isBlank()) throw new IllegalStateException("Configure a chave da IA primeiro.");
                JSONArray messages = request.optJSONArray("messages");
                if (messages == null) messages = new JSONArray();

                URL url;
                JSONObject body;
                if (provider.equals("gemini")) {
                    url = new URL("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent");
                    body = buildGeminiBody(messages);
                } else {
                    url = new URL("https://api.groq.com/openai/v1/chat/completions");
                    body = buildOpenAiBody(model, messages);
                }

                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(90000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                if (provider.equals("gemini")) connection.setRequestProperty("x-goog-api-key", apiKey);
                else connection.setRequestProperty("Authorization", "Bearer " + apiKey);
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.getOutputStream().write(payload);

                int status = connection.getResponseCode();
                String response = readAll(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
                if (status < 200 || status >= 300) throw new IllegalStateException("IA respondeu HTTP " + status + ": " + response.substring(0, Math.min(240, response.length())));
                String answer = provider.equals("gemini") ? parseGemini(response) : parseOpenAi(response);
                callbackChat(requestId, true, answer);
            } catch (Exception error) {
                callbackChat(requestId, false, error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private JSONObject buildOpenAiBody(String model, JSONArray messages) throws Exception {
        JSONArray all = new JSONArray();
        all.put(new JSONObject().put("role", "system").put("content", SYSTEM_PROMPT));
        for (int i = Math.max(0, messages.length() - 20); i < messages.length(); i++) all.put(messages.getJSONObject(i));
        return new JSONObject().put("model", model).put("messages", all).put("temperature", 0.25).put("stream", false);
    }

    private JSONObject buildGeminiBody(JSONArray messages) throws Exception {
        JSONArray contents = new JSONArray();
        for (int i = Math.max(0, messages.length() - 20); i < messages.length(); i++) {
            JSONObject message = messages.getJSONObject(i);
            String role = message.optString("role").equals("assistant") ? "model" : "user";
            JSONArray parts = new JSONArray().put(new JSONObject().put("text", message.optString("content")));
            contents.put(new JSONObject().put("role", role).put("parts", parts));
        }
        return new JSONObject()
                .put("systemInstruction", new JSONObject().put("parts", new JSONArray().put(new JSONObject().put("text", SYSTEM_PROMPT))))
                .put("contents", contents)
                .put("generationConfig", new JSONObject().put("temperature", 0.25));
    }

    private String parseOpenAi(String raw) throws Exception {
        return new JSONObject(raw).getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content").trim();
    }

    private String parseGemini(String raw) throws Exception {
        JSONArray parts = new JSONObject(raw).getJSONArray("candidates").getJSONObject(0).getJSONObject("content").getJSONArray("parts");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < parts.length(); i++) out.append(parts.getJSONObject(i).optString("text"));
        return out.toString().trim();
    }

    private String readAll(InputStream input) throws Exception {
        if (input == null) return "";
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) out.append(line);
        }
        return out.toString();
    }

    private void callbackChat(String requestId, boolean ok, String payload) {
        runJs("window.SamaritanoNative.onChatResult(" + JSONObject.quote(requestId) + "," + ok + "," + JSONObject.quote(payload) + ")");
    }

    public final class AndroidCore {
        @JavascriptInterface public void authenticate() { runOnUiThread(MainActivity.this::authenticate); }
        @JavascriptInterface public void startListening() { runOnUiThread(MainActivity.this::startSpeechInput); }
        @JavascriptInterface public void speak(String text) {
            runOnUiThread(() -> tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "samaritano-answer"));
        }
        @JavascriptInterface public void stopSpeaking() { runOnUiThread(() -> tts.stop()); }
        @JavascriptInterface public void saveMessage(String sessionId, String role, String content) { db.saveMessage(sessionId, role, content); }
        @JavascriptInterface public String listSessions() { return db.listSessions(); }
        @JavascriptInterface public String getMessages(String sessionId) { return db.getMessages(sessionId); }
        @JavascriptInterface public void deleteSession(String sessionId) { db.deleteSession(sessionId); }
        @JavascriptInterface public void sendChat(String requestId, String requestJson) { MainActivity.this.sendChat(requestId, requestJson); }
        @JavascriptInterface public String getConfig() {
            try {
                return new JSONObject().put("provider", secureStore.provider()).put("model", secureStore.model()).put("has_api_key", secureStore.hasApiKey()).toString();
            } catch (Exception error) { return "{}"; }
        }
        @JavascriptInterface public String saveConfig(String provider, String model, String apiKey) {
            try {
                secureStore.saveConfig(provider, model, apiKey);
                return new JSONObject().put("ok", true).toString();
            } catch (Exception error) {
                String message = error.getMessage() == null ? "Falha ao salvar" : error.getMessage();
                return "{\"ok\":false,\"error\":" + JSONObject.quote(message) + "}";
            }
        }
        @JavascriptInterface public String deviceInfo() {
            try {
                return new JSONObject()
                        .put("manufacturer", Build.MANUFACTURER)
                        .put("model", Build.MODEL)
                        .put("android", Build.VERSION.RELEASE)
                        .put("sdk", Build.VERSION.SDK_INT)
                        .put("device_id", Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID))
                        .toString();
            } catch (Exception error) { return "{}"; }
        }
    }
}
