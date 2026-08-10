package com.luiz.samaritano;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class SamaritanoDb extends SQLiteOpenHelper {
    SamaritanoDb(Context context) {
        super(context, "samaritano-mobile.db", null, 1);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE chats (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX idx_messages_session ON messages(session_id, created_at, id)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}

    synchronized void saveMessage(String sessionId, String role, String content) {
        if (!sessionId.matches("mobile-[A-Za-z0-9_-]{1,80}")) return;
        if (!(role.equals("user") || role.equals("assistant"))) return;
        long now = System.currentTimeMillis();
        SQLiteDatabase db = getWritableDatabase();
        ContentValues message = new ContentValues();
        message.put("session_id", sessionId);
        message.put("role", role);
        message.put("content", content);
        message.put("created_at", now);
        db.insertOrThrow("messages", null, message);

        ContentValues chat = new ContentValues();
        chat.put("session_id", sessionId);
        chat.put("updated_at", now);
        if (role.equals("user")) {
            String title = content.replaceAll("\\s+", " ").trim();
            chat.put("title", title.substring(0, Math.min(80, title.length())));
        } else {
            chat.put("title", "Nova conversa");
        }
        db.insertWithOnConflict("chats", null, chat, SQLiteDatabase.CONFLICT_IGNORE);
        ContentValues updated = new ContentValues();
        updated.put("updated_at", now);
        db.update("chats", updated, "session_id=?", new String[]{sessionId});
    }

    synchronized String listSessions() {
        JSONArray out = new JSONArray();
        String sql = "SELECT c.session_id,c.title,c.updated_at,COUNT(m.id) message_count FROM chats c LEFT JOIN messages m ON m.session_id=c.session_id GROUP BY c.session_id ORDER BY c.updated_at DESC LIMIT 60";
        try (Cursor c = getReadableDatabase().rawQuery(sql, null)) {
            while (c.moveToNext()) {
                JSONObject row = new JSONObject();
                row.put("session_id", c.getString(0));
                row.put("title", c.getString(1));
                row.put("updated_at", c.getLong(2));
                row.put("message_count", c.getInt(3));
                out.put(row);
            }
        } catch (JSONException ignored) {}
        return out.toString();
    }

    synchronized String getMessages(String sessionId) {
        JSONArray out = new JSONArray();
        try (Cursor c = getReadableDatabase().query(
                "messages", new String[]{"id", "role", "content", "created_at"},
                "session_id=?", new String[]{sessionId}, null, null, "created_at ASC,id ASC", "300")) {
            while (c.moveToNext()) {
                JSONObject row = new JSONObject();
                row.put("id", c.getLong(0));
                row.put("role", c.getString(1));
                row.put("content", c.getString(2));
                row.put("created_at", c.getLong(3));
                out.put(row);
            }
        } catch (JSONException ignored) {}
        return out.toString();
    }

    synchronized void deleteSession(String sessionId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.delete("messages", "session_id=?", new String[]{sessionId});
            db.delete("chats", "session_id=?", new String[]{sessionId});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }
}
