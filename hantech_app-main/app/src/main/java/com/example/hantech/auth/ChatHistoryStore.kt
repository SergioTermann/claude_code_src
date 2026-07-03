package com.example.hantech.auth

import android.content.Context
import com.example.hantech.ui.reflow.ChatMessage
import org.json.JSONArray
import org.json.JSONObject

object ChatHistoryStore {
    private const val PREFS_NAME = "hantech_chat_history"

    fun load(context: Context, username: String): List<ChatMessage> {
        val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(username, null)
            ?: return emptyList()

        return runCatching {
            val array = JSONArray(raw)
            List(array.length()) { index ->
                val item = array.getJSONObject(index)
                ChatMessage(
                    content = item.getString("content"),
                    isUser = item.getBoolean("isUser"),
                    timestamp = item.getLong("timestamp"),
                    attachmentName = item.optString("attachmentName"),
                    attachmentPath = item.optString("attachmentPath")
                )
            }
        }.getOrDefault(emptyList())
    }

    fun save(context: Context, username: String, messages: List<ChatMessage>) {
        val array = JSONArray()
        messages.forEach { message ->
            array.put(
                JSONObject()
                    .put("content", message.content)
                    .put("isUser", message.isUser)
                    .put("timestamp", message.timestamp)
                    .put("attachmentName", message.attachmentName)
                    .put("attachmentPath", message.attachmentPath)
            )
        }

        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(username, array.toString())
            .apply()
    }

    fun clear(context: Context, username: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(username)
            .apply()
    }
}
