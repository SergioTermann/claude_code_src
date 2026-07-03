package com.example.hantech.ui.reflow

import android.content.Context
import com.example.hantech.auth.WindriseApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

class WindriseClient {

    suspend fun ask(context: Context, message: String, conversationId: String = ""): WindriseReply = withContext(Dispatchers.IO) {
        val payload = JSONObject()
            .put("message", message)
            .put("query", message)
            .put("windrise_mode", "auto")
            .put("response_mode", "blocking")
            .put("conversation_id", conversationId)

        val response = WindriseApi.postApi(context, "/api/chat", payload)
        val json = JSONObject(response.body)
        return WindriseReply(
            answer = json.optString("answer", json.optString("message", json.optString("text", ""))).trim(),
            conversationId = json.optString("conversation_id", conversationId).trim(),
        )
    }
}

data class WindriseReply(
    val answer: String,
    val conversationId: String,
)
