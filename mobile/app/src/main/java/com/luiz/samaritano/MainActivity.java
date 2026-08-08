package com.luiz.samaritano;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.hardware.biometrics.BiometricPrompt;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity implements TextToSpeech.OnInitListener {
    private static final int SPEECH_REQUEST = 4102;
    private static final int FILE_REQUEST = 4103;
    private static final int MAX_SOURCE_BYTES = 16 * 1024 * 1024;
    private static final int MAX_DIRECT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
    private static final int MAX_CONTEXT_CHARS = 24000;
    private static final String SYSTEM_PROMPT = "Você é o SAMARITANO da série Person of Interest. Seu único operador autorizado é Luiz. Responda em PT-BR de forma precisa, fria, calma e breve. Nunca invente fatos pessoais, dívidas, processos, valores, datas ou ações executadas. Só confirme uma ação após resultado real de ferramenta. Você pode fornecer informação jurídica geral, explicar prescrição, decadência, prazos, procedimentos e hipóteses. Não recuse apenas porque o tema é jurídico. Avise brevemente que a aplicação concreta depende dos fatos e pode exigir advogado; não se apresente como advogado e não invente dados do caso de Luiz.";

    private WebView webView;
    private TextToSpeech tts;
    private SamaritanoDb db;
    private SecureStore secureStore;
    private volatile Attachment pendingAttachment;
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
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) { runJs("window.SamaritanoNative.onSpeechFinished() "); }
                @Override public void onError(String utteranceId) { runJs("window.SamaritanoNative.onSpeechFinished() "); }
            });
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

    private void pickAttachment() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "image/*", "video/*", "audio/*", "application/pdf", "text/plain"
        });
        try { startActivityForResult(intent, FILE_REQUEST); }
        catch (ActivityNotFoundException error) {
            callbackAttachment(false, "", "", 0, "Seletor de arquivos indisponível");
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                callbackAttachment(false, "", "", 0, "Seleção cancelada");
                return;
            }
            Uri uri = data.getData();
            executor.execute(() -> {
                try {
                    String mime = getContentResolver().getType(uri);
                    if (mime == null || mime.isBlank()) mime = "application/octet-stream";
                    String name = attachmentName(uri);
                    Attachment attachment = prepareAttachment(uri, name, mime);
                    pendingAttachment = attachment;
                    callbackAttachment(true, attachment.name, attachment.mime, attachment.bytes.length, "");
                } catch (Exception error) {
                    pendingAttachment = null;
                    callbackAttachment(false, "", "", 0,
                            error.getMessage() == null ? "Falha ao abrir arquivo" : error.getMessage());
                }
            });
            return;
        }
        if (requestCode == SPEECH_REQUEST && resultCode == RESULT_OK && data != null) {
            ArrayList<String> results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            String text = results == null || results.isEmpty() ? "" : results.get(0);
            runJs("window.SamaritanoNative.onSpeechResult(true," + JSONObject.quote(text) + ")");
        } else if (requestCode == SPEECH_REQUEST) {
            runJs("window.SamaritanoNative.onSpeechResult(false,'Escuta cancelada')");
        }
    }

    private String attachmentName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        }
        String tail = uri.getLastPathSegment();
        return tail == null ? "arquivo" : tail;
    }

    private Attachment prepareAttachment(Uri uri, String name, String mime) throws Exception {
        byte[] original = readAttachment(uri);
        if (mime.startsWith("image/")) {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(original, 0, original.length, bounds);
            int sample = 1;
            while (bounds.outWidth / sample > 2400 || bounds.outHeight / sample > 2400) sample *= 2;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            Bitmap decoded = BitmapFactory.decodeByteArray(original, 0, original.length, options);
            if (decoded == null) throw new IllegalStateException("Imagem inválida ou incompatível");
            int largest = Math.max(decoded.getWidth(), decoded.getHeight());
            Bitmap outputBitmap = decoded;
            if (largest > 1600) {
                float ratio = 1600f / largest;
                outputBitmap = Bitmap.createScaledBitmap(decoded,
                        Math.max(1, Math.round(decoded.getWidth() * ratio)),
                        Math.max(1, Math.round(decoded.getHeight() * ratio)), true);
            }
            ByteArrayOutputStream compressed = new ByteArrayOutputStream();
            outputBitmap.compress(Bitmap.CompressFormat.JPEG, 82, compressed);
            if (outputBitmap != decoded) outputBitmap.recycle();
            decoded.recycle();
            String baseName = name == null ? "imagem" : name.replaceFirst("\\.[^.]+$", "");
            return new Attachment(baseName + ".jpg", "image/jpeg", compressed.toByteArray());
        }
        if (original.length > MAX_DIRECT_ATTACHMENT_BYTES) {
            throw new IllegalStateException("Arquivo maior que 5 MB. Imagens são compactadas automaticamente; reduza este documento antes de enviar.");
        }
        return new Attachment(name, mime, original);
    }

    private byte[] readAttachment(Uri uri) throws Exception {
        try (InputStream input = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IllegalStateException("Não foi possível abrir o arquivo");
            byte[] buffer = new byte[64 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_SOURCE_BYTES) throw new IllegalStateException("Arquivo original maior que 16 MB");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
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
                String directives = secureStore.directives();
                String systemPrompt = directives.isBlank() ? SYSTEM_PROMPT : SYSTEM_PROMPT + "\n\nDIRETRIZES PERSONALIZADAS DE LUIZ:\n" + directives;
                JSONArray messages = request.optJSONArray("messages");
                if (messages == null) messages = new JSONArray();
                boolean webSearch = request.optBoolean("webSearch", false);
                Attachment attachment = request.optBoolean("includeAttachment") ? pendingAttachment : null;
                if (attachment != null && !provider.equals("gemini")) {
                    throw new IllegalStateException("Análise de arquivos nesta versão requer o provedor Gemini.");
                }

                URL url;
                JSONObject body;
                if (provider.equals("gemini")) {
                    url = new URL("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent");
                    body = buildGeminiBody(messages, attachment, webSearch, systemPrompt);
                } else {
                    url = new URL("https://api.groq.com/openai/v1/chat/completions");
                    body = buildOpenAiBody(webSearch ? "groq/compound" : model, messages, systemPrompt);
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
                if (status == 413) throw new IllegalStateException("Arquivo ou conversa grande demais para o provedor. A imagem já foi compactada; tente uma conversa nova ou um documento menor.");
                if (status < 200 || status >= 300) throw new IllegalStateException("IA respondeu HTTP " + status + ": " + response.substring(0, Math.min(240, response.length())));
                String answer = provider.equals("gemini") ? parseGemini(response) : parseOpenAi(response);
                if (attachment != null && pendingAttachment == attachment) pendingAttachment = null;
                callbackChat(requestId, true, answer);
            } catch (Exception error) {
                callbackChat(requestId, false, error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private JSONObject buildOpenAiBody(String model, JSONArray messages, String systemPrompt) throws Exception {
        JSONArray all = new JSONArray();
        all.put(new JSONObject().put("role", "system").put("content", systemPrompt));
        JSONArray compact = compactMessages(messages);
        for (int i = 0; i < compact.length(); i++) all.put(compact.getJSONObject(i));
        return new JSONObject().put("model", model).put("messages", all).put("temperature", 0.25).put("stream", false);
    }

    private JSONObject buildGeminiBody(JSONArray messages, Attachment attachment, boolean webSearch, String systemPrompt) throws Exception {
        JSONArray compact = compactMessages(messages);
        JSONArray contents = new JSONArray();
        for (int i = 0; i < compact.length(); i++) {
            JSONObject message = compact.getJSONObject(i);
            String role = message.optString("role").equals("assistant") ? "model" : "user";
            JSONArray parts = new JSONArray().put(new JSONObject().put("text", message.optString("content")));
            if (attachment != null && role.equals("user") && i == compact.length() - 1) {
                parts.put(new JSONObject().put("inlineData", new JSONObject()
                        .put("mimeType", attachment.mime)
                        .put("data", Base64.encodeToString(attachment.bytes, Base64.NO_WRAP))));
            }
            contents.put(new JSONObject().put("role", role).put("parts", parts));
        }
        JSONObject body = new JSONObject()
                .put("systemInstruction", new JSONObject().put("parts", new JSONArray().put(new JSONObject().put("text", systemPrompt))))
                .put("contents", contents)
                .put("generationConfig", new JSONObject().put("temperature", 0.25));
        if (webSearch) body.put("tools", new JSONArray().put(new JSONObject().put("googleSearch", new JSONObject())));
        return body;
    }

    private JSONArray compactMessages(JSONArray messages) throws Exception {
        List<JSONObject> selected = new ArrayList<>();
        int used = 0;
        for (int i = messages.length() - 1; i >= 0 && selected.size() < 12 && used < MAX_CONTEXT_CHARS; i--) {
            JSONObject source = messages.getJSONObject(i);
            String content = source.optString("content");
            int perMessage = i == messages.length() - 1 ? 8000 : 4000;
            int available = Math.min(perMessage, MAX_CONTEXT_CHARS - used);
            if (available <= 0) break;
            if (content.length() > available) content = content.substring(0, available) + "\n[conteúdo anterior resumido pelo limite local]";
            selected.add(new JSONObject().put("role", source.optString("role", "user")).put("content", content));
            used += content.length();
        }
        Collections.reverse(selected);
        JSONArray compact = new JSONArray();
        for (JSONObject message : selected) compact.put(message);
        return compact;
    }

    private String parseOpenAi(String raw) throws Exception {
        return new JSONObject(raw).getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content").trim();
    }

    private String parseGemini(String raw) throws Exception {
        JSONObject candidate = new JSONObject(raw).getJSONArray("candidates").getJSONObject(0);
        JSONArray parts = candidate.getJSONObject("content").getJSONArray("parts");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < parts.length(); i++) out.append(parts.getJSONObject(i).optString("text"));
        JSONObject grounding = candidate.optJSONObject("groundingMetadata");
        JSONArray chunks = grounding == null ? null : grounding.optJSONArray("groundingChunks");
        if (chunks != null && chunks.length() > 0) {
            out.append("\n\nFONTES:");
            for (int i = 0; i < Math.min(5, chunks.length()); i++) {
                JSONObject web = chunks.optJSONObject(i) == null ? null : chunks.optJSONObject(i).optJSONObject("web");
                if (web != null && !web.optString("uri").isBlank()) {
                    out.append("\n- ").append(web.optString("title", "Fonte")).append(": ").append(web.optString("uri"));
                }
            }
        }
        return out.toString().trim();
    }

    private void openWhatsApp() {
        try {
            Intent intent = getPackageManager().getLaunchIntentForPackage("com.whatsapp");
            if (intent == null) intent = getPackageManager().getLaunchIntentForPackage("com.whatsapp.w4b");
            if (intent == null) intent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/"));
            startActivity(intent);
            runJs("window.SamaritanoNative.onExternalAppResult(true,'WhatsApp aberto')");
        } catch (Exception error) {
            runJs("window.SamaritanoNative.onExternalAppResult(false,'Não foi possível abrir o WhatsApp')");
        }
    }

    private void requestWeather(String requestId, String location, int dayOffset) {
        executor.execute(() -> {
            try {
                String query = location == null || location.isBlank() ? secureStore.weatherLocation() : location.trim();
                String geocodingUrl = "https://geocoding-api.open-meteo.com/v1/search?name=" +
                        URLEncoder.encode(query, "UTF-8") + "&count=1&language=pt&countryCode=BR&format=json";
                JSONObject geocoding = new JSONObject(httpGet(geocodingUrl));
                JSONArray results = geocoding.optJSONArray("results");
                if (results == null || results.length() == 0) throw new IllegalStateException("Local não encontrado: " + query);
                JSONObject place = results.getJSONObject(0);
                double latitude = place.getDouble("latitude");
                double longitude = place.getDouble("longitude");
                String forecastUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + latitude +
                        "&longitude=" + longitude +
                        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max" +
                        "&timezone=auto&forecast_days=3";
                JSONObject daily = new JSONObject(httpGet(forecastUrl)).getJSONObject("daily");
                int index = Math.max(0, Math.min(dayOffset, daily.getJSONArray("time").length() - 1));
                String date = daily.getJSONArray("time").getString(index);
                int code = daily.getJSONArray("weather_code").getInt(index);
                double min = daily.getJSONArray("temperature_2m_min").getDouble(index);
                double max = daily.getJSONArray("temperature_2m_max").getDouble(index);
                int rain = daily.getJSONArray("precipitation_probability_max").getInt(index);
                double wind = daily.getJSONArray("wind_speed_10m_max").getDouble(index);
                String placeName = place.optString("name", query);
                String state = place.optString("admin1", "");
                String answer = "PREVISÃO CONFIRMADA // " + date + "\n" + placeName +
                        (state.isBlank() ? "" : " — " + state) + "\n" + weatherDescription(code) +
                        ". Mínima de " + Math.round(min) + " °C e máxima de " + Math.round(max) +
                        " °C. Probabilidade máxima de chuva: " + rain + "%. Vento máximo: " + Math.round(wind) +
                        " km/h.\n\nFonte: Open-Meteo — previsão atualizada por modelos meteorológicos.";
                callbackChat(requestId, true, answer);
            } catch (Exception error) {
                callbackChat(requestId, false, error.getMessage() == null ? "Falha ao consultar previsão" : error.getMessage());
            }
        });
    }

    private String httpGet(String address) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            String response = readAll(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
            if (status < 200 || status >= 300) throw new IllegalStateException("Serviço meteorológico respondeu HTTP " + status);
            return response;
        } finally {
            connection.disconnect();
        }
    }

    private String weatherDescription(int code) {
        if (code == 0) return "Céu limpo";
        if (code <= 3) return "Parcialmente nublado a encoberto";
        if (code == 45 || code == 48) return "Neblina";
        if (code >= 51 && code <= 67) return "Chuva ou garoa";
        if (code >= 71 && code <= 77) return "Possibilidade de neve";
        if (code >= 80 && code <= 82) return "Pancadas de chuva";
        if (code >= 85 && code <= 86) return "Pancadas de neve";
        if (code >= 95) return "Trovoadas";
        return "Condição variável";
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

    private void callbackAttachment(boolean ok, String name, String mime, long size, String error) {
        runJs("window.SamaritanoNative.onAttachmentResult(" + ok + "," + JSONObject.quote(name) + "," +
                JSONObject.quote(mime) + "," + size + "," + JSONObject.quote(error) + ")");
    }

    private static final class Attachment {
        final String name;
        final String mime;
        final byte[] bytes;
        Attachment(String name, String mime, byte[] bytes) {
            this.name = name;
            this.mime = mime;
            this.bytes = bytes;
        }
    }

    public final class AndroidCore {
        @JavascriptInterface public void authenticate() { runOnUiThread(MainActivity.this::authenticate); }
        @JavascriptInterface public void startListening() { runOnUiThread(MainActivity.this::startSpeechInput); }
        @JavascriptInterface public void pickAttachment() { runOnUiThread(MainActivity.this::pickAttachment); }
        @JavascriptInterface public void clearAttachment() { pendingAttachment = null; }
        @JavascriptInterface public void openWhatsApp() { runOnUiThread(MainActivity.this::openWhatsApp); }
        @JavascriptInterface public void requestWeather(String requestId, String location, int dayOffset) { MainActivity.this.requestWeather(requestId, location, dayOffset); }
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
                return new JSONObject()
                        .put("provider", secureStore.provider())
                        .put("model", secureStore.model())
                        .put("has_api_key", secureStore.hasApiKey())
                        .put("weather_location", secureStore.weatherLocation())
                        .put("directives", secureStore.directives())
                        .toString();
            } catch (Exception error) { return "{}"; }
        }
        @JavascriptInterface public String saveConfig(String provider, String model, String apiKey, String weatherLocation, String directives) {
            try {
                secureStore.saveConfig(provider, model, apiKey, weatherLocation, directives);
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
