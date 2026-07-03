package com.example.hantech.auth

import android.content.Context
import com.example.hantech.ui.reflow.ChatMessage
import org.json.JSONArray
import org.json.JSONObject

object CoworkerChatStore {
    private const val PREFS_NAME = "hantech_coworker_chats"

    fun load(context: Context, username: String, coworkerId: String): List<ChatMessage> {
        val raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(key(username, coworkerId), null)
            ?: return defaultMessages(coworkerId)

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
        }.getOrDefault(defaultMessages(coworkerId))
    }

    fun save(context: Context, username: String, coworkerId: String, messages: List<ChatMessage>) {
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
            .putString(key(username, coworkerId), array.toString())
            .apply()
    }

    fun append(context: Context, username: String, coworkerId: String, message: ChatMessage) {
        save(context, username, coworkerId, load(context, username, coworkerId) + message)
    }

    private fun key(username: String, coworkerId: String): String {
        return "$username::$coworkerId"
    }

    private fun defaultMessages(coworkerId: String): List<ChatMessage> {
        val name = CoworkerDirectory.items.firstOrNull { it.id == coworkerId }?.name ?: "工友"
        return listOf(ChatMessage(content = "$name：我在线，有现场问题可以直接发我。", isUser = false))
    }
}

object CoworkerDirectory {
    val items = listOf(
        Coworker("li_wei", "李伟", "电气专责", "变桨/变流", "先看 24V 供电和驱动器状态", "09:42", 2),
        Coworker("zhang_qiang", "张强", "机械专责", "齿轮箱/偏航", "齿轮箱振动趋势我看一下", "昨天", 0),
        Coworker("wang_min", "王敏", "值班长", "派工协调", "今晚二班可以接这个工单", "周二", 1),
        Coworker("chen_yu", "陈宇", "数据工程师", "SCADA/CMS", "SCADA 曲线已经导出来了", "周一", 0)
    )
}

data class Coworker(
    val id: String,
    val name: String,
    val role: String,
    val scope: String,
    val lastMessage: String,
    val time: String,
    val unreadCount: Int
)
