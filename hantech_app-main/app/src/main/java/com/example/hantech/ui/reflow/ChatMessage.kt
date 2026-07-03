package com.example.hantech.ui.reflow

/**
 * 聊天消息数据类
 * @param content 消息内容
 * @param isUser true 表示用户消息，false 表示 AI 消息
 * @param timestamp 消息时间戳
 */
data class ChatMessage(
    val content: String,
    val isUser: Boolean,
    val timestamp: Long = System.currentTimeMillis(),
    val attachmentName: String = "",
    val attachmentPath: String = ""
)
