package com.luiz.samaritano;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureStore {
    private static final String ALIAS = "samaritano_api_key";
    private final SharedPreferences secrets;
    private final SharedPreferences settings;

    SecureStore(Context context) {
        secrets = context.getSharedPreferences("secrets", Context.MODE_PRIVATE);
        settings = context.getSharedPreferences("mobile_settings", Context.MODE_PRIVATE);
    }

    void saveConfig(String provider, String model, String apiKey, String weatherLocation, String directives) throws Exception {
        String safeDirectives = directives == null ? "" : directives.trim();
        if (safeDirectives.length() > 8000) safeDirectives = safeDirectives.substring(0, 8000);
        settings.edit()
                .putString("provider", provider)
                .putString("model", model)
                .putString("weather_location", weatherLocation == null ? "" : weatherLocation.trim())
                .putString("directives", safeDirectives)
                .apply();
        if (apiKey != null && !apiKey.isBlank()) encryptAndSave(apiKey.trim());
    }

    String provider() { return settings.getString("provider", "groq"); }
    String model() { return settings.getString("model", "llama-3.1-8b-instant"); }
    String weatherLocation() { return settings.getString("weather_location", "Soledade, Rio Grande do Sul"); }
    String directives() { return settings.getString("directives", ""); }
    boolean hasApiKey() { return secrets.contains("payload") && secrets.contains("iv"); }

    String apiKey() throws Exception {
        String payload = secrets.getString("payload", null);
        String iv = secrets.getString("iv", null);
        if (payload == null || iv == null) return "";
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(payload, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private void encryptAndSave(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] payload = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        secrets.edit()
                .putString("payload", Base64.encodeToString(payload, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .apply();
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }
}
